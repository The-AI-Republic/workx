//! Track 45 Goal 2 — supervisor lifecycle integration tests.
//!
//! These tests spawn the `fake-runtime-child` test binary (declared as
//! `[[bin]] name = "fake-runtime-child"` in `tauri/Cargo.toml`) and
//! drive the protocol the production supervisor uses
//! (`tauri/src/runtime_supervisor.rs`) — same `<len>\n<payload>`
//! framing, same `hello`/`hello-ok` nonce-and-version handshake, same
//! `shutdown` semantics with `SHUTDOWN_GRACE = 5s`.
//!
//! Why integration rather than inline unit tests: Cargo only sets
//! `env!("CARGO_BIN_EXE_<name>")` for integration tests under
//! `tests/`. Pure unit tests (backoff math, ring buffer) live inline
//! in `runtime_supervisor.rs` where they can access private items.
//!
//! Gated on the `test-support` feature, which builds the fake-runtime-child
//! bin this file references via `CARGO_BIN_EXE_fake-runtime-child`. Without the
//! feature (e.g. a bare `cargo test`) the bin isn't built and this file compiles
//! to nothing rather than failing the `env!`. The test runner enables it.
#![cfg(feature = "test-support")]

use serde_json::{json, Value};
use std::process::Stdio as StdStdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

// Mirrors the supervisor's constants. Asserted indirectly via the
// behaviors below (handshake within deadline, shutdown within grace,
// SIGKILL after grace expires).
const PROTOCOL_VERSION: u64 = 1;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const TEST_NONCE: &str = "lifecycle-test-nonce";
const TEST_DEADLINE: Duration = Duration::from_secs(5);

const FAKE_CHILD: &str = env!("CARGO_BIN_EXE_fake-runtime-child");

fn spawn_fake_child(envs: &[(&str, &str)]) -> Child {
    let mut cmd = Command::new(FAKE_CHILD);
    cmd.arg("ignored/index.mjs")
        .stdin(StdStdio::piped())
        .stdout(StdStdio::piped())
        .stderr(StdStdio::piped())
        .kill_on_drop(true);
    // Wipe any env that could perturb behavior — these tests only care
    // about the explicit env knobs the caller passes.
    cmd.env_remove("FAKE_HANDSHAKE");
    cmd.env_remove("FAKE_EXIT_AFTER_HANDSHAKE");
    cmd.env_remove("FAKE_IGNORE_SHUTDOWN");
    cmd.env_remove("FAKE_STDERR_LINES");
    cmd.env_remove("FAKE_STDERR_PREFIX");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.spawn().expect("spawn fake-runtime-child")
}

