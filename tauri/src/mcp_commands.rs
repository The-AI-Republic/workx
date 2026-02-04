use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

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

    let mut cmd = Command::new(&server);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
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
                    if let Ok(line) = line {
                        let _ = app_handle.emit_all(
                            "mcp_message",
                            McpMessage {
                                session_id: sid.clone(),
                                message: line,
                            },
                        );
                    }
                }
            });

            let mut sessions = MCP_SESSIONS.lock().unwrap();
            sessions.insert(session_id.clone(), McpSession { process: child });

            Ok(McpSpawnResult {
                session_id,
                success: true,
                error: None,
            })
        }
        Err(e) => Ok(McpSpawnResult {
            session_id: String::new(),
            success: false,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn mcp_send(session_id: String, message: String) -> Result<bool, String> {
    let mut sessions = MCP_SESSIONS.lock().unwrap();

    if let Some(session) = sessions.get_mut(&session_id) {
        if let Some(stdin) = session.process.stdin.as_mut() {
            if let Err(e) = writeln!(stdin, "{}", message) {
                return Err(format!("Failed to write to stdin: {}", e));
            }
            return Ok(true);
        }
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
