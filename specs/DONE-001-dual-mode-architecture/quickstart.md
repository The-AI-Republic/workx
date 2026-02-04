# Quickstart: Dual-Mode Architecture

**Feature**: 001-dual-mode-architecture
**Date**: 2026-02-03

## Overview

This feature restructures BrowserX to support two build modes from a single codebase:

1. **Chrome Extension** (existing) - Browser automation within Chrome
2. **PI Desktop Agent** (new) - Native app with terminal, MCP, and remote control

## Prerequisites

### Development Environment

- Node.js 18+ with npm
- Rust toolchain (for Tauri) - [Install Rust](https://rustup.rs/)
- Platform build tools:
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio Build Tools, WebView2
  - **Linux**: `build-essential`, `libwebkit2gtk-4.0-dev`, `libssl-dev`

### Installing Tauri CLI

```bash
# Install Tauri CLI globally
npm install -g @tauri-apps/cli

# Or use cargo
cargo install tauri-cli
```

## Project Structure

```
browserx/
├── src/
│   ├── core/           # Shared code (both modes)
│   ├── extension/      # Chrome extension specific
│   └── pi/             # Native app specific
├── tauri/              # Tauri Rust backend
├── tests/
└── specs/              # Feature specifications
```

## Development Commands

### Chrome Extension

```bash
# Development (hot reload)
npm run dev

# Build extension
npm run build

# Run tests
npm test

# Type check
npm run type-check
```

### PI Native App

```bash
# Development (hot reload)
npm run dev:pi

# Build native app
npm run build:pi

# Build for specific platform
npm run build:pi -- --target x86_64-apple-darwin     # macOS Intel
npm run build:pi -- --target aarch64-apple-darwin    # macOS ARM
npm run build:pi -- --target x86_64-pc-windows-msvc  # Windows
npm run build:pi -- --target x86_64-unknown-linux-gnu # Linux
```

### Both Modes

```bash
# Run all tests (both modes)
npm run test:all

# Lint
npm run lint

# Format
npm run format
```

## Build Mode Detection

The build system sets `__BUILD_MODE__` at compile time:

```typescript
// In code, use conditional logic:
if (__BUILD_MODE__ === 'extension') {
  // Extension-specific code
} else {
  // Native-specific code
}

// Or use dynamic imports:
const controller = await createBrowserController();
// Returns ExtensionBrowserController or CDPBrowserController based on mode
```

## Key Interfaces

### ChannelAdapter

All UI channels implement this interface:

```typescript
interface ChannelAdapter {
  readonly channelId: string;
  readonly channelType: ChannelType;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  onSubmission(handler: SubmissionHandler): void;
  sendEvent(event: EventMsg): Promise<void>;

  supportsStreaming(): boolean;
  supportsApprovals(): boolean;
  supportsMedia(): boolean;
}
```

### BrowserController

Browser automation abstraction:

```typescript
interface BrowserController {
  initialize(): Promise<void>;
  isConnected(): boolean;

  navigate(url: string, options?: NavigateOptions): Promise<void>;
  click(selector: string, options?: ClickOptions): Promise<void>;
  type(selector: string, text: string, options?: TypeOptions): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  getSnapshot(): Promise<SerializedDOM>;

  disconnect(): Promise<void>;
  close(): Promise<void>;
}
```

### StorageProvider

Persistent storage abstraction:

```typescript
interface StorageProvider {
  initialize(): Promise<void>;
  close(): Promise<void>;

  get<T>(collection: string, key: string): Promise<T | null>;
  set<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;

  list<T>(collection: string, options?: ListOptions): Promise<T[]>;
  query<T>(collection: string, filter: QueryFilter): Promise<T[]>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
```

## Configuration (Native Mode)

PI configuration lives at `~/.pi/config.yaml`:

```yaml
general:
  log_level: info
  auto_start: true

llm:
  default_provider: openai
  providers:
    openai:
      api_key: ${OPENAI_API_KEY}
      model: gpt-4o

channels:
  websocket:
    enabled: true
    port: 8765

security:
  terminal:
    sandbox: blocklist
    blocked_commands:
      - "rm -rf /"
```

## WebSocket API (Native Mode)

Connect to PI at `ws://localhost:8765`:

```python
import asyncio
import websockets
import json

async def main():
    async with websockets.connect("ws://localhost:8765") as ws:
        # Send a task
        await ws.send(json.dumps({
            "type": "submission",
            "op": {
                "type": "UserTurn",
                "items": [{"type": "text", "text": "List files in home directory"}],
                "tabId": 0,
                "approval_policy": "auto",
                "model": "gpt-4o"
            }
        }))

        # Listen for events
        while True:
            msg = json.loads(await ws.recv())
            if msg["type"] == "event":
                event = msg["event"]
                if event["type"] == "AssistantTextDelta":
                    print(event["delta"], end="")
                elif event["type"] == "TaskComplete":
                    break

asyncio.run(main())
```

## Testing

### Unit Tests

```bash
# Run all unit tests
npm test

# Run specific test file
npm test -- src/core/channels/__tests__/ChannelManager.test.ts

# Watch mode
npm test -- --watch
```

### Contract Tests

Contract tests verify interface implementations:

```bash
# Run contract tests
npm run test:contract
```

### E2E Tests

```bash
# Extension E2E
npm run test:e2e:extension

# Native app E2E
npm run test:e2e:pi
```

## Debugging

### Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Load unpacked from `dist/extension`
4. Click "Inspect" on service worker for background logs

### Native App

```bash
# Run with verbose logging
RUST_LOG=debug npm run dev:pi

# Or set in config
general:
  log_level: debug
```

## Common Issues

### Tauri Build Fails

```bash
# Ensure Rust is up to date
rustup update

# Check prerequisites
tauri info
```

### Chrome DevTools MCP Not Working

1. Navigate to `chrome://inspect/#remote-debugging`
2. Enable "Enable remote debugging"
3. When PI connects, approve the permission dialog

### Profile Copy Fails (Fallback Mode)

- Close Chrome completely before PI starts
- Or let PI use its own Chrome instance

## Next Steps

1. Read the full [spec.md](./spec.md) for requirements
2. Review [data-model.md](./data-model.md) for entity definitions
3. Check [contracts/](./contracts/) for interface contracts
4. Run `/rr.tasks` to generate implementation tasks
