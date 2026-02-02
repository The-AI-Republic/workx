# Quickstart: MCP Server Integration

**Feature**: 013-mcp-server-integration
**Date**: 2026-02-01

## Overview

This feature enables browserx to connect to MCP (Model Context Protocol) servers, extending the agent's capabilities with external tools.

## Prerequisites

- Node.js 20+
- npm 10+
- Chrome browser (for extension testing)

## Setup

### 1. Install Dependencies

```bash
npm install @modelcontextprotocol/sdk
```

### 2. Build the Extension

```bash
npm run build
```

### 3. Load Extension in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` directory

## Testing with a Local MCP Server

### Option A: Use the MCP Reference Server

```bash
# In a separate terminal, start a simple MCP server
npx @modelcontextprotocol/server-everything

# Server runs on http://localhost:3000
```

### Option B: Create a Minimal Test Server

Create `test-server.js`:

```javascript
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new Server(
  { name: 'test-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'echo',
    description: 'Echo back the input',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' }
      },
      required: ['message']
    }
  }]
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'echo') {
    return {
      content: [{ type: 'text', text: `Echo: ${request.params.arguments.message}` }]
    };
  }
  throw new Error('Unknown tool');
});

const transport = new StdioServerTransport();
server.connect(transport);
```

Run with an HTTP wrapper (MCP servers typically need an HTTP bridge for browser access).

## Configuration

### Adding an MCP Server

1. Open browserx sidepanel
2. Go to Settings
3. Scroll to "MCP Servers" section
4. Click "Add Server"
5. Enter:
   - **Name**: `test` (used as tool prefix)
   - **URL**: `http://localhost:3000`
   - **API Key**: (optional, if server requires auth)
6. Click "Save"
7. Click "Connect"

### Verifying Connection

After connecting, you should see:
- Status: "Connected"
- Tools list showing discovered tools (e.g., "test:echo")

## Using MCP Tools

Once connected, MCP tools are automatically available to the agent.

### Example Conversation

```
User: Please use the echo tool to say "Hello World"

Agent: I'll use the test:echo tool for that.
[Calls test:echo with message: "Hello World"]

The echo tool returned: "Echo: Hello World"
```

## File Structure

```
src/
├── mcp/
│   ├── MCPClient.ts          # Single server connection wrapper
│   ├── MCPManager.ts         # Multi-connection manager
│   ├── MCPToolAdapter.ts     # Tool definition converter
│   ├── MCPConfig.ts          # Config types and storage
│   └── transports/
│       └── SSEClientTransport.ts  # Browser transport
├── sidepanel/settings/
│   └── MCPSettings.svelte    # Settings UI component
```

## Key APIs

### MCPManager (Singleton)

```typescript
import { MCPManager } from './mcp/MCPManager';

// Get instance (initializes from storage)
const manager = await MCPManager.getInstance();

// Add a server
const config = await manager.addServer({
  name: 'github',
  url: 'https://mcp.github.example.com',
  apiKey: 'your-api-key',
  enabled: true
});

// Connect
await manager.connect(config.id);

// Get available tools
const tools = manager.getAllTools();
// [{ serverName: 'github', tool: { name: 'search', ... } }]

// Execute a tool
const result = await manager.executeTool('github:search', { query: 'react' });
```

### MCPToolAdapter

```typescript
import { MCPToolAdapter } from './mcp/MCPToolAdapter';

const adapter = new MCPToolAdapter();

// Convert MCP tool to ToolDefinition
const toolDef = adapter.adaptTool(mcpTool, 'github');
// { type: 'function', function: { name: 'github:search', ... } }

// Create handler for ToolRegistry
const handler = adapter.createHandler(manager, 'github', 'search');
```

## Troubleshooting

### Connection Fails

1. **Check server is running**: Verify the MCP server is accessible
2. **Check CORS**: Browser requires CORS headers from server
3. **Check URL**: Ensure URL is correct (include protocol)
4. **Check console**: Look for error messages in DevTools

### Tools Not Appearing

1. **Verify connection**: Check status is "Connected"
2. **Check server capabilities**: Server must advertise `tools` capability
3. **Refresh tools**: Disconnect and reconnect

### Tool Execution Fails

1. **Check arguments**: Verify arguments match schema
2. **Check timeout**: Increase timeout for slow operations
3. **Check server logs**: Look for errors on server side

## Running Tests

```bash
# Unit tests
npm test -- src/mcp/__tests__/

# Integration tests (requires mock server)
npm test -- tests/integration/mcp/

# All tests
npm test
```

## Debug Logging

Enable MCP debug logging in Settings:

1. Open Settings
2. Enable "MCP Debug Logging"
3. Check browser console for detailed logs

Or via code:

```typescript
chrome.storage.local.set({ mcpDebugLogging: true });
```

## Next Steps

- Read the [MCP Specification](https://modelcontextprotocol.io/)
- Explore available [MCP Servers](https://github.com/modelcontextprotocol/servers)
- Review the [Implementation Plan](./plan.md) for architecture details