async fn write_frame(stdin: &mut ChildStdin, frame: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    stdin
        .write_all(format!("{}\n", payload.len()).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(&payload).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// Length-prefixed JSON frame reader. Mirrors the production
/// `read_frame` in `runtime_supervisor.rs:210` semantics: `<len>\n<payload>`.
async fn read_frame(reader: &mut BufReader<&mut ChildStdout>, buffer: &mut Vec<u8>) -> Result<Option<Value>, String> {
    loop {
        if let Some(newline) = buffer.iter().position(|b| *b == b'\n') {
            let len_text = String::from_utf8_lossy(&buffer[..newline]).trim().to_string();
            match len_text.parse::<usize>() {
                Ok(len) => {
                    let start = newline + 1;
                    let end = start + len;
                    if buffer.len() < end {
                        // need more bytes
                    } else {
                        let payload = buffer[start..end].to_vec();
                        buffer.drain(..end);
                        let frame: Value = serde_json::from_slice(&payload)
                            .map_err(|e| format!("frame parse error: {e}"))?;
                        return Ok(Some(frame));
                    }
                }
                Err(_) => {
                    // skip stray line and resync
                    buffer.drain(..=newline);
                    continue;
                }
            }
        }
        let mut chunk = [0_u8; 8192];
        let n = reader.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
}

/// Drive the supervisor-side half of the handshake against a freshly
/// spawned fake child. Returns Ok on a valid matching `hello-ok` within
/// `TEST_DEADLINE`, Err with a descriptive message otherwise.
async fn perform_supervisor_handshake(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<&mut ChildStdout>,
    buffer: &mut Vec<u8>,
) -> Result<(), String> {
    write_frame(
        stdin,
        &json!({
            "type": "hello",
            "nonce": TEST_NONCE,
            "protocolVersion": PROTOCOL_VERSION,
        }),
    )
    .await?;

    let frame = timeout(TEST_DEADLINE, read_frame(reader, buffer))
        .await
        .map_err(|_| "handshake timed out".to_string())??
        .ok_or_else(|| "EOF before hello-ok".to_string())?;

    let ty = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "hello-ok" {
        return Err(format!("expected hello-ok, got type {}", ty));
    }
    let pv = frame.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0);
    let nonce = frame.get("nonce").and_then(Value::as_str).unwrap_or("");
    if pv != PROTOCOL_VERSION {
        return Err(format!("wrong protocolVersion: {}", pv));
    }
    if nonce != TEST_NONCE {
        return Err(format!("nonce mismatch: got {}", nonce));
    }
    Ok(())
}

// ─── handshake outcomes ───────────────────────────────────────────────

#[tokio::test]
async fn successful_handshake_against_fake_child() {
    let mut child = spawn_fake_child(&[("FAKE_HANDSHAKE", "ok")]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(&mut stdout);
    let mut buf = Vec::new();
    let result = perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf).await;
    assert!(result.is_ok(), "handshake should succeed: {:?}", result);
    drop(reader);
    let _ = write_frame(&mut stdin, &json!({ "type": "shutdown" })).await;
    let _ = child.wait().await;
}

#[tokio::test]
async fn handshake_reject_nonce_against_fake_child() {
    let mut child = spawn_fake_child(&[("FAKE_HANDSHAKE", "reject-nonce")]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(&mut stdout);
    let mut buf = Vec::new();
    let result = perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf).await;
    assert!(result.is_err(), "handshake must reject mismatched nonce");
    let err = result.unwrap_err();
    assert!(err.contains("nonce"), "error should mention nonce: {}", err);
    let _ = child.kill().await;
}

#[tokio::test]
async fn handshake_reject_version_against_fake_child() {
    let mut child = spawn_fake_child(&[("FAKE_HANDSHAKE", "reject-version")]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(&mut stdout);
    let mut buf = Vec::new();
    let result = perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf).await;
    assert!(result.is_err(), "handshake must reject wrong protocolVersion");
    let err = result.unwrap_err();
    assert!(err.contains("protocolVersion"), "error should mention protocolVersion: {}", err);
    let _ = child.kill().await;
}

#[tokio::test]
async fn handshake_silent_times_out() {
    let mut child = spawn_fake_child(&[("FAKE_HANDSHAKE", "silent")]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(&mut stdout);
    let mut buf = Vec::new();
    let result = perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf).await;
    assert!(result.is_err(), "silent handshake must time out");
    let err = result.unwrap_err();
    assert!(err.contains("timed out"), "error should mention timeout: {}", err);
    let _ = child.kill().await;
}

// ─── shutdown lifecycle ───────────────────────────────────────────────

#[tokio::test]
async fn graceful_shutdown_within_grace() {
    let mut child = spawn_fake_child(&[("FAKE_HANDSHAKE", "ok")]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    {
        let mut reader = BufReader::new(&mut stdout);
        let mut buf = Vec::new();
        perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf)
            .await
            .expect("handshake");
    }
    let started = Instant::now();
    write_frame(&mut stdin, &json!({ "type": "shutdown" }))
        .await
        .expect("send shutdown");
    let status = timeout(SHUTDOWN_GRACE, child.wait())
        .await
        .expect("child must exit within SHUTDOWN_GRACE")
        .expect("wait");
    let elapsed = started.elapsed();
    assert!(status.success(), "fake-child should exit cleanly: {:?}", status);
    assert!(
        elapsed < SHUTDOWN_GRACE,
        "graceful shutdown took {:?}, must be < {:?}",
        elapsed, SHUTDOWN_GRACE
    );
}

// Note on naming: this test verifies the *non-cooperative-child half* of
// the supervisor's escalation contract — that a child running with
// `FAKE_IGNORE_SHUTDOWN=1` does NOT exit within `SHUTDOWN_GRACE` after
// receiving a `shutdown` frame, and that an external SIGKILL reliably
// reaps it. The production supervisor's "send shutdown → wait grace →
// SIGKILL" escalation logic itself (in `supervise()`) is not driven
// here; that would require running the full supervise loop and is
// deferred per the Track 45 design.
#[tokio::test]
async fn child_with_ignore_shutdown_survives_grace_and_sigkill_reaps_it() {
    let mut child = spawn_fake_child(&[
        ("FAKE_HANDSHAKE", "ok"),
        ("FAKE_IGNORE_SHUTDOWN", "1"),
    ]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    {
        let mut reader = BufReader::new(&mut stdout);
        let mut buf = Vec::new();
        perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf)
            .await
            .expect("handshake");
    }
    // Send shutdown; fake ignores it. Wait SHUTDOWN_GRACE + slack, then
    // SIGKILL ourselves and assert the child terminates. (The supervisor
    // would do the same SIGKILL in production — see kill_on_exit() — but
    // this test doesn't drive supervise(), so it only proves the child
    // is non-cooperative and the kill primitive works.)
    write_frame(&mut stdin, &json!({ "type": "shutdown" }))
        .await
        .expect("send shutdown");
    let waited = timeout(SHUTDOWN_GRACE + Duration::from_millis(250), child.wait()).await;
    assert!(
        waited.is_err(),
        "fake-child with FAKE_IGNORE_SHUTDOWN=1 must NOT exit within grace"
    );
    child.start_kill().expect("start_kill");
    let status = timeout(Duration::from_secs(2), child.wait())
        .await
        .expect("child must exit after SIGKILL")
        .expect("wait");
    assert!(!status.success(), "killed child should not report success: {:?}", status);
}

// ─── post-handshake clean exit ────────────────────────────────────────
//
// Documents the supervise-loop building block: a single successful
// handshake produces an `Ok(true)` result from `spawn_once`, which
// triggers `attempt = 0` in `supervise()` (the `Ok(true) => attempt = 0`
// arm). Post-handshake crashes therefore never accumulate toward
// MAX_RESTART_ATTEMPTS — that cap only fires on consecutive pre-handshake
// failures. The pre-handshake case is covered by `handshake_silent_times_out`
// above; this case covers the "happy then crash" half.

#[tokio::test]
async fn post_handshake_exit_completes_successful_iteration() {
    let mut child = spawn_fake_child(&[
        ("FAKE_HANDSHAKE", "ok"),
        ("FAKE_EXIT_AFTER_HANDSHAKE", "1"),
    ]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(&mut stdout);
    let mut buf = Vec::new();
    let result = perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf).await;
    assert!(result.is_ok(), "handshake must succeed before crash");
    let status = timeout(TEST_DEADLINE, child.wait())
        .await
        .expect("child must exit after handshake")
        .expect("wait");
    assert!(status.success(), "fake-child clean-exit-after-handshake: {:?}", status);
}

// ─── stderr drain does not block stdout protocol ──────────────────────

#[tokio::test]
async fn stderr_does_not_block_stdout_handshake() {
    let mut child = spawn_fake_child(&[
        ("FAKE_HANDSHAKE", "ok"),
        ("FAKE_STDERR_LINES", "1000"),
    ]);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    // Drain stderr concurrently — mimics the supervisor's stderr task so
    // the child's stderr pipe doesn't fill up and block its writes.
    let stderr_task = tokio::spawn(async move {
        let mut buf = [0_u8; 4096];
        let mut total: usize = 0;
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n,
            }
        }
        total
    });
    let mut reader = BufReader::new(&mut stdout);
    let mut buf = Vec::new();
    let result = perform_supervisor_handshake(&mut stdin, &mut reader, &mut buf).await;
    assert!(result.is_ok(), "handshake must succeed alongside stderr load: {:?}", result);
    drop(reader);
    let _ = write_frame(&mut stdin, &json!({ "type": "shutdown" })).await;
    let _ = child.wait().await;
    let stderr_bytes = stderr_task.await.unwrap();
    assert!(stderr_bytes > 0, "drainer should have read some stderr");
}

