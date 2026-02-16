# Quickstart: A2A Agent-to-Agent Protocol Integration

**Feature**: 021-a2a-agent-protocol

## Prerequisites

- Node.js >= 18
- npm
- Existing browserx development environment set up

## Setup

```bash
# Install A2A SDK dependency
npm install @a2a-js/sdk

# Verify installation
npm ls @a2a-js/sdk
```

## Project Structure

New files (mirroring `src/core/mcp/`):

```
src/core/a2a/
├── types.ts                    # Type definitions (IA2AAgentConfig, IA2AConnection, etc.)
├── A2AManager.ts               # Singleton manager (connection lifecycle, skill aggregation)
├── A2AClient.ts                # SDK wrapper (fetch + auth, streaming, error handling)
├── A2AConfig.ts                # Zod schemas, storage helpers, migration
├── A2AToolAdapter.ts           # Skill → ToolDefinition adaptation, risk assessor
└── __tests__/
    ├── A2AManager.test.ts
    ├── A2AClient.test.ts
    ├── A2AToolAdapter.test.ts
    └── A2AConfig.test.ts

src/sidepanel/settings/
└── A2ASettings.svelte          # Settings UI component

src/core/MessageRouter.ts       # Add A2A message types (A2A_GET_AGENTS, etc.)
src/extension/background/
└── service-worker.ts           # Add A2A message handlers, tool registration, auto-connect
```

## Development Workflow

### 1. Define Types (`src/core/a2a/types.ts`)

Start here — all other modules depend on these types.

### 2. Implement Config Layer (`src/core/a2a/A2AConfig.ts`)

Zod schemas for validation, storage load/save helpers. Test with unit tests.

### 3. Implement Client Wrapper (`src/core/a2a/A2AClient.ts`)

Wraps `@a2a-js/sdk` ClientFactory + Client. Handles auth injection and error mapping.

### 4. Implement Manager (`src/core/a2a/A2AManager.ts`)

Singleton with connection lifecycle, skill discovery, event emission.

### 5. Implement Tool Adapter (`src/core/a2a/A2AToolAdapter.ts`)

Adapt skills to ToolDefinition, create handlers, register with ToolRegistry.

### 6. Wire into Service Worker

Add message handlers, tool registration events, auto-connect logic.

### 7. Build Settings UI (`A2ASettings.svelte`)

Mirror MCPSettings.svelte for agent management UI.

## Testing

```bash
# Run A2A unit tests
npm test -- src/core/a2a/__tests__/

# Run all tests
npm test

# Lint
npm run lint
```

## Manual Testing

1. Start a local A2A agent server (e.g., from a2a-js examples)
2. Open browserx extension settings
3. Add the local agent URL
4. Click "Connect" — verify agent card is fetched and skills appear
5. Start a conversation — verify the LLM can see and invoke remote skills
6. Verify streaming works (if agent supports it)
