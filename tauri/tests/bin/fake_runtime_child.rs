//! Test-only fake desktop-runtime child for Track 45 supervisor lifecycle
//! tests. Mimics the real runtime's stdio protocol surface with
//! configurable failure modes driven by env vars. Wired into supervisor
//! tests via `APPLEPI_NODE_BIN=env!(CARGO_BIN_EXE_fake-runtime-child)`,
//! which makes the supervisor invoke this binary in place of `node`.
//! The first arg (the entry path `index.mjs` the supervisor passes
//! after the node binary) is read but ignored.
//!
//! Env knobs (read once at startup, then immutable for the process):
//!
//! - `FAKE_HANDSHAKE = "ok" | "reject-nonce" | "reject-version" | "silent"`
//!     - "ok"             — reply to `hello` with matching nonce + version
//!     - "reject-nonce"   — reply with a different nonce
//!     - "reject-version" — reply with a wrong protocolVersion
//!     - "silent"         — never reply to `hello` (supervisor times out)
//! - `FAKE_EXIT_AFTER_HANDSHAKE = "1"` — exit cleanly immediately after
//!     replying to `hello`. Useful for "post-handshake crash" tests where
//!     the supervisor must respawn and reset the attempt counter.
//! - `FAKE_IGNORE_SHUTDOWN = "1"` — accept the `shutdown` frame but never
//!     exit. The supervisor must SIGKILL after `SHUTDOWN_GRACE`.
//! - `FAKE_STDERR_LINES = <N>` — emit N newline-terminated lines on
//!     stderr at startup. Used to exercise the ring-buffer drain
//!     (`diagnostics.recentStderr`).
//! - `FAKE_STDERR_PREFIX = "<s>"` — optional prefix for stderr lines so
//!     tests can verify per-line content (defaults to "stderr").

use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::exit;

const PROTOCOL_VERSION: u64 = 1;

#[derive(Clone, Copy)]
enum HandshakeMode {
    Ok,
    RejectNonce,
    RejectVersion,
    Silent,
}

fn handshake_mode() -> HandshakeMode {
    match env::var("FAKE_HANDSHAKE").as_deref().unwrap_or("ok") {
        "reject-nonce" => HandshakeMode::RejectNonce,
        "reject-version" => HandshakeMode::RejectVersion,
        "silent" => HandshakeMode::Silent,
        _ => HandshakeMode::Ok,
    }
}

fn write_frame<W: Write>(writer: &mut W, frame: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(frame)?;
    writer.write_all(format!("{}\n", payload.len()).as_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

/// Read one length-prefixed JSON frame from stdin. Returns `Ok(None)` on
/// clean EOF only. A malformed length header or JSON parse failure is
/// surfaced as `Err` so the fake child exits with code 2 — a test that
/// passes garbage to the fake should fail loudly, not silently pass
/// because the fake mistook the error for EOF. Matches the supervisor's
/// `<len>\n<payload>` framing (`tauri/src/runtime_supervisor.rs:190`).
fn read_frame<R: Read>(reader: &mut BufReader<R>) -> io::Result<Option<Value>> {
    let mut len_line = String::new();
    let n = reader.read_line(&mut len_line)?;
    if n == 0 {
        return Ok(None);
    }
    let trimmed = len_line.trim();
    let len: usize = trimmed.parse().map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("malformed frame length header {:?}: {}", trimmed, e),
        )
    })?;
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload)?;
    let frame: Value = serde_json::from_slice(&payload)?;
    Ok(Some(frame))
}

fn emit_startup_stderr() {
    let count: usize = env::var("FAKE_STDERR_LINES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if count == 0 {
        return;
    }
    let prefix = env::var("FAKE_STDERR_PREFIX").unwrap_or_else(|_| "stderr".to_string());
    let stderr = io::stderr();
    let mut handle = stderr.lock();
    for i in 0..count {
        let _ = writeln!(handle, "{prefix} {i}");
    }
    let _ = handle.flush();
}

fn main() {
    // First arg is the entry path the supervisor passes (e.g. `index.mjs`);
    // intentionally ignored for the fake child.
    let _ignored_entry = env::args().nth(1);

    let mode = handshake_mode();
    let exit_after_handshake = env::var("FAKE_EXIT_AFTER_HANDSHAKE").as_deref() == Ok("1");
    let ignore_shutdown = env::var("FAKE_IGNORE_SHUTDOWN").as_deref() == Ok("1");

    emit_startup_stderr();

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(f)) => f,
            Ok(None) => exit(0),
            Err(_) => exit(2),
        };
        let ty = frame.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        match ty.as_str() {
            "hello" => {
                let nonce = frame.get("nonce").and_then(Value::as_str).unwrap_or("").to_string();
                match mode {
                    HandshakeMode::Ok => {
                        let _ = write_frame(
                            &mut writer,
                            &json!({
                                "type": "hello-ok",
                                "nonce": nonce,
                                "protocolVersion": PROTOCOL_VERSION,
                                "runtimeProfile": "desktop-runtime",
                                "pid": std::process::id(),
                            }),
                        );
                        if exit_after_handshake {
                            // Drop stdout so the supervisor sees EOF cleanly.
                            drop(writer);
                            exit(0);
                        }
                    }
                    HandshakeMode::RejectNonce => {
                        let _ = write_frame(
                            &mut writer,
                            &json!({
                                "type": "hello-ok",
                                "nonce": format!("not-{}", nonce),
                                "protocolVersion": PROTOCOL_VERSION,
                                "runtimeProfile": "desktop-runtime",
                                "pid": std::process::id(),
                            }),
                        );
                    }
                    HandshakeMode::RejectVersion => {
                        let _ = write_frame(
                            &mut writer,
                            &json!({
                                "type": "hello-ok",
                                "nonce": nonce,
                                "protocolVersion": PROTOCOL_VERSION + 99,
                                "runtimeProfile": "desktop-runtime",
                                "pid": std::process::id(),
                            }),
                        );
                    }
                    HandshakeMode::Silent => {
                        // intentionally no reply; supervisor will eventually
                        // give up or kill us.
                    }
                }
            }
            "ping" => {
                let id = frame.get("id").and_then(Value::as_str).map(|s| s.to_string());
                let _ = write_frame(
                    &mut writer,
                    &json!({
                        "type": "pong",
                        "id": id,
                        "ts": 0,
                    }),
                );
            }
            "shutdown" => {
                if ignore_shutdown {
                    // Keep running; supervisor must escalate to SIGKILL after
                    // SHUTDOWN_GRACE.
                    continue;
                }
                drop(writer);
                exit(0);
            }
            "request" => {
                // No agent stack here — ack the request as ok so the
                // supervisor's request/response plumbing stays sane for
                // any future test that drives one.
                let id = frame.get("id").and_then(Value::as_str).map(|s| s.to_string());
                let _ = write_frame(
                    &mut writer,
                    &json!({ "type": "response", "id": id, "ok": true }),
                );
            }
            _ => {
                // Ignore unknown frame types; the supervisor's read_frame
                // already skips well-framed unparseable payloads.
            }
        }
    }
}
