//! OAuth callback server for ChatGPT OAuth flow.
//!
//! Starts a temporary TCP server on 127.0.0.1:1455 to receive the OAuth callback
//! from OpenAI's auth server. Accepts one GET /callback request, extracts the
//! `code` and `state` query parameters, responds with a success HTML page,
//! and shuts down.

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Result returned to the TypeScript frontend
#[derive(Serialize)]
pub struct OAuthCallbackResult {
    pub code: String,
    pub state: String,
}

/// Success HTML page shown to the user after the OAuth callback
const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html>
<head><title>BrowserX - Authentication Complete</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       display: flex; justify-content: center; align-items: center;
       min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0; }
.container { text-align: center; padding: 2rem; }
h1 { color: #4ade80; margin-bottom: 0.5rem; }
p { color: #a0a0b0; }
</style>
</head>
<body>
<div class="container">
  <h1>Authentication Successful</h1>
  <p>You can close this tab and return to BrowserX.</p>
</div>
</body>
</html>"#;

/// Start a temporary OAuth callback server on localhost:1455.
///
/// Binds a TCP listener, waits for a single GET /callback request,
/// extracts the authorization code and state, responds with a success page,
/// and returns the result. Times out after the specified number of seconds.
#[tauri::command]
pub async fn start_oauth_callback_server(
    timeout_secs: u64,
) -> Result<OAuthCallbackResult, String> {
    let listener = TcpListener::bind("127.0.0.1:1455")
        .await
        .map_err(|e| format!("Failed to bind port 1455: {}", e))?;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        accept_callback(&listener),
    )
    .await
    .map_err(|_| "OAuth callback timed out".to_string())?;

    result
}

/// Accept a single HTTP request and extract OAuth callback parameters.
async fn accept_callback(listener: &TcpListener) -> Result<OAuthCallbackResult, String> {
    let (mut stream, _addr) = listener
        .accept()
        .await
        .map_err(|e| format!("Failed to accept connection: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read request: {}", e))?;

    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse the request line to extract the path and query string
    let request_line = request.lines().next().unwrap_or("");
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("");

    // Extract query parameters from the path
    let query_string = path.split('?').nth(1).unwrap_or("");
    let params: std::collections::HashMap<&str, &str> = query_string
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            Some((parts.next()?, parts.next()?))
        })
        .collect();

    let code = params
        .get("code")
        .ok_or_else(|| "Missing 'code' parameter in callback".to_string())?
        .to_string();

    let state = params
        .get("state")
        .ok_or_else(|| "Missing 'state' parameter in callback".to_string())?
        .to_string();

    // Send success response
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        SUCCESS_HTML.len(),
        SUCCESS_HTML
    );

    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    Ok(OAuthCallbackResult { code, state })
}
