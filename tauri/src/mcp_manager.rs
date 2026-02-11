//! MCP Manager - Rust-side MCP session management using rmcp SDK
//!
//! Handles stdio-based MCP server lifecycle:
//! - Spawning subprocess via rmcp TokioChildProcess
//! - Full MCP protocol handshake
//! - Tool listing and execution
//! - Resource listing and reading
//! - Session cleanup
//!
//! JS side calls these via Tauri invoke() through RustMCPBridge.

use rmcp::{
    model::{
        CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation,
        ReadResourceRequestParams, ResourceContents,
    },
    transport::TokioChildProcess,
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::Mutex;

lazy_static::lazy_static! {
    static ref MCP_SESSIONS: Mutex<HashMap<String, McpSession>> = Mutex::new(HashMap::new());
}

/// A live MCP session with a subprocess server.
///
/// The `client` field is type-erased to avoid leaking rmcp generics.
/// We store it as `Box<dyn Any + Send>` and downcast when needed.
struct McpSession {
    /// The running rmcp client service. We use a type-erased box because
    /// `RunningService<RoleClient, ClientInfo>` is a concrete but complex type.
    client: Box<dyn std::any::Any + Send>,
    server_info: Option<McpServerInfo>,
    capabilities: Option<McpCapabilitiesResult>,
    protocol_version: Option<String>,
}

/// Concrete type alias for the running service we actually store.
type ConcreteRunningService =
    rmcp::service::RunningService<rmcp::RoleClient, ClientInfo>;

// =============================================================================
// Result Types (serialized to JS)
// =============================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpCapabilitiesResult {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpConnectResult {
    pub success: bool,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub protocol_version: Option<String>,
    pub capabilities: Option<McpCapabilitiesResult>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpToolDef {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpContentBlock {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
    pub data: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpToolResult {
    pub content: Vec<McpContentBlock>,
    pub is_error: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpResourceDef {
    pub uri: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpResourceContent {
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    pub text: Option<String>,
    pub blob: Option<String>,
}

// =============================================================================
// Helper to downcast session client
// =============================================================================

fn get_client(session: &McpSession) -> Result<&ConcreteRunningService, String> {
    session
        .client
        .downcast_ref::<ConcreteRunningService>()
        .ok_or_else(|| "Internal error: failed to downcast MCP client".to_string())
}

// =============================================================================
// Tauri Commands
// =============================================================================

#[tauri::command]
pub async fn mcp_connect(
    server_id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
) -> Result<McpConnectResult, String> {
    println!(
        "[mcp_manager] Connecting: {} {:?} (server_id: {})",
        command, args, server_id
    );

    // Check if already connected
    {
        let sessions = MCP_SESSIONS.lock().await;
        if sessions.contains_key(&server_id) {
            return Ok(McpConnectResult {
                success: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                capabilities: None,
                error: Some(format!("Server {} is already connected", server_id)),
            });
        }
    }

    // Build the subprocess command
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args);

    // Set environment variables if provided
    if let Some(env_vars) = &env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    // Set working directory if provided
    if let Some(working_dir) = &cwd {
        cmd.current_dir(working_dir);
    }

    // Spawn the child process via rmcp's TokioChildProcess transport
    let child_process = match TokioChildProcess::new(cmd) {
        Ok(cp) => cp,
        Err(e) => {
            eprintln!("[mcp_manager] Failed to spawn process: {}", e);
            return Ok(McpConnectResult {
                success: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                capabilities: None,
                error: Some(format!("Failed to spawn process: {}", e)),
            });
        }
    };

    // Create MCP client info and perform handshake via .serve()
    let client_info = ClientInfo {
        meta: None,
        protocol_version: Default::default(),
        capabilities: ClientCapabilities::default(),
        client_info: Implementation {
            name: "browserx-desktop".to_string(),
            version: "1.0.0".to_string(),
            title: None,
            description: None,
            icons: None,
            website_url: None,
        },
    };

    let client = match client_info.serve(child_process).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[mcp_manager] MCP handshake failed: {}", e);
            return Ok(McpConnectResult {
                success: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                capabilities: None,
                error: Some(format!("MCP handshake failed: {}", e)),
            });
        }
    };

    // Extract server info from the peer (the connected server)
    let (server_info, capabilities, protocol_version) = if let Some(peer) = client.peer_info() {
        let si = McpServerInfo {
            name: peer.server_info.name.clone(),
            version: peer.server_info.version.clone(),
        };
        let caps = McpCapabilitiesResult {
            tools: peer.capabilities.tools.is_some(),
            resources: peer.capabilities.resources.is_some(),
            prompts: peer.capabilities.prompts.is_some(),
        };
        let pv = peer.protocol_version.to_string();
        (Some(si), Some(caps), Some(pv))
    } else {
        (None, None, None)
    };

    let result = McpConnectResult {
        success: true,
        server_name: server_info.as_ref().map(|s| s.name.clone()),
        server_version: server_info.as_ref().map(|s| s.version.clone()),
        protocol_version: protocol_version.clone(),
        capabilities: capabilities.clone(),
        error: None,
    };

    // Store session
    let session = McpSession {
        client: Box::new(client),
        server_info,
        capabilities,
        protocol_version,
    };

    {
        let mut sessions = MCP_SESSIONS.lock().await;
        sessions.insert(server_id.clone(), session);
    }

    println!(
        "[mcp_manager] Connected successfully (server_id: {})",
        server_id
    );

    Ok(result)
}

#[tauri::command]
pub async fn mcp_list_tools(server_id: String) -> Result<Vec<McpToolDef>, String> {
    let sessions = MCP_SESSIONS.lock().await;

    let session = sessions
        .get(&server_id)
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    let client = get_client(session)?;

    let result = client
        .list_all_tools()
        .await
        .map_err(|e| format!("Failed to list tools: {}", e))?;

    let tools: Vec<McpToolDef> = result
        .into_iter()
        .map(|tool| McpToolDef {
            name: tool.name.to_string(),
            description: tool.description.map(|d| d.to_string()),
            input_schema: serde_json::to_value(&tool.input_schema)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
        })
        .collect();

    println!(
        "[mcp_manager] Listed {} tools (server_id: {})",
        tools.len(),
        server_id
    );

    Ok(tools)
}

#[tauri::command]
pub async fn mcp_call_tool(
    server_id: String,
    tool_name: String,
    arguments: serde_json::Value,
    _timeout_ms: Option<u64>,
) -> Result<McpToolResult, String> {
    println!(
        "[mcp_manager] Calling tool: {} (server_id: {})",
        tool_name, server_id
    );

    let sessions = MCP_SESSIONS.lock().await;

    let session = sessions
        .get(&server_id)
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    let client = get_client(session)?;

    let args_map = match arguments {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    let call_result = client
        .call_tool(CallToolRequestParams {
            meta: None,
            name: tool_name.clone().into(),
            arguments: Some(args_map),
            task: None,
        })
        .await
        .map_err(|e| format!("Tool call failed: {}", e))?;

    // Content is Vec<Content> where Content = Annotated<RawContent>
    // Access .raw to get the RawContent enum variant
    let content: Vec<McpContentBlock> = call_result
        .content
        .into_iter()
        .map(|c| {
            use rmcp::model::RawContent;
            match c.raw {
                RawContent::Text(text_content) => McpContentBlock {
                    content_type: "text".to_string(),
                    text: Some(text_content.text.clone()),
                    data: None,
                    mime_type: None,
                },
                RawContent::Image(image_content) => McpContentBlock {
                    content_type: "image".to_string(),
                    text: None,
                    data: Some(image_content.data.clone()),
                    mime_type: Some(image_content.mime_type.clone()),
                },
                RawContent::Audio(audio_content) => McpContentBlock {
                    content_type: "audio".to_string(),
                    text: None,
                    data: Some(audio_content.data.clone()),
                    mime_type: Some(audio_content.mime_type.clone()),
                },
                _ => McpContentBlock {
                    content_type: "text".to_string(),
                    text: Some("[Unsupported content type]".to_string()),
                    data: None,
                    mime_type: None,
                },
            }
        })
        .collect();

    let is_error = call_result.is_error;

    println!(
        "[mcp_manager] Tool {} result: is_error={}, blocks={} (server_id: {})",
        tool_name,
        is_error,
        content.len(),
        server_id
    );

    Ok(McpToolResult { content, is_error })
}

#[tauri::command]
pub async fn mcp_list_resources(server_id: String) -> Result<Vec<McpResourceDef>, String> {
    let sessions = MCP_SESSIONS.lock().await;

    let session = sessions
        .get(&server_id)
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    // Check if server supports resources
    if let Some(ref caps) = session.capabilities {
        if !caps.resources {
            return Ok(vec![]);
        }
    }

    let client = get_client(session)?;

    let result = client
        .list_all_resources()
        .await
        .map_err(|e| format!("Failed to list resources: {}", e))?;

    let resources: Vec<McpResourceDef> = result
        .into_iter()
        .map(|r| McpResourceDef {
            uri: r.uri.to_string(),
            name: r.name.clone(),
            description: r.description.clone(),
            mime_type: r.mime_type.clone(),
        })
        .collect();

    Ok(resources)
}

#[tauri::command]
pub async fn mcp_read_resource(
    server_id: String,
    uri: String,
) -> Result<McpResourceContent, String> {
    let sessions = MCP_SESSIONS.lock().await;

    let session = sessions
        .get(&server_id)
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    let client = get_client(session)?;

    let result = client
        .read_resource(ReadResourceRequestParams {
            meta: None,
            uri: uri.clone(),
        })
        .await
        .map_err(|e| format!("Failed to read resource: {}", e))?;

    let content = result
        .contents
        .into_iter()
        .next()
        .ok_or_else(|| "No content returned".to_string())?;

    // ResourceContents is an enum: TextResourceContents or BlobResourceContents
    match content {
        ResourceContents::TextResourceContents {
            uri,
            mime_type,
            text,
            ..
        } => Ok(McpResourceContent {
            uri,
            mime_type,
            text: Some(text),
            blob: None,
        }),
        ResourceContents::BlobResourceContents {
            uri,
            mime_type,
            blob,
            ..
        } => Ok(McpResourceContent {
            uri,
            mime_type,
            text: None,
            blob: Some(blob),
        }),
    }
}

#[tauri::command]
pub async fn mcp_disconnect(server_id: String) -> Result<bool, String> {
    println!("[mcp_manager] Disconnecting server_id: {}", server_id);

    let mut sessions = MCP_SESSIONS.lock().await;

    if let Some(session) = sessions.remove(&server_id) {
        // The RunningService will be dropped, which cancels the client
        // and kills the subprocess
        drop(session);
        println!("[mcp_manager] Disconnected server_id: {}", server_id);
        Ok(true)
    } else {
        Err(format!("Server not found: {}", server_id))
    }
}
