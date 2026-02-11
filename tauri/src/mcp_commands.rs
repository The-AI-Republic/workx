use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

lazy_static::lazy_static! {
    static ref MCP_SESSIONS: Mutex<HashMap<String, McpSession>> = Mutex::new(HashMap::new());
}

struct McpSession {
    process: Child,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct McpSpawnResult {
    pub session_id: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct McpMessage {
    pub session_id: String,
    pub message: String,
}

#[tauri::command]
pub async fn mcp_spawn(
    app: AppHandle,
    server: String,
    args: Vec<String>,
) -> Result<McpSpawnResult, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    println!("[mcp_spawn] Spawning: {} {:?} (session: {})", server, args, session_id);

    let mut cmd = Command::new(&server);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Drain stderr to prevent pipe buffer deadlock.
        // When stderr is piped but not read, the OS pipe buffer (~64KB)
        // fills up and the child process blocks on write, causing a deadlock.
        .stderr(Stdio::piped());

    match cmd.spawn() {
        Ok(mut child) => {
            // Spawn a thread to read stdout and emit events
            let stdout = child.stdout.take().expect("Failed to capture stdout");
            let sid = session_id.clone();
            let app_handle = app.clone();

            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(line) => {
                            println!("[mcp_spawn] stdout ({}): {}", sid, &line[..line.len().min(200)]);
                            let _ = app_handle.emit(
                                "mcp_message",
                                McpMessage {
                                    session_id: sid.clone(),
                                    message: line,
                                },
                            );
                        }
                        Err(e) => {
                            eprintln!("[mcp_spawn] stdout read error ({}): {}", sid, e);
                            break;
                        }
                    }
                }
                println!("[mcp_spawn] stdout reader thread exiting ({})", sid);
            });

            // Spawn a thread to drain stderr — CRITICAL to prevent deadlock.
            // Without this, the child blocks when stderr pipe buffer fills up.
            let stderr = child.stderr.take().expect("Failed to capture stderr");
            let sid_stderr = session_id.clone();

            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(line) => {
                            eprintln!("[mcp_spawn] stderr ({}): {}", sid_stderr, line);
                        }
                        Err(_) => break,
                    }
                }
            });

            let mut sessions = MCP_SESSIONS.lock().unwrap();
            sessions.insert(session_id.clone(), McpSession { process: child });

            println!("[mcp_spawn] Process spawned successfully (session: {})", session_id);

            Ok(McpSpawnResult {
                session_id,
                success: true,
                error: None,
            })
        }
        Err(e) => {
            eprintln!("[mcp_spawn] Failed to spawn: {}", e);
            Ok(McpSpawnResult {
                session_id: String::new(),
                success: false,
                error: Some(e.to_string()),
            })
        }
    }
}

#[tauri::command]
pub async fn mcp_send(session_id: String, message: String) -> Result<bool, String> {
    println!("[mcp_send] Sending to session {}: {}...", session_id, &message[..message.len().min(200)]);

    let mut sessions = MCP_SESSIONS.lock().unwrap();

    if let Some(session) = sessions.get_mut(&session_id) {
        if let Some(stdin) = session.process.stdin.as_mut() {
            if let Err(e) = writeln!(stdin, "{}", message) {
                eprintln!("[mcp_send] Write error: {}", e);
                return Err(format!("Failed to write to stdin: {}", e));
            }
            if let Err(e) = stdin.flush() {
                eprintln!("[mcp_send] Flush error: {}", e);
                return Err(format!("Failed to flush stdin: {}", e));
            }
            println!("[mcp_send] Message sent successfully");
            return Ok(true);
        }
        return Err(format!("Session {} has no stdin", session_id));
    }

    Err(format!("Session not found: {}", session_id))
}

#[tauri::command]
pub async fn mcp_close(session_id: String) -> Result<bool, String> {
    let mut sessions = MCP_SESSIONS.lock().unwrap();

    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.process.kill();
        Ok(true)
    } else {
        Err(format!("Session not found: {}", session_id))
    }
}
