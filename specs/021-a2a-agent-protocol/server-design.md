# A2A Server Architecture Design (T024)

## Overview

The A2A server mode enables the local agent to accept incoming tasks from remote A2A agents, enabling bidirectional agent collaboration.

## Platform Considerations

### Chrome Extension (Primary Platform)
- **Limitation**: Service workers cannot run persistent HTTP servers
- **Approach**: Intercept `fetch` events for agent card requests at well-known path
- **Scope**: Agent card serving only; full JSON-RPC server requires external proxy
- **Agent Card URL**: `chrome-extension://<id>/.well-known/agent-card.json`

### Desktop (Tauri)
- **Approach**: Tauri HTTP plugin or bundled micro-server on configurable port
- **Default Port**: 3210 (configurable)
- **Agent Card URL**: `http://localhost:<port>/.well-known/agent-card.json`

## Components

### 1. AgentCard Generation (`A2AServer.ts`)
- Build `AgentCard` from local tool registry
- Name and description from extension/app config
- Skills derived from registered local tools
- Capabilities: `{ streaming: false, pushNotifications: false }` (initial)
- Protocol version: Match `@a2a-js/sdk` version

### 2. Request Handler (`A2AServer.ts`)
- Uses `@a2a-js/sdk/server` (if available) or custom JSON-RPC handler
- `InMemoryTaskStore` for task state management
- `AgentExecutor` interface routes to local tool execution
- Supported methods:
  - `message/send` → Route to local tool, return result
  - `tasks/get` → Return task status
  - `tasks/cancel` → Attempt cancellation

### 3. Server Lifecycle
- Start/stop via settings toggle
- Port selection with conflict detection (desktop)
- Status indicator in A2ASettings.svelte

## Security
- CORS headers for cross-origin access
- Optional auth token for incoming requests
- Rate limiting for DoS protection

## Status
**Priority**: P3 (Deferred)
Server mode requires more design work and is deferred until P1/P2 stories are stable.
The client-side A2A protocol (connecting TO remote agents) is the primary focus.
