//! HTTP Commands
//!
//! Proxies HTTP requests from the WebView through Rust to bypass CORS.
//! This is the desktop equivalent of Chrome extension's service worker fetch.

use std::collections::HashMap;
use serde::Serialize;
use tauri::ipc::Channel;

/// Events streamed back to TypeScript via Tauri Channel
#[derive(Clone, Serialize)]
#[serde(tag = "event")]
pub enum HttpEvent {
    /// Response headers received
    #[serde(rename = "headers")]
    Headers {
        status: u16,
        status_text: String,
        headers: HashMap<String, String>,
    },
    /// Response body chunk (base64 encoded)
    #[serde(rename = "chunk")]
    Chunk { data: String },
    /// Response complete
    #[serde(rename = "end")]
    End,
    /// Request error
    #[serde(rename = "error")]
    Error { message: String },
}

/// Make an HTTP request and stream the response back via Channel.
/// This bypasses WebView CORS restrictions.
#[tauri::command]
pub async fn http_fetch(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    on_event: Channel<HttpEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    // Build request
    let http_method: reqwest::Method = method
        .parse()
        .map_err(|_| format!("Invalid HTTP method: {}", method))?;

    let mut req = client.request(http_method, &url);

    for (key, value) in &headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if let Some(body) = body {
        req = req.body(body);
    }

    // Send request
    let mut response = match req.send().await {
        Ok(resp) => resp,
        Err(e) => {
            let _ = on_event.send(HttpEvent::Error {
                message: format!("Request failed: {}", e),
            });
            return Err(format!("Request failed: {}", e));
        }
    };

    // Send response headers
    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let resp_headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                v.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();

    on_event
        .send(HttpEvent::Headers {
            status,
            status_text,
            headers: resp_headers,
        })
        .map_err(|e| format!("Failed to send headers: {}", e))?;

    // Stream response body using chunk() (no extra dependencies needed)
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                use base64::{Engine, engine::general_purpose::STANDARD};
                let encoded = STANDARD.encode(&bytes);
                if on_event.send(HttpEvent::Chunk { data: encoded }).is_err() {
                    // Channel closed (frontend navigated away, etc.)
                    return Ok(());
                }
            }
            Ok(None) => break, // End of stream
            Err(e) => {
                let _ = on_event.send(HttpEvent::Error {
                    message: format!("Stream error: {}", e),
                });
                return Ok(());
            }
        }
    }

    let _ = on_event.send(HttpEvent::End);
    Ok(())
}