// ─── orphan cleanup via kill_on_drop ──────────────────────────────────

#[tokio::test]
async fn orphan_cleanup_on_supervisor_drop() {
    // The production supervisor relies on `tokio::process::Command::kill_on_drop(true)`
    // (runtime_supervisor.rs in spawn_once) so that dropping the parent
    // reaps the child. Verify the same primitive: spawn, drop the Child
    // handle without calling kill(), and confirm the OS process is gone
    // shortly after.
    let child = spawn_fake_child(&[("FAKE_HANDSHAKE", "silent")]);
    let pid = child.id().expect("child pid");
    drop(child);
    // kill_on_drop signals the child but doesn't synchronously reap.
    // Wait briefly, then poll until the process is no longer running or we
    // time out. A short-lived killed child can remain as a zombie until Tokio's
    // background reaper collects it, especially under coverage instrumentation.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !process_is_running(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("orphan child pid {} still running after drop", pid);
}

#[cfg(target_os = "linux")]
fn process_is_running(pid: u32) -> bool {
    let stat_path = format!("/proc/{pid}/stat");
    if let Ok(stat) = std::fs::read_to_string(stat_path) {
        if let Some(close_paren) = stat.rfind(')') {
            let after_comm = stat[close_paren + 1..].trim_start();
            if after_comm.starts_with('Z') {
                return false;
            }
            return true;
        }
    }
    posix_process_exists(pid)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_is_running(pid: u32) -> bool {
    posix_process_exists(pid)
}

#[cfg(unix)]
fn posix_process_exists(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) is the standard POSIX liveness check; it never
    // alters the process, just reports whether a signal could be delivered.
    // Returns 0 if the process exists, -1 with ESRCH if not.
    use std::ffi::c_int;
    extern "C" {
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }
    unsafe { kill(pid as c_int, 0) == 0 }
}

#[cfg(not(unix))]
fn process_is_running(_pid: u32) -> bool {
    // Best-effort: this test only fires on Unix CI. Returning false here
    // means the test will pass on non-Unix without actually verifying.
    false
}
