# PI (Personal AI) - Desktop Agent Design Document

**Version**: 1.0
**Date**: 2026-02-02
**Status**: Draft
**Related**: [Research Chat History](./desktop_agent_research_chat_history.md)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [System Architecture](#3-system-architecture)
4. [Multi-Channel Architecture](#4-multi-channel-architecture)
5. [Component Design](#5-component-design)
6. [Build System](#6-build-system)
7. [Platform Considerations](#7-platform-considerations)
8. [Security Model](#8-security-model)
9. [Configuration System](#9-configuration-system)
10. [Distribution Strategy](#10-distribution-strategy)
11. [Migration Path](#11-migration-path)
12. [Future Considerations](#12-future-considerations)

---

## 1. Executive Summary

### 1.1 Background

BrowserX is currently a Chrome extension that provides AI-powered browser automation. This design document outlines the architecture for **PI (Personal AI)**, an evolution that enables BrowserX to run as a native desktop agent while maintaining backward compatibility with the existing Chrome extension.

### 1.2 Vision

PI transforms from a browser-only assistant to a **full-spectrum personal agent** capable of:

- Executing terminal commands on the host machine
- Controlling browsers externally via Chrome DevTools Protocol (CDP)
- Integrating with MCP (Model Context Protocol) servers for extensibility
- Receiving commands from multiple channels (Telegram, WhatsApp, iMessage, etc.)
- Running as a background daemon with system tray presence
- Operating across Windows, macOS, and Linux

### 1.3 Key Design Principles

| Principle | Description |
|-----------|-------------|
| **Dual-Mode Compatibility** | Single codebase supports both Chrome extension and native app builds |
| **Abstraction Over Platform** | Core logic remains platform-agnostic through interface abstractions |
| **Minimal User Friction** | No manual network configuration (port forwarding, etc.) required |
| **Security by Default** | Whitelist-based access control, no unnecessary exposure |
| **Open Source Friendly** | All dependencies must be free for personal use |

---

## 2. Goals and Non-Goals

### 2.1 Goals

| ID | Goal | Priority |
|----|------|----------|
| G1 | Support dual build modes (extension + native) from single codebase | P0 |
| G2 | Execute arbitrary terminal commands on host machine | P0 |
| G3 | Control Chrome browser via CDP from outside the browser | P0 |
| G4 | Integrate with MCP servers for tool extensibility | P0 |
| G5 | Accept triggers from messaging platforms (Telegram, WhatsApp) | P1 |
| G6 | Run as background daemon with system tray UI | P1 |
| G7 | Support scheduled triggers via Google Calendar | P2 |
| G8 | Provide both GUI (Tauri) and TUI interfaces | P1 |
| G9 | Work behind NAT without user network configuration | P0 |

### 2.2 Non-Goals

| ID | Non-Goal | Rationale |
|----|----------|-----------|
| NG1 | Mobile app development | Focus on desktop first; messaging apps provide mobile access |
| NG2 | Cloud-hosted agent service | PI runs locally; user data never leaves their machine |
| NG3 | Multi-user support | Personal assistant for single user/household |
| NG4 | Real-time collaboration features | Not a collaborative tool |
| NG5 | Custom LLM hosting | Use existing LLM providers via API |

---

## 3. System Architecture

### 3.1 High-Level Architecture

The PI system is built around a **channel-agnostic agent core** with pluggable UI adapters. The architecture separates three concerns:

1. **UI Channels** - Multiple interfaces that send submissions and receive events
2. **Agent Core** - The AI agent that processes requests and executes tools
3. **Tool Layer** - Browser automation, terminal, MCP, and other capabilities

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PI SYSTEM                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      UI CHANNELS (ChannelAdapter)                    │    │
│  ├─────────────┬─────────────┬─────────────┬─────────────┬─────────────┤    │
│  │  Chrome     │  Chrome     │   Tauri     │  WebSocket  │  Telegram/  │    │
│  │  Side Panel │  Tab Page   │   Desktop   │  (Remote)   │  WhatsApp   │    │
│  └──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┘    │
│         │             │             │             │             │           │
│         └─────────────┴─────────────┼─────────────┴─────────────┘           │
│                                     │                                        │
│                      ┌──────────────▼──────────────┐                        │
│                      │      CHANNEL MANAGER        │                        │
│                      │  (Routes SQ↓ and EQ↑)       │                        │
│                      └──────────────┬──────────────┘                        │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────┐    │
│  │                    SUBMISSION QUEUE (SQ)                             │    │
│  │              Receives: Op (UserTurn, Interrupt, Approval)            │    │
│  └──────────────────────────────────┬──────────────────────────────────┘    │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────┐    │
│  │                          AGENT CORE                                  │    │
│  │                                                                      │    │
│  │  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐          │    │
│  │  │ BrowserxAgent │◄─►│    Session    │◄─►│  TurnManager  │          │    │
│  │  └───────────────┘   └───────────────┘   └───────┬───────┘          │    │
│  │                                                   │                  │    │
│  │         ┌─────────────────────────────────────────┤                  │    │
│  │         │                    │                    │                  │    │
│  │  ┌──────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐          │    │
│  │  │ ModelClient │      │ ToolRegistry │      │  Approval   │          │    │
│  │  │  (LLM API)  │      │             │      │   Manager   │          │    │
│  │  └─────────────┘      └──────┬──────┘      └─────────────┘          │    │
│  │                              │                                       │    │
│  └──────────────────────────────┼───────────────────────────────────────┘    │
│                                 │                                            │
│  ┌──────────────────────────────▼───────────────────────────────────────┐    │
│  │                          TOOL LAYER                                   │    │
│  │                                                                       │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │    │
│  │  │ DomTool  │ │ Terminal │ │   MCP    │ │Navigation│ │  Vision  │   │    │
│  │  │(CDP/Ext) │ │(Native)  │ │ Client   │ │  Tool    │ │   Tool   │   │    │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │    │
│  │       │            │            │            │            │          │    │
│  └───────┼────────────┼────────────┼────────────┼────────────┼──────────┘    │
│          │            │            │            │            │               │
│  ┌───────▼────────────▼────────────▼────────────▼────────────▼──────────┐    │
│  │                       EXTERNAL SYSTEMS                                │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │    │
│  │  │ Chrome  │  │  Shell  │  │   MCP   │  │   OS    │  │   OS    │    │    │
│  │  │  (CDP)  │  │ Process │  │ Servers │  │   FS    │  │  APIs   │    │    │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                 │                                            │
│  ┌──────────────────────────────▼───────────────────────────────────────┐    │
│  │                       EVENT QUEUE (EQ)                                │    │
│  │         Emits: EventMsg (TaskStarted, ToolCall, TextDelta, etc.)      │    │
│  └──────────────────────────────┬───────────────────────────────────────┘    │
│                                 │                                            │
│                      ┌──────────▼──────────┐                                │
│                      │   EVENT DISPATCHER  │                                │
│                      │  (Routes to Channels)│                                │
│                      └──────────┬──────────┘                                │
│                                 │                                            │
│         ┌───────────────────────┼───────────────────────┐                   │
│         ▼             ▼         ▼         ▼             ▼                   │
│  ┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐│
│  │ Side Panel  ││  Tab Page   ││   Tauri     ││  WebSocket  ││  Telegram   ││
│  │ (renders)   ││ (renders)   ││  (renders)  ││  (streams)  ││  (sends)    ││
│  └─────────────┘└─────────────┘└─────────────┘└─────────────┘└─────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Overview

| Component | Responsibility | Mode |
|-----------|---------------|------|
| **ChannelAdapter** | Interface for UI channels (send/receive) | Both |
| **Channel Manager** | Routes submissions to agent, dispatches events to channels | Both |
| **Submission Queue (SQ)** | Receives `Op` submissions from channels | Both |
| **Event Queue (EQ)** | Emits `EventMsg` events to channels | Both |
| **BrowserxAgent** | Orchestrates LLM calls and tool execution | Both |
| **Session** | Maintains conversation state and history | Both |
| **TurnManager** | Manages individual conversation turns | Both |
| **ModelClient** | Connects to LLM providers (OpenAI, Anthropic, etc.) | Both |
| **ToolRegistry** | Registers and dispatches tool calls | Both |
| **ApprovalManager** | Handles user approval for sensitive operations | Both |
| **DomTool** | Browser automation via chrome.debugger or CDP | Both (abstracted) |
| **Terminal Tool** | Runs shell commands | Native only |
| **MCP Client** | Communicates with MCP servers | Native only |

### 3.3 Data Flow (SQ/EQ Pattern)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         REQUEST/RESPONSE FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. USER INPUT (Any Channel)                                                 │
│     ┌─────────────┐                                                         │
│     │ User sends  │ "Help me book a flight to NYC for next Friday"          │
│     │ via any UI  │ (Side Panel, Tauri, WebSocket, Telegram...)             │
│     └──────┬──────┘                                                         │
│            │                                                                 │
│  2. CHANNEL ADAPTER → SUBMISSION QUEUE                                       │
│            ▼                                                                 │
│     ┌─────────────┐     ┌─────────────────────────────────────────────┐    │
│     │ Channel     │────►│ Op: {                                        │    │
│     │ Adapter     │     │   type: 'UserTurn',                          │    │
│     │             │     │   items: [{ type: 'text', text: '...' }],    │    │
│     │             │     │   tabId: 0,                                  │    │
│     │             │     │   approval_policy: 'auto'                    │    │
│     │             │     │ }                                            │    │
│     └─────────────┘     └──────────────────────┬──────────────────────┘    │
│                                                 │                           │
│  3. AGENT CORE PROCESSING                       │                           │
│            ┌────────────────────────────────────┘                           │
│            ▼                                                                 │
│     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                │
│     │ Session     │────►│   Model     │────►│    Tool     │                │
│     │ Context     │     │   Client    │     │  Execution  │                │
│     └─────────────┘     └─────────────┘     └──────┬──────┘                │
│                                                     │                        │
│  4. EVENT QUEUE → CHANNEL (Streaming)               │                        │
│            ┌────────────────────────────────────────┘                        │
│            ▼                                                                 │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │ EventMsg stream:                                                 │    │
│     │   { type: 'TaskStarted', taskId: '...' }                        │    │
│     │   { type: 'ToolCall', toolName: 'browser_navigate', ... }       │    │
│     │   { type: 'AssistantTextDelta', delta: 'I found 3 flights...' } │    │
│     │   { type: 'TaskComplete', result: {...} }                       │    │
│     └──────────────────────────────┬──────────────────────────────────┘    │
│                                    │                                        │
│  5. RESPONSE DELIVERY              │                                        │
│            ┌───────────────────────┘                                        │
│            ▼                                                                 │
│     ┌─────────────┐                                                         │
│     │ Channel     │ Events routed back to originating channel              │
│     │ Manager     │ (Side Panel renders UI, WebSocket streams JSON,        │
│     │             │  Telegram sends message)                                │
│     └─────────────┘                                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Key Protocol Types

The architecture uses two core message types from `src/protocol/`:

**Submissions (Op)** - Input to agent:
- `UserTurn` - User message with optional settings
- `Interrupt` - Cancel current task
- `ExecApproval` / `PatchApproval` - User approval decisions
- `Compact` - Request context compaction

**Events (EventMsg)** - Output from agent:
- `TaskStarted` / `TaskComplete` / `TaskError` - Task lifecycle
- `ToolCall` / `ToolResult` - Tool execution
- `AssistantText` / `AssistantTextDelta` - Agent responses (streaming)
- `RequestApproval` - Request user permission
- `ReasoningDelta` - Reasoning process (if enabled)

---

## 4. Multi-Channel Architecture

### 4.1 Overview

A core design principle of PI is the **separation of concerns** between the AI Agent, Tools, and UI channels. This enables:

1. **Multiple simultaneous UIs**: Side panel, tab page, desktop app, remote clients
2. **Remote control**: External applications can send messages and receive events
3. **Unified agent core**: Single agent implementation serves all channels
4. **Event-driven communication**: All channels receive the same event stream

### 4.2 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PI MULTI-CHANNEL ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        UI CHANNELS (Inputs)                          │    │
│  ├─────────────┬─────────────┬─────────────┬─────────────┬─────────────┤    │
│  │  Chrome     │  Chrome     │   Tauri     │  Remote     │  Telegram/  │    │
│  │  Side Panel │  Tab Page   │   Frontend  │  WebSocket  │  WhatsApp   │    │
│  │  (Extension)│  (Extension)│   (Desktop) │  (API)      │  (Adapters) │    │
│  └──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┘    │
│         │             │             │             │             │           │
│         └─────────────┴─────────────┼─────────────┴─────────────┘           │
│                                     │                                        │
│                      ┌──────────────▼──────────────┐                        │
│                      │      CHANNEL MANAGER        │                        │
│                      │   (Routes & Dispatches)     │                        │
│                      └──────────────┬──────────────┘                        │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────┐    │
│  │                         SUBMISSION QUEUE (SQ)                        │    │
│  │                    Receives: Op (UserTurn, Interrupt, etc.)          │    │
│  └──────────────────────────────────┬──────────────────────────────────┘    │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────┐    │
│  │                           AGENT CORE                                 │    │
│  │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                │    │
│  │  │ BrowserxAgent│   │   Session   │   │ TurnManager │                │    │
│  │  │             │◄─►│   State     │◄─►│             │                │    │
│  │  └─────────────┘   └─────────────┘   └─────────────┘                │    │
│  │         │                                   │                        │    │
│  │         │          ┌────────────────────────┤                        │    │
│  │         ▼          ▼                        ▼                        │    │
│  │  ┌─────────────┐ ┌─────────────┐  ┌─────────────────┐               │    │
│  │  │ ToolRegistry │ │ ModelClient │  │ ApprovalManager │               │    │
│  │  └──────┬──────┘ └─────────────┘  └─────────────────┘               │    │
│  └─────────┼────────────────────────────────────────────────────────────┘    │
│            │                                                                 │
│  ┌─────────▼──────────────────────────────────────────────────────────┐     │
│  │                            TOOL LAYER                               │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │     │
│  │  │ DomTool  │ │ Terminal │ │   MCP    │ │Navigation│ │  Vision  │ │     │
│  │  │(CDP/Ext) │ │(Native)  │ │ Client   │ │  Tool    │ │   Tool   │ │     │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                     │                                        │
│  ┌──────────────────────────────────▼──────────────────────────────────┐    │
│  │                          EVENT QUEUE (EQ)                            │    │
│  │            Emits: EventMsg (TaskStarted, ToolCall, TextDelta, etc.)  │    │
│  └──────────────────────────────────┬──────────────────────────────────┘    │
│                                     │                                        │
│                      ┌──────────────▼──────────────┐                        │
│                      │      EVENT DISPATCHER       │                        │
│                      │    (Routes to Channels)     │                        │
│                      └──────────────┬──────────────┘                        │
│                                     │                                        │
│         ┌───────────────────────────┼───────────────────────────┐           │
│         │             │             │             │             │           │
│         ▼             ▼             ▼             ▼             ▼           │
│  ┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐│
│  │ Side Panel  ││  Tab Page   ││   Tauri     ││  WebSocket  ││  Telegram   ││
│  │ (renders)   ││ (renders)   ││  (renders)  ││  (sends)    ││  (sends)    ││
│  └─────────────┘└─────────────┘└─────────────┘└─────────────┘└─────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 SQ/EQ Protocol (Existing Foundation)

The codebase already uses a **Submission Queue / Event Queue** pattern that naturally supports multi-channel communication:

#### 4.3.1 Submissions (Input to Agent)

```typescript
// src/protocol/types.ts - Op type (Submissions)
type Op =
  | { type: 'UserTurn'; items: InputItem[]; tabId: number; approval_policy; sandbox_policy; model; effort?; summary }
  | { type: 'UserInput'; items: InputItem[] }
  | { type: 'Interrupt' }
  | { type: 'ExecApproval'; id: string; decision: 'allow' | 'deny' }
  | { type: 'PatchApproval'; id: string; decision: 'allow' | 'deny' }
  | { type: 'Compact' }
  | { type: 'ManualCompact' }
  | { type: 'AddToHistory'; text: string }
  // ... more
```

#### 4.3.2 Events (Output from Agent)

```typescript
// src/protocol/events.ts - EventMsg types
type EventMsg =
  | { type: 'BackgroundEvent'; status: string; message?: string }
  | { type: 'TaskStarted'; taskId: string }
  | { type: 'TaskComplete'; result: any }
  | { type: 'TaskError'; error: string }
  | { type: 'TurnStart'; turnId: string }
  | { type: 'TurnComplete'; turnId: string }
  | { type: 'ToolCall'; toolName: string; parameters: any }
  | { type: 'ToolResult'; toolName: string; result: any }
  | { type: 'AssistantText'; text: string }
  | { type: 'AssistantTextDelta'; delta: string }  // Streaming
  | { type: 'RequestApproval'; id: string; toolName: string; reason: string }
  | { type: 'ReasoningDelta'; delta: string }
  // ... more
```

### 4.4 Channel Adapter Interface

Each UI channel implements a unified adapter interface:

```typescript
// src/core/channels/ChannelAdapter.ts

interface ChannelAdapter {
  readonly channelId: string;
  readonly channelType: ChannelType;

  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Receiving submissions from this channel
  onSubmission(handler: (op: Op, context: SubmissionContext) => void): void;

  // Sending events to this channel
  sendEvent(event: EventMsg): Promise<void>;

  // Channel capabilities
  supportsStreaming(): boolean;
  supportsApprovals(): boolean;
  supportsMedia(): boolean;
}

type ChannelType =
  | 'sidepanel'    // Chrome extension side panel
  | 'tabpage'      // Chrome extension tab page
  | 'tauri'        // Tauri desktop frontend
  | 'websocket'    // Remote WebSocket API
  | 'telegram'     // Telegram bot
  | 'whatsapp'     // WhatsApp adapter
  | 'cli';         // Terminal UI

interface SubmissionContext {
  channelId: string;
  channelType: ChannelType;
  userId?: string;
  sessionId?: string;
  tabId?: number;
  replyCallback?: (text: string) => Promise<void>;
}
```

### 4.5 Channel Implementations

#### 4.5.1 Extension Channels (Side Panel & Tab Page)

Both use `chrome.runtime` messaging but register as separate channels:

```typescript
// src/extension/channels/SidePanelChannel.ts
export class SidePanelChannel implements ChannelAdapter {
  readonly channelId = 'sidepanel-main';
  readonly channelType = 'sidepanel' as const;
  private submissionHandler: (op: Op, ctx: SubmissionContext) => void;

  async initialize() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.source === 'sidepanel' && msg.type === 'SUBMISSION') {
        this.submissionHandler(msg.payload, {
          channelId: this.channelId,
          channelType: this.channelType
        });
      }
    });
  }

  onSubmission(handler: (op: Op, ctx: SubmissionContext) => void) {
    this.submissionHandler = handler;
  }

  async sendEvent(event: EventMsg) {
    chrome.runtime.sendMessage({
      type: 'EVENT',
      target: 'sidepanel',
      payload: event
    });
  }

  supportsStreaming() { return true; }
  supportsApprovals() { return true; }
  supportsMedia() { return true; }
}
```

```typescript
// src/extension/channels/TabPageChannel.ts
export class TabPageChannel implements ChannelAdapter {
  readonly channelId: string;
  readonly channelType = 'tabpage' as const;
  private tabId: number;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.channelId = `tabpage-${tabId}`;
  }

  async sendEvent(event: EventMsg) {
    // Send to tab via content script or dedicated messaging
    chrome.tabs.sendMessage(this.tabId, {
      type: 'EVENT',
      payload: event
    });
  }
}
```

#### 4.5.2 Tauri Desktop Channel

When running as a Tauri app, communication happens via Tauri's IPC:

```typescript
// src/pi/channels/TauriChannel.ts
import { invoke, listen } from '@tauri-apps/api';

export class TauriChannel implements ChannelAdapter {
  readonly channelId = 'tauri-main';
  readonly channelType = 'tauri' as const;
  private submissionHandler: (op: Op, ctx: SubmissionContext) => void;

  async initialize() {
    // Listen for submissions from Tauri frontend
    await listen('agent:submission', (event) => {
      this.submissionHandler(event.payload as Op, {
        channelId: this.channelId,
        channelType: this.channelType
      });
    });
  }

  onSubmission(handler: (op: Op, ctx: SubmissionContext) => void) {
    this.submissionHandler = handler;
  }

  async sendEvent(event: EventMsg) {
    // Emit event to Tauri frontend via Rust backend
    await invoke('emit_event', { event });
  }

  supportsStreaming() { return true; }
  supportsApprovals() { return true; }
  supportsMedia() { return true; }
}
```

#### 4.5.3 Remote WebSocket Channel

This is **key for remote message control** - enables external clients to send tasks and receive events:

```typescript
// src/pi/channels/WebSocketChannel.ts
import { WebSocketServer, WebSocket } from 'ws';

export class WebSocketChannel implements ChannelAdapter {
  readonly channelId = 'websocket-server';
  readonly channelType = 'websocket' as const;
  private wss: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  private submissionHandler: (op: Op, ctx: SubmissionContext) => void;

  async initialize() {
    this.wss = new WebSocketServer({ port: 8765 });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      this.clients.set(clientId, ws);

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'Connected to PI agent'
      }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as RemoteMessage;
          this.handleMessage(msg, clientId, ws);
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });
    });
  }

  private handleMessage(msg: RemoteMessage, clientId: string, ws: WebSocket) {
    if (msg.type === 'submission') {
      this.submissionHandler(msg.op, {
        channelId: clientId,
        channelType: 'websocket',
        sessionId: msg.sessionId,
        replyCallback: async (text) => {
          ws.send(JSON.stringify({ type: 'reply', text }));
        }
      });
    }
  }

  onSubmission(handler: (op: Op, ctx: SubmissionContext) => void) {
    this.submissionHandler = handler;
  }

  async sendEvent(event: EventMsg, targetClientId?: string) {
    const message = JSON.stringify({ type: 'event', event });

    if (targetClientId) {
      // Send to specific client
      this.clients.get(targetClientId)?.send(message);
    } else {
      // Broadcast to all connected clients
      this.clients.forEach(ws => ws.send(message));
    }
  }

  supportsStreaming() { return true; }
  supportsApprovals() { return true; }
  supportsMedia() { return false; }  // Binary needs special handling

  private generateClientId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Remote message protocol
interface RemoteMessage {
  type: 'submission' | 'ping';
  sessionId?: string;
  op?: Op;
}
```

### 4.6 Remote API Protocol

For WebSocket and HTTP API clients, a clean protocol for external control:

#### 4.6.1 Client → Agent (Submissions)

```typescript
// Start a new task
{
  "type": "submission",
  "sessionId": "optional-session-id",  // Creates new if not provided
  "op": {
    "type": "UserTurn",
    "items": [{ "type": "text", "text": "Book a flight to NYC for next Friday" }],
    "tabId": 0,
    "approval_policy": "auto",
    "model": "gpt-4o"
  }
}

// Interrupt current task
{
  "type": "submission",
  "sessionId": "existing-session-id",
  "op": { "type": "Interrupt" }
}

// Approve a tool execution
{
  "type": "submission",
  "sessionId": "existing-session-id",
  "op": {
    "type": "ExecApproval",
    "id": "approval-request-id",
    "decision": "allow"
  }
}
```

#### 4.6.2 Agent → Client (Events)

```typescript
// Task lifecycle
{ "type": "event", "event": { "type": "TaskStarted", "taskId": "task-123" } }
{ "type": "event", "event": { "type": "TaskComplete", "result": {...} } }
{ "type": "event", "event": { "type": "TaskError", "error": "..." } }

// Streaming text (for real-time display)
{ "type": "event", "event": { "type": "AssistantTextDelta", "delta": "I'll help" } }
{ "type": "event", "event": { "type": "AssistantTextDelta", "delta": " you book" } }
{ "type": "event", "event": { "type": "AssistantText", "text": "I'll help you book..." } }

// Tool execution
{ "type": "event", "event": { "type": "ToolCall", "toolName": "browser_navigate", "parameters": {...} } }
{ "type": "event", "event": { "type": "ToolResult", "toolName": "browser_navigate", "result": {...} } }

// Approval request (client must respond)
{ "type": "event", "event": { "type": "RequestApproval", "id": "apr-456", "toolName": "terminal_execute", "reason": "Run: npm install" } }
```

#### 4.6.3 Example: Python Remote Client

```python
import asyncio
import websockets
import json

async def main():
    uri = "ws://localhost:8765"
    async with websockets.connect(uri) as ws:
        # Send a task
        await ws.send(json.dumps({
            "type": "submission",
            "op": {
                "type": "UserTurn",
                "items": [{"type": "text", "text": "Check my Amazon orders"}],
                "tabId": 0,
                "approval_policy": "auto",
                "model": "gpt-4o"
            }
        }))

        # Listen for events
        while True:
            message = await ws.recv()
            data = json.loads(message)

            if data["type"] == "event":
                event = data["event"]
                print(f"Event: {event['type']}")

                if event["type"] == "AssistantTextDelta":
                    print(event["delta"], end="", flush=True)
                elif event["type"] == "TaskComplete":
                    print("\nTask completed!")
                    break
                elif event["type"] == "RequestApproval":
                    # Auto-approve for this example
                    await ws.send(json.dumps({
                        "type": "submission",
                        "op": {
                            "type": "ExecApproval",
                            "id": event["id"],
                            "decision": "allow"
                        }
                    }))

asyncio.run(main())
```

### 4.7 Channel Manager

Orchestrates all channels and routes events:

```typescript
// src/core/channels/ChannelManager.ts

export class ChannelManager {
  private channels: Map<string, ChannelAdapter> = new Map();
  private sessionChannels: Map<string, string> = new Map();  // sessionId -> channelId
  private agent: BrowserxAgent;

  constructor(agent: BrowserxAgent) {
    this.agent = agent;
  }

  registerChannel(channel: ChannelAdapter) {
    this.channels.set(channel.channelId, channel);

    channel.onSubmission((op, context) => {
      // Track which channel initiated this session
      if (context.sessionId) {
        this.sessionChannels.set(context.sessionId, context.channelId);
      }

      // Forward to agent
      this.agent.handleSubmission(op, context);
    });
  }

  unregisterChannel(channelId: string) {
    this.channels.delete(channelId);
    // Clean up session mappings
    for (const [sessionId, cid] of this.sessionChannels) {
      if (cid === channelId) {
        this.sessionChannels.delete(sessionId);
      }
    }
  }

  // Called by agent when emitting events
  dispatchEvent(event: EventMsg, sessionId: string) {
    const channelId = this.sessionChannels.get(sessionId);

    if (channelId) {
      // Send to originating channel
      const channel = this.channels.get(channelId);
      channel?.sendEvent(event);
    }
  }

  // Broadcast to all channels (for global events)
  broadcastEvent(event: EventMsg) {
    this.channels.forEach(channel => channel.sendEvent(event));
  }

  getChannelCapabilities(channelId: string): ChannelCapabilities | null {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    return {
      streaming: channel.supportsStreaming(),
      approvals: channel.supportsApprovals(),
      media: channel.supportsMedia()
    };
  }
}

interface ChannelCapabilities {
  streaming: boolean;
  approvals: boolean;
  media: boolean;
}
```

### 4.8 Integration with Existing Codebase

The multi-channel architecture builds on existing patterns:

| Existing Component | Current State | Required Change |
|-------------------|---------------|-----------------|
| `MessageRouter` | Tightly coupled to `chrome.runtime` | Abstract into `ChannelAdapter` interface |
| `BrowserxAgent` | Single channel output | Inject `ChannelManager` for multi-channel dispatch |
| `service-worker.ts` | Extension-only initialization | Conditional init based on build mode |
| Side Panel Stores | Direct `chrome.runtime` calls | Use channel-agnostic message API |
| `EventMsg` emission | Via `chrome.runtime.sendMessage` | Via `ChannelManager.dispatchEvent()` |

#### 4.8.1 Agent Integration

```typescript
// Updated BrowserxAgent initialization
export class BrowserxAgent {
  private channelManager: ChannelManager;

  constructor(config: AgentConfig, channelManager: ChannelManager) {
    this.channelManager = channelManager;
    // ... existing initialization
  }

  // Called when agent wants to emit an event
  private emitEvent(event: EventMsg, sessionId: string) {
    this.channelManager.dispatchEvent(event, sessionId);
  }
}
```

### 4.9 Build Mode Configuration

Different channels are registered based on build mode:

```typescript
// src/core/channels/index.ts

export async function initializeChannels(
  agent: BrowserxAgent,
  buildMode: 'extension' | 'native'
): Promise<ChannelManager> {
  const manager = new ChannelManager(agent);

  if (buildMode === 'extension') {
    // Chrome extension channels
    const { SidePanelChannel } = await import('../../extension/channels/SidePanelChannel');
    const { TabPageChannel } = await import('../../extension/channels/TabPageChannel');

    manager.registerChannel(new SidePanelChannel());
    // TabPageChannel registered dynamically per tab
  } else {
    // Native app channels
    const { TauriChannel } = await import('../../pax/channels/TauriChannel');
    const { WebSocketChannel } = await import('../../pax/channels/WebSocketChannel');
    const { TelegramChannel } = await import('../../pax/channels/TelegramChannel');

    manager.registerChannel(new TauriChannel());
    manager.registerChannel(new WebSocketChannel());

    // Optional channels based on config
    if (config.channels.telegram.enabled) {
      manager.registerChannel(new TelegramChannel(config.channels.telegram));
    }
  }

  return manager;
}
```

---

## 5. Component Design

This section details the internal components of the PI agent. For the multi-channel architecture (how UI channels communicate with the agent), see Section 4.

### 5.1 Agent Core

The agent core consists of three main classes that work together to process user requests:

#### 5.1.1 BrowserxAgent

The main orchestrator that coordinates all agent activities:

```typescript
// src/core/BrowserxAgent.ts
class BrowserxAgent {
  private session: Session;
  private channelManager: ChannelManager;
  private toolRegistry: ToolRegistry;
  private modelClientFactory: ModelClientFactory;
  private approvalManager: ApprovalManager;

  // Receives Op submissions from ChannelManager
  async handleSubmission(op: Op, context: SubmissionContext): Promise<void>;

  // Emits EventMsg to channels via ChannelManager
  private emitEvent(event: EventMsg, sessionId: string): void;
}
```

#### 5.1.2 Session

Maintains conversation state and history:

```typescript
// src/core/Session.ts
class Session {
  private state: SessionState;
  private services: SessionServices;
  private activeTurn: ActiveTurn | null;

  // State includes: conversationId, messages, toolUsageStats, errorHistory
  // Supports history restoration and compaction for long conversations
}
```

#### 5.1.3 TurnManager

Manages individual conversation turns (one user request → agent response cycle):

```typescript
// src/core/TurnManager.ts
class TurnManager {
  // Handles model streaming via ResponseStream
  // Coordinates tool call execution
  // Manages retry logic (3 retries, exponential backoff)
  // Emits events: TurnStart, ToolCall, ToolResult, AssistantTextDelta, TurnComplete
}
```

#### 5.1.4 Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    AGENT EXECUTION LOOP                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Op: UserTurn                                                    │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────┐                                                │
│  │ BrowserxAgent│ → emits TaskStarted                           │
│  └──────┬──────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐     ┌─────────────────────────────────────┐   │
│  │   Session   │────►│ Load: conversation history,          │   │
│  │  (Context)  │     │ tool registry, user preferences      │   │
│  └──────┬──────┘     └─────────────────────────────────────┘   │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐ → emits TurnStart                              │
│  │ TurnManager │                                                │
│  └──────┬──────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐                                                │
│  │ ModelClient │◄─────────────────────────────┐                │
│  │ (LLM API)   │                              │                │
│  └──────┬──────┘                              │                │
│         │ streaming response                   │                │
│         ▼                                      │                │
│  ┌─────────────┐                              │                │
│  │ Tool Call?  │ → emits AssistantTextDelta   │                │
│  └──────┬──────┘                              │                │
│         │                                      │                │
│    Yes  │  No                                 │                │
│    ┌────┴────┐                                │                │
│    ▼         ▼                                │                │
│ ┌──────────┐ ┌──────────┐                    │                │
│ │ToolCall  │ │ Complete │                    │                │
│ │→ToolResult│ │ Turn    │                    │                │
│ └────┬─────┘ └────┬─────┘                    │                │
│      │            │                           │                │
│      │            ▼                           │                │
│      │     ┌──────────┐                       │                │
│      │     │TaskComplete                      │                │
│      │     └──────────┘                       │                │
│      │                                         │                │
│      └─────────────────────────────────────────┘                │
│           (Loop with tool result)                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.1.5 Context Management

Context is maintained at multiple levels:

| Level | Scope | Storage | TTL |
|-------|-------|---------|-----|
| **Turn Context** | Single request-response | Memory | Request lifetime |
| **Session Context** | Conversation session | Memory + Disk | Configurable (default 1hr) |
| **User Context** | Per-user preferences | Disk | Persistent |
| **Global Context** | System-wide settings | Disk | Persistent |

#### 5.1.6 Task Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_TURNS` | 500 | Maximum turns per task |
| `COMPACTION_THRESHOLD` | 0.85 | Compact when context reaches 85% of window |
| `toolTimeout` | 30s | Timeout for individual tool execution |
| `totalTimeout` | 5min | Total timeout for entire request |

### 5.2 Tool System

#### 5.2.1 Tool Registry Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       TOOL REGISTRY                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Built-in Tools                    Dynamic Tools                 │
│  ┌─────────────────────────┐      ┌─────────────────────────┐   │
│  │ - DOMTool (unified)     │      │ MCP Server Tools        │   │
│  │ - NavigationTool        │      │ (discovered at runtime) │   │
│  │ - PageVisionTool        │      │                         │   │
│  │ - PlanningTool          │      │ - filesystem (MCP)      │   │
│  │ - WebSearchTool         │      │ - git (MCP)             │   │
│  │ - terminal_execute      │      │ - database (MCP)        │   │
│  │ - StorageTool           │      │ - custom user MCPs      │   │
│  └─────────────────────────┘      └─────────────────────────┘   │
│              │                              │                    │
│              └──────────────┬───────────────┘                    │
│                             │                                    │
│                      ┌──────▼──────┐                            │
│                      │   Tool      │                            │
│                      │   Schema    │                            │
│                      │   Cache     │                            │
│                      └─────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.2.2 Tool Interface

Every tool (built-in or MCP) conforms to:

```
Tool {
  name: string              // Unique identifier
  description: string       // For LLM understanding
  parameters: JSONSchema    // Input schema
  returns: JSONSchema       // Output schema
  mode: 'extension' | 'native' | 'both'
  permissions: Permission[] // Required permissions
  execute(params): Promise<ToolResult>
}
```

#### 5.2.3 Built-in Tools

##### Browser Control Tools

| Tool | Description | Extension Mode | Native Mode |
|------|-------------|----------------|-------------|
| `browser_navigate` | Navigate to URL | chrome.debugger | CDP |
| `browser_click` | Click element by selector | chrome.debugger | CDP |
| `browser_type` | Type text into element | chrome.debugger | CDP |
| `browser_screenshot` | Capture page screenshot | chrome.debugger | CDP |
| `browser_get_content` | Extract page content | chrome.debugger | CDP |
| `browser_execute_script` | Run JavaScript | chrome.debugger | CDP |
| `browser_wait` | Wait for element/condition | chrome.debugger | CDP |

##### Terminal Tools (Native Only)

| Tool | Description | Security |
|------|-------------|----------|
| `terminal_execute` | Run shell command | Sandboxed, configurable allow/deny |
| `terminal_execute_interactive` | Run with PTY | For commands needing interaction |

##### File System Tools (Native Only)

| Tool | Description | Security |
|------|-------------|----------|
| `file_read` | Read file contents | Path whitelist |
| `file_write` | Write file contents | Path whitelist |
| `file_list` | List directory contents | Path whitelist |
| `file_search` | Search files by pattern | Path whitelist |

##### System Tools

| Tool | Description | Mode |
|------|-------------|------|
| `system_info` | Get OS, memory, CPU info | Native |
| `system_clipboard_read` | Read clipboard | Both |
| `system_clipboard_write` | Write clipboard | Both |
| `system_notification` | Show OS notification | Native |

#### 5.2.4 Tool Permission Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    PERMISSION HIERARCHY                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Level 0: Safe (No confirmation)                                │
│  ├── browser_navigate (to allowed domains)                      │
│  ├── browser_screenshot                                         │
│  ├── file_read (in allowed paths)                               │
│  └── system_info                                                │
│                                                                  │
│  Level 1: Standard (One-time confirmation)                      │
│  ├── browser_click                                              │
│  ├── browser_type                                               │
│  ├── file_write (in allowed paths)                              │
│  └── terminal_execute (whitelisted commands)                    │
│                                                                  │
│  Level 2: Sensitive (Always confirm)                            │
│  ├── terminal_execute (arbitrary commands)                      │
│  ├── file_write (outside allowed paths)                         │
│  ├── browser_navigate (to sensitive domains: banking, etc.)     │
│  └── system_clipboard_write                                     │
│                                                                  │
│  Level 3: Dangerous (Confirm + warning)                         │
│  ├── terminal_execute with sudo                                 │
│  ├── file_delete                                                │
│  └── system_shutdown                                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 Browser Control Abstraction

#### 5.3.1 The Abstraction Problem

BrowserX currently uses `chrome.debugger` API which is only available in extension context. PI native mode needs to use Chrome DevTools Protocol (CDP) directly. The core DOM manipulation logic must work with both.

#### 5.3.2 Abstraction Layer Design

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER CONTROL ABSTRACTION                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    ┌─────────────────────┐                      │
│                    │  BrowserController  │ (Interface)          │
│                    │  ─────────────────  │                      │
│                    │  + navigate(url)    │                      │
│                    │  + click(selector)  │                      │
│                    │  + type(sel, text)  │                      │
│                    │  + screenshot()     │                      │
│                    │  + evaluate(script) │                      │
│                    │  + waitFor(cond)    │                      │
│                    └──────────┬──────────┘                      │
│                               │                                  │
│              ┌────────────────┴────────────────┐                │
│              │                                 │                │
│              ▼                                 ▼                │
│  ┌───────────────────────────┐   ┌───────────────────────────┐ │
│  │ ExtensionBrowserController│   │ CDPBrowserController      │ │
│  │ ─────────────────────────│   │ ─────────────────────────│ │
│  │ Uses:                     │   │ Uses:                     │ │
│  │ • chrome.debugger API     │   │ • puppeteer-core          │ │
│  │ • chrome.tabs API         │   │ • Profile copying         │ │
│  │                           │   │ • Direct CDP WebSocket    │ │
│  └───────────────────────────┘   └───────────────────────────┘ │
│              ▲                                 ▲                │
│              │                                 │                │
│         Extension                         Native App           │
│         Context                           Context              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.3.3 CDP Connection Management (Native Mode) - Profile Copy Strategy

In native mode, PI launches Chrome with debugging enabled using a **copied user profile**. This allows:
- User's regular Chrome to remain open
- PI's Chrome to have all user's login sessions and cookies
- Full CDP access without requiring user to do anything special

```
┌─────────────────────────────────────────────────────────────────┐
│                    PI BROWSER LAUNCH FLOW                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User: "Check my Amazon orders"                                 │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Step 1: Copy Essential Profile Data (2-10 seconds)       │   │
│  │ ─────────────────────────────────────────────────────── │   │
│  │ Source: ~/Library/Application Support/Google/Chrome/     │   │
│  │ Target: ~/.pi/chrome-profile/                           │   │
│  │                                                           │   │
│  │ Copy: Cookies, Login Data, Local Storage, Preferences    │   │
│  │ Skip: Cache, History, GPUCache (saves time & space)      │   │
│  └─────────────────────────────────────────────────────────┘   │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Step 2: Launch Chrome with Debugging                     │   │
│  │ ─────────────────────────────────────────────────────── │   │
│  │ chrome --remote-debugging-port=9222 \                    │   │
│  │        --user-data-dir=~/.pi/chrome-profile             │   │
│  └─────────────────────────────────────────────────────────┘   │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Step 3: Connect via CDP                                  │   │
│  │ ─────────────────────────────────────────────────────── │   │
│  │ puppeteer.connect({ browserURL: 'http://localhost:9222' })│   │
│  └─────────────────────────────────────────────────────────┘   │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐                    ┌─────────────┐            │
│  │ User's      │  Both run          │ PI's       │            │
│  │ Chrome      │  simultaneously!   │ Chrome      │            │
│  │ (untouched) │                    │ (controlled)│            │
│  │             │                    │ Logged into │            │
│  │             │                    │ Amazon! ✓   │            │
│  └─────────────┘                    └─────────────┘            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.3.4 Profile Copy Strategy

**Chrome Profile Contents & Copy Strategy:**

```
User's Chrome Profile (~/Library/Application Support/Google/Chrome/Default/)
│
├── ESSENTIAL (Copy These) ─────────────────────────────────────────
│   ├── Cookies              ~1-10 MB    Login sessions
│   ├── Cookies-journal      ~1 MB       Cookie transaction log
│   ├── Login Data           ~1-5 MB     Saved passwords (encrypted)
│   ├── Login Data-journal   ~1 MB       Password transaction log
│   ├── Web Data             ~1-5 MB     Autofill data
│   ├── Preferences          ~1 MB       Browser settings
│   ├── Secure Preferences   ~1 MB       Secure settings
│   ├── Bookmarks            ~1 MB       User bookmarks
│   ├── Local Storage/       ~10-100 MB  Site-specific storage
│   ├── Session Storage/     ~1-10 MB    Temporary session data
│   └── IndexedDB/           ~10-500 MB  Web app databases
│
├── SKIP (Not Needed) ──────────────────────────────────────────────
│   ├── Cache/               ~500MB-5GB  Cached files (huge!)
│   ├── Code Cache/          ~100-500 MB JS compilation cache
│   ├── GPUCache/            ~10-50 MB   GPU shader cache
│   ├── History              ~10-100 MB  Browsing history
│   ├── Visited Links        ~1-10 MB    Link visit tracking
│   └── ShaderCache/         ~10-50 MB   WebGL shader cache
│
└── ALSO COPY (From Parent Directory) ──────────────────────────────
    └── Local State          ~1 MB       Encryption keys (required!)
```

**Copy Time Estimates (SSD):**

| Profile Type | Essential Size | Copy Time |
|--------------|---------------|-----------|
| Light user   | ~100-200 MB   | 2-5 sec   |
| Medium user  | ~200-500 MB   | 5-10 sec  |
| Heavy user   | ~500MB-1GB    | 10-20 sec |

#### 5.3.5 Profile Manager Implementation

```typescript
// src/pi/tools/browser/profile-manager.ts

import { copyFile, mkdir, cp, stat } from 'fs/promises';
import { join } from 'path';
import { platform, homedir } from 'os';

const CHROME_PROFILE_PATHS: Record<string, string> = {
  darwin: `${homedir()}/Library/Application Support/Google/Chrome`,
  win32: `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`,
  linux: `${homedir()}/.config/google-chrome`
};

const PI_PROFILE_PATH = `${homedir()}/.pi/chrome-profile`;

const ESSENTIAL_ITEMS = [
  // Files (login sessions, passwords, settings)
  'Cookies',
  'Cookies-journal',
  'Login Data',
  'Login Data-journal',
  'Web Data',
  'Web Data-journal',
  'Preferences',
  'Secure Preferences',
  'Bookmarks',
  // Directories (site data)
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'databases',
];

export interface ProfileCopyResult {
  path: string;
  duration: number;
  sizeBytes: number;
}

export async function copyUserProfile(): Promise<ProfileCopyResult> {
  const startTime = Date.now();
  const sourceProfile = join(CHROME_PROFILE_PATHS[platform()], 'Default');
  const targetProfile = join(PI_PROFILE_PATH, 'Default');

  // Create target directory
  await mkdir(targetProfile, { recursive: true });

  let totalSize = 0;

  // Copy essential items
  for (const item of ESSENTIAL_ITEMS) {
    const sourcePath = join(sourceProfile, item);
    const targetPath = join(targetProfile, item);

    try {
      const stats = await stat(sourcePath);
      if (stats.isDirectory()) {
        await cp(sourcePath, targetPath, { recursive: true });
      } else {
        await copyFile(sourcePath, targetPath);
      }
      totalSize += await calculateSize(sourcePath);
    } catch (err) {
      // File might not exist or be locked, skip it
      console.warn(`Skipping ${item}: ${(err as Error).message}`);
    }
  }

  // Copy Local State (encryption keys) from parent directory
  try {
    await copyFile(
      join(CHROME_PROFILE_PATHS[platform()], 'Local State'),
      join(PI_PROFILE_PATH, 'Local State')
    );
  } catch (err) {
    console.warn('Could not copy Local State:', (err as Error).message);
  }

  return {
    path: PI_PROFILE_PATH,
    duration: Date.now() - startTime,
    sizeBytes: totalSize
  };
}

async function calculateSize(path: string): Promise<number> {
  const stats = await stat(path);
  if (!stats.isDirectory()) return stats.size;

  const { readdir } = await import('fs/promises');
  const entries = await readdir(path, { withFileTypes: true });
  let size = 0;
  for (const entry of entries) {
    size += await calculateSize(join(path, entry.name));
  }
  return size;
}
```

#### 5.3.6 Browser Detection & Multi-Browser Support

PI supports Chrome as the primary browser, with Edge as fallback on Windows. The detection strategy:

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER DETECTION FLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Check default installation paths                            │
│     ├── macOS: /Applications/Google Chrome.app/                 │
│     ├── Windows: C:\Program Files\Google\Chrome\                │
│     └── Linux: /usr/bin/google-chrome                           │
│                                                                  │
│  2. If not found, search via terminal command                   │
│     ├── macOS: mdfind "kMDItemCFBundleIdentifier == ..."       │
│     ├── Windows: where chrome.exe / reg query                   │
│     └── Linux: which google-chrome / whereis                    │
│                                                                  │
│  3. If Chrome not found:                                        │
│     ├── Windows: Fall back to Microsoft Edge (supports CDP)     │
│     └── macOS/Linux: Prompt user to install Chrome              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Platform-Specific Browser Support:**

| Platform | Primary | Fallback | Notes |
|----------|---------|----------|-------|
| macOS | Chrome | None (prompt to install) | Safari doesn't support CDP |
| Windows | Chrome | Microsoft Edge | Edge uses Chromium, full CDP support |
| Linux | Chrome/Chromium | Chromium | Both work with CDP |

#### 5.3.7 Chrome Launcher Implementation

```typescript
// src/pi/tools/browser/browser-detector.ts

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';

interface BrowserInfo {
  name: 'chrome' | 'edge' | 'chromium';
  path: string;
  profilePath: string;
}

const DEFAULT_PATHS: Record<string, Record<string, string>> = {
  darwin: {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  win32: {
    chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  },
  linux: {
    chrome: '/usr/bin/google-chrome',
    chromium: '/usr/bin/chromium-browser',
  }
};

const PROFILE_PATHS: Record<string, Record<string, string>> = {
  darwin: {
    chrome: `${process.env.HOME}/Library/Application Support/Google/Chrome`,
  },
  win32: {
    chrome: `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`,
    edge: `${process.env.LOCALAPPDATA}/Microsoft/Edge/User Data`,
  },
  linux: {
    chrome: `${process.env.HOME}/.config/google-chrome`,
    chromium: `${process.env.HOME}/.config/chromium`,
  }
};

export async function detectBrowser(): Promise<BrowserInfo | null> {
  const os = platform();
  const paths = DEFAULT_PATHS[os];
  const profiles = PROFILE_PATHS[os];

  // 1. Check default Chrome path first
  if (paths.chrome && existsSync(paths.chrome)) {
    return { name: 'chrome', path: paths.chrome, profilePath: profiles.chrome };
  }

  // 2. Search for Chrome via terminal
  const searchedChrome = await searchForBrowser('chrome', os);
  if (searchedChrome) {
    return { name: 'chrome', path: searchedChrome, profilePath: profiles.chrome };
  }

  // 3. Platform-specific fallbacks
  if (os === 'win32') {
    // Windows: Try Edge as fallback
    if (paths.edge && existsSync(paths.edge)) {
      return { name: 'edge', path: paths.edge, profilePath: profiles.edge };
    }
  }

  if (os === 'linux') {
    // Linux: Try Chromium as fallback
    if (paths.chromium && existsSync(paths.chromium)) {
      return { name: 'chromium', path: paths.chromium, profilePath: profiles.chromium };
    }
  }

  // 4. Not found
  return null;
}

async function searchForBrowser(browser: string, os: string): Promise<string | null> {
  try {
    let command: string;

    switch (os) {
      case 'darwin':
        // macOS: Use Spotlight search
        command = `mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" | head -1`;
        const appPath = execSync(command, { encoding: 'utf-8' }).trim();
        return appPath ? `${appPath}/Contents/MacOS/Google Chrome` : null;

      case 'win32':
        // Windows: Search in registry or use where command
        command = 'where chrome.exe 2>nul';
        return execSync(command, { encoding: 'utf-8' }).trim().split('\n')[0] || null;

      case 'linux':
        // Linux: Use which/whereis
        command = 'which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null';
        return execSync(command, { encoding: 'utf-8' }).trim() || null;

      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function getBrowserNotFoundMessage(): string {
  const os = platform();

  if (os === 'darwin') {
    return 'Chrome not found. Please install Google Chrome from https://www.google.com/chrome/';
  } else if (os === 'win32') {
    return 'Neither Chrome nor Edge found. Please install Google Chrome from https://www.google.com/chrome/';
  } else {
    return 'Chrome/Chromium not found. Please install: sudo apt install google-chrome-stable';
  }
}
```

```typescript
// src/pi/tools/browser/chrome-launcher.ts

import { spawn } from 'child_process';
import { detectBrowser, getBrowserNotFoundMessage, BrowserInfo } from './browser-detector';

const DEFAULT_DEBUG_PORT = 9222;

export interface LaunchOptions {
  port?: number;
  userDataDir: string;
  headless?: boolean;
}

export async function launchBrowserWithDebugging(
  options: LaunchOptions
): Promise<{ port: number; browser: BrowserInfo }> {
  const port = options.port ?? DEFAULT_DEBUG_PORT;

  // Detect available browser
  const browser = await detectBrowser();
  if (!browser) {
    throw new Error(getBrowserNotFoundMessage());
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.userDataDir}`,
  ];

  if (options.headless) {
    args.push('--headless=new');
  }

  const process = spawn(browser.path, args, {
    detached: true,
    stdio: 'ignore'
  });

  process.unref(); // Let browser run independently of PI

  // Wait for debugger to be ready
  await waitForDebugger(port);

  return { port, browser };
}

async function waitForDebugger(port: number, timeout = 15000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/json/version`);
      if (response.ok) {
        return; // Debugger is ready
      }
    } catch {
      // Not ready yet, retry
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`Browser debugger not ready after ${timeout}ms`);
}

export async function isDebuggerAvailable(port = DEFAULT_DEBUG_PORT): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}
```

#### 5.3.8 CDP Browser Controller

```typescript
// src/pi/tools/browser/cdp-controller.ts

import puppeteer, { Browser, Page } from 'puppeteer-core';
import { copyUserProfile, ProfileCopyResult } from './profile-manager';
import { launchChromeWithDebugging, isDebuggerAvailable } from './chrome-launcher';

export class CDPBrowserController implements BrowserController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private port: number;

  constructor(port = 9222) {
    this.port = port;
  }

  async initialize(): Promise<ProfileCopyResult> {
    // Check if already connected
    if (await isDebuggerAvailable(this.port)) {
      await this.connect();
      return { path: '', duration: 0, sizeBytes: 0 };
    }

    // Copy user profile
    console.log('Copying browser profile...');
    const result = await copyUserProfile();
    console.log(`Profile copied: ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB in ${result.duration}ms`);

    // Launch Chrome with debugging
    console.log('Launching browser...');
    await launchChromeWithDebugging({
      port: this.port,
      userDataDir: result.path
    });

    // Connect
    await this.connect();

    return result;
  }

  private async connect(): Promise<void> {
    this.browser = await puppeteer.connect({
      browserURL: `http://localhost:${this.port}`
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('Not connected');
    await this.page.goto(url, { waitUntil: 'networkidle2' });
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error('Not connected');
    await this.page.click(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.page) throw new Error('Not connected');
    await this.page.type(selector, text);
  }

  async screenshot(): Promise<Buffer> {
    if (!this.page) throw new Error('Not connected');
    return await this.page.screenshot() as Buffer;
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    if (!this.page) throw new Error('Not connected');
    return await this.page.evaluate(fn);
  }

  async getSnapshot(): Promise<SerializedDOM> {
    if (!this.page) throw new Error('Not connected');

    // Create CDP session for advanced access
    const client = await this.page.target().createCDPSession();

    // Get DOM tree
    const { root } = await client.send('DOM.getDocument', { depth: -1 });

    // Get accessibility tree
    const { nodes } = await client.send('Accessibility.getFullAXTree');

    // Build snapshot using existing DomSnapshot logic
    // ... (port from existing implementation)

    return { /* serialized DOM */ } as SerializedDOM;
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      this.browser.disconnect(); // Disconnect without closing Chrome
      this.browser = null;
      this.page = null;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close(); // Close Chrome entirely
      this.browser = null;
      this.page = null;
    }
  }
}
```

#### 5.3.9 CDP vs chrome.debugger Differences

| Aspect | chrome.debugger (Extension) | CDP (Native PI) |
|--------|----------------------------|------------------|
| Connection | Automatic via extension | WebSocket to debugging port |
| Profile | User's active profile | Copied profile (snapshot) |
| Tab management | `chrome.tabs` API | CDP `Target` domain |
| Authentication | Extension permissions | No auth (localhost only) |
| Events | Extension event listeners | CDP event subscriptions |
| Lifecycle | Managed by browser | PI manages Chrome process |
| User's Chrome | Same instance | Separate instance (both can run) |

#### 5.3.10 Important Caveats

**1. Profile is a Snapshot**
The copied profile represents the user's data at the time of copy. New logins or cookies added to the user's main Chrome won't appear in PI's Chrome until the next profile copy.

**2. Session Conflicts (Rare)**
Some security-sensitive sites (banking, etc.) may detect concurrent sessions from the same account and log out one instance. Most sites handle this fine.

**3. Password Decryption**
Chrome encrypts saved passwords using OS-level encryption. Decryption works as long as PI runs as the same OS user:

| Platform | Encryption | Works with Copy? |
|----------|-----------|------------------|
| macOS | Keychain | ✅ Yes (same user) |
| Windows | DPAPI | ✅ Yes (same user) |
| Linux | gnome-keyring/kwallet | ✅ Yes (same user) |

**4. File Locking on Windows**
Windows has more aggressive file locking. The profile copy may need retry logic for locked files:

```typescript
async function copyWithRetry(source: string, target: string, maxRetries = 3): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await copyFile(source, target);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EBUSY' && i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 100 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}
```

#### 5.3.11 DomTool Migration Strategy

The goal is to **reuse existing DomService logic as much as possible**, only replacing the `chrome.debugger` API calls with CDP equivalents. This requires a middle abstraction layer.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    DOMTOOL ABSTRACTION LAYER                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    ┌─────────────────────┐                      │
│                    │     DomService      │  (Existing logic)    │
│                    │  ─────────────────  │                      │
│                    │  • getSnapshot()    │                      │
│                    │  • click()          │                      │
│                    │  • type()           │                      │
│                    │  • scroll()         │                      │
│                    └──────────┬──────────┘                      │
│                               │                                  │
│                               │ Uses                             │
│                               ▼                                  │
│                    ┌─────────────────────┐                      │
│                    │  DebuggerClient     │  (NEW: Abstraction)  │
│                    │  ─────────────────  │                      │
│                    │  • sendCommand()    │                      │
│                    │  • onEvent()        │                      │
│                    │  • attach()         │                      │
│                    │  • detach()         │                      │
│                    └──────────┬──────────┘                      │
│                               │                                  │
│              ┌────────────────┴────────────────┐                │
│              │                                 │                │
│              ▼                                 ▼                │
│  ┌───────────────────────────┐   ┌───────────────────────────┐ │
│  │ ChromeDebuggerClient      │   │ CDPDebuggerClient         │ │
│  │ ─────────────────────────│   │ ─────────────────────────│ │
│  │ chrome.debugger.attach()  │   │ puppeteer CDPSession      │ │
│  │ chrome.debugger.sendCmd() │   │ client.send()             │ │
│  │ chrome.debugger.onEvent   │   │ client.on()               │ │
│  └───────────────────────────┘   └───────────────────────────┘ │
│              ▲                                 ▲                │
│              │                                 │                │
│         Extension                         Native PI           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation Steps:**

1. **Define DebuggerClient Interface**
```typescript
// src/core/tools/dom/debugger-client.ts

export interface DebuggerClient {
  attach(target: { tabId: number } | { page: Page }): Promise<void>;
  detach(): Promise<void>;
  sendCommand<T>(method: string, params?: object): Promise<T>;
  onEvent(callback: (method: string, params: any) => void): void;
  isAttached(): boolean;
}
```

2. **Create ChromeDebuggerClient (Extension)**
```typescript
// src/extension/tools/dom/chrome-debugger-client.ts

export class ChromeDebuggerClient implements DebuggerClient {
  private tabId: number | null = null;

  async attach(target: { tabId: number }): Promise<void> {
    this.tabId = target.tabId;
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
  }

  async sendCommand<T>(method: string, params?: object): Promise<T> {
    return await chrome.debugger.sendCommand(
      { tabId: this.tabId! },
      method,
      params
    ) as T;
  }

  onEvent(callback: (method: string, params: any) => void): void {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === this.tabId) {
        callback(method, params);
      }
    });
  }
  // ...
}
```

3. **Create CDPDebuggerClient (Native)**
```typescript
// src/pi/tools/dom/cdp-debugger-client.ts

import { CDPSession, Page } from 'puppeteer-core';

export class CDPDebuggerClient implements DebuggerClient {
  private client: CDPSession | null = null;

  async attach(target: { page: Page }): Promise<void> {
    this.client = await target.page.target().createCDPSession();
  }

  async sendCommand<T>(method: string, params?: object): Promise<T> {
    return await this.client!.send(method as any, params) as T;
  }

  onEvent(callback: (method: string, params: any) => void): void {
    this.client!.on('*', (event: any) => {
      callback(event.method, event.params);
    });
  }
  // ...
}
```

4. **Update DomService to Use DebuggerClient**
```typescript
// src/core/tools/dom/DomService.ts

export class DomService {
  private client: DebuggerClient;

  constructor(client: DebuggerClient) {
    this.client = client;  // Injected - works with both implementations
  }

  async getSnapshot(): Promise<DomSnapshot> {
    // Existing logic unchanged, just use this.client instead of chrome.debugger
    const { root } = await this.client.sendCommand('DOM.getDocument', { depth: -1 });
    const { nodes } = await this.client.sendCommand('Accessibility.getFullAXTree');
    // ... rest of existing logic
  }

  async click(nodeId: number): Promise<void> {
    const { model } = await this.client.sendCommand('DOM.getBoxModel', { nodeId });
    // ... existing click logic
  }
}
```

**Key Benefits:**
- Existing `DomService`, `DomSnapshot`, serialization pipeline remain **unchanged**
- Only the debugger communication layer is swapped
- Unit tests for `DomService` work with mock `DebuggerClient`

#### 5.3.12 Error Handling & Retry Strategy

PI implements a retry-first approach for browser control failures:

```typescript
// src/pi/tools/browser/resilient-controller.ts

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export class ResilientBrowserController {
  private controller: CDPBrowserController;

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        console.warn(`${operationName} failed (attempt ${attempt}/${MAX_RETRIES}):`, error);

        if (attempt < MAX_RETRIES) {
          // Check if it's a connection issue
          if (this.isConnectionError(error)) {
            console.log('Attempting to reconnect...');
            await this.attemptReconnect();
          }
          await this.delay(RETRY_DELAY_MS * attempt);
        }
      }
    }

    // All retries failed - prompt user for manual intervention
    throw new BrowserControlError(
      `${operationName} failed after ${MAX_RETRIES} attempts. ` +
      `Please manually open Chrome with debugging: ` +
      `chrome --remote-debugging-port=9222`,
      lastError
    );
  }

  private isConnectionError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return (
      message.includes('not connected') ||
      message.includes('session closed') ||
      message.includes('target closed') ||
      message.includes('connection refused')
    );
  }

  private async attemptReconnect(): Promise<void> {
    try {
      await this.controller.disconnect();
      await this.controller.initialize();
    } catch {
      // Reconnect failed, will retry the whole operation
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

**Error Scenarios & Handling:**

| Scenario | Behavior |
|----------|----------|
| Profile copy fails | Retry up to 3 times, then prompt user |
| Chrome fails to launch | Check if already running, retry, then prompt |
| CDP connection drops | Auto-reconnect, retry operation |
| Chrome crashes | Detect via CDP events, re-launch and reconnect |
| All retries exhausted | Show user-friendly message with manual instructions |

#### 5.3.13 Extension + Native Coexistence

Currently, the Chrome extension (BrowserX) and native app (PI) are **separate products**:

- **BrowserX Extension**: Controls browser from inside, uses `chrome.debugger`
- **PI Native App**: Controls browser from outside, uses CDP with profile copy

**Current Design Decision**: No communication between them. They operate independently.

**Future Consideration**: If both are installed, PI could potentially communicate with the extension via WebSocket to leverage the extension's direct browser access. This would be designed separately when needed.

#### 5.3.14 Testing Strategy

**Unit Testing Approach:**

1. **Mock DebuggerClient for DomService tests**
```typescript
// tests/dom/DomService.test.ts

describe('DomService', () => {
  let mockClient: jest.Mocked<DebuggerClient>;
  let domService: DomService;

  beforeEach(() => {
    mockClient = {
      attach: jest.fn(),
      detach: jest.fn(),
      sendCommand: jest.fn(),
      onEvent: jest.fn(),
      isAttached: jest.fn().mockReturnValue(true),
    };
    domService = new DomService(mockClient);
  });

  it('should get DOM snapshot', async () => {
    mockClient.sendCommand
      .mockResolvedValueOnce({ root: mockDomTree })
      .mockResolvedValueOnce({ nodes: mockAxNodes });

    const snapshot = await domService.getSnapshot();

    expect(mockClient.sendCommand).toHaveBeenCalledWith('DOM.getDocument', { depth: -1 });
    expect(snapshot).toBeDefined();
  });
});
```

2. **Profile Copy tests** - Test on each platform's CI
3. **Browser Detection tests** - Mock file system and exec calls
4. **Integration tests** - Test with real Chrome in CI (headless mode)

### 5.4 MCP Integration

#### 5.4.1 Overview

Model Context Protocol (MCP) is a standard for LLM tool integration. PI acts as an MCP **client** that can connect to multiple MCP **servers**.

#### 5.4.2 MCP Client Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       MCP CLIENT                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    MCP Manager                           │    │
│  │  ─────────────────────────────────────────────────────  │    │
│  │  - Server registry                                       │    │
│  │  - Connection pool                                       │    │
│  │  - Tool schema cache                                     │    │
│  │  - Health monitoring                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                             │                                    │
│         ┌───────────────────┼───────────────────┐               │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │ MCP Server  │     │ MCP Server  │     │ MCP Server  │       │
│  │ Connection  │     │ Connection  │     │ Connection  │       │
│  │ ──────────  │     │ ──────────  │     │ ──────────  │       │
│  │ filesystem  │     │ git         │     │ custom      │       │
│  │ (stdio)     │     │ (stdio)     │     │ (HTTP/SSE)  │       │
│  └──────┬──────┘     └──────┬──────┘     └──────┬──────┘       │
│         │                   │                   │               │
└─────────┼───────────────────┼───────────────────┼───────────────┘
          │                   │                   │
          ▼                   ▼                   ▼
   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
   │   Server    │     │   Server    │     │   Server    │
   │   Process   │     │   Process   │     │   (Remote)  │
   │   (Local)   │     │   (Local)   │     │             │
   └─────────────┘     └─────────────┘     └─────────────┘
```

#### 5.4.3 MCP Server Configuration

```yaml
# ~/.pi/mcp-servers.yaml

servers:
  filesystem:
    command: "npx"
    args: ["-y", "@anthropic/mcp-server-filesystem", "/home/user"]
    transport: stdio
    auto_start: true

  git:
    command: "npx"
    args: ["-y", "@anthropic/mcp-server-git"]
    transport: stdio
    auto_start: true

  custom-db:
    url: "http://localhost:8080/mcp"
    transport: http+sse
    auto_start: false
```

#### 5.4.4 MCP Tool Discovery

On startup and periodically:

1. **Connect** to each configured MCP server
2. **Request** `tools/list` to get available tools
3. **Cache** tool schemas in Tool Registry
4. **Monitor** for schema changes via MCP notifications

#### 5.4.5 MCP Tool Execution Flow

```
1. LLM decides to call MCP tool "filesystem_read"
           │
           ▼
2. Tool Registry routes to MCP Manager
           │
           ▼
3. MCP Manager finds server for "filesystem_read"
           │
           ▼
4. Send JSON-RPC request to server via stdio/HTTP
           │
           ▼
5. Server executes and returns result
           │
           ▼
6. Result returned to Agent Runtime
```

### 5.5 Messaging Channel Adapters

These adapters implement the `ChannelAdapter` interface (Section 4.4) for external messaging platforms. Each converts platform-specific messages to `Op` submissions and sends `EventMsg` events back as replies.

#### 5.5.1 Telegram Channel

**Protocol**: Telegram Bot API with long polling

**Setup Requirements**:
1. Create bot via @BotFather
2. Get bot token
3. Configure allowed user IDs

**Technical Details**:
- Uses `node-telegram-bot-api` package
- Polling mode (no webhook server needed)
- Implements `ChannelAdapter` interface
- Supports text, images, documents
- Inline keyboard for approval requests

**Message Flow**:
```
Telegram Servers ──(poll)──► TelegramChannel (ChannelAdapter)
                                      │
                              Parse message
                                      │
                              Create Op: UserTurn
                                      │
                              ChannelManager.handleSubmission()
                                      │
                              [Agent processes, emits EventMsg]
                                      │
                              EventMsg → Telegram reply
                                      │
User's Telegram App ◄────────────────┘
```

#### 5.5.2 WhatsApp Channel

**Protocol**: WhatsApp Web protocol (unofficial)

**Library**: `whatsapp-web.js`

**Setup Requirements**:
1. Scan QR code with WhatsApp mobile app
2. Session persisted locally

**Technical Details**:
- Uses Puppeteer internally to run WhatsApp Web
- Maintains persistent session in `~/.pi/whatsapp-session/`
- Can send/receive text, images, documents
- Risk: Against WhatsApp ToS, may break with updates

**Limitations**:
- Requires Puppeteer (Chromium) running
- Session can expire, need re-auth
- Cannot use same WhatsApp account elsewhere on web

#### 5.5.3 iMessage Channel (macOS Only)

**Protocol**: Direct database access + AppleScript

**Setup Requirements**:
1. macOS with Messages.app configured
2. Full Disk Access permission for PI

**Technical Details**:
- Reads `~/Library/Messages/chat.db` (SQLite)
- Polls for new messages every 5 seconds
- Sends via AppleScript to Messages.app
- Must handle database locked scenarios

**Limitations**:
- macOS only
- Requires Full Disk Access (security prompt)
- AppleScript can be slow
- Cannot send rich media easily

#### 5.5.4 Google Calendar Channel

**Protocol**: Google Calendar API v3

**Setup Requirements**:
1. Google Cloud project with Calendar API enabled
2. OAuth consent screen configured
3. User authorizes PI to read calendar

**Technical Details**:
- Polls upcoming events every 30 seconds
- Looks for events with specific prefix (e.g., "PI:")
- Event description contains the command to execute
- Can optionally delete/update event after execution

**Event Format**:
```
Title: PI: Summarize my emails
Description: Send summary to my Telegram
Start: 2026-02-02 09:00
```

### 5.6 Storage Layer

#### 5.6.1 Storage Abstraction

The storage layer provides a unified interface that abstracts away platform-specific storage implementations. This allows the core agent logic to remain agnostic of the underlying storage mechanism.

```
┌─────────────────────────────────────────────────────────────────┐
│                    STORAGE ABSTRACTION                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    ┌─────────────────────┐                      │
│                    │   StorageProvider   │ (Interface)          │
│                    │   ────────────────  │                      │
│                    │   + get(key)        │                      │
│                    │   + set(key, value) │                      │
│                    │   + delete(key)     │                      │
│                    │   + list(prefix)    │                      │
│                    │   + query(filter)   │                      │
│                    │   + transaction()   │                      │
│                    └──────────┬──────────┘                      │
│                               │                                  │
│              ┌────────────────┴────────────────┐                │
│              │                                 │                │
│              ▼                                 ▼                │
│  ┌───────────────────────────┐   ┌───────────────────────────┐ │
│  │ IndexedDBStorage          │   │ SQLiteStorage             │ │
│  │ Provider                  │   │ Provider                  │ │
│  │ ─────────────────────────│   │ ─────────────────────────│ │
│  │ Uses: IndexedDB API       │   │ Uses: better-sqlite3 or   │ │
│  │ + chrome.storage for      │   │       sql.js (WASM)       │ │
│  │   sync settings           │   │                           │ │
│  └───────────────────────────┘   └───────────────────────────┘ │
│              ▲                                 ▲                │
│              │                                 │                │
│         Chrome Extension                  Native App           │
│         (browser environment)             (Node.js/Tauri)      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.6.2 Platform-Specific Implementations

##### IndexedDB Provider (Chrome Extension)

The Chrome extension uses IndexedDB as the primary storage backend due to its:
- Native browser support (no additional dependencies)
- Asynchronous API that doesn't block the UI
- Large storage capacity (typically 50% of available disk space)
- Structured data support with indexes for efficient queries

```
IndexedDBStorageProvider {
  // Database structure
  databases:
    - pax_main
      - stores:
        - conversations    (keyPath: id, indexes: [userId, timestamp])
        - messages        (keyPath: id, indexes: [conversationId, timestamp])
        - memory          (keyPath: id, indexes: [type, embedding])
        - settings        (keyPath: key)
        - cache           (keyPath: key, indexes: [expiresAt])

  // chrome.storage.sync for cross-device settings
  syncedSettings:
    - user preferences
    - LLM provider configs (excluding API keys)
    - channel configurations
}
```

**Implementation Notes**:
- Use `idb` wrapper library for Promise-based API
- Implement migration system for schema changes
- Use `chrome.storage.sync` only for small, user-facing settings (max 8KB per item)
- Store API keys in `chrome.storage.local` (encrypted at rest by Chrome)

##### SQLite Provider (Native App)

The native desktop application uses SQLite for its:
- Excellent performance for local data
- Full SQL query support for complex data retrieval
- Single-file database for easy backup/migration
- Mature tooling and debugging support

```
SQLiteStorageProvider {
  // Database location
  path: ~/.pi/data/pi.db

  // Schema
  tables:
    - conversations (id, user_id, title, created_at, updated_at)
    - messages (id, conversation_id, role, content, tool_calls, timestamp)
    - memory (id, type, content, embedding BLOB, created_at)
    - settings (key PRIMARY KEY, value JSON, updated_at)
    - cache (key PRIMARY KEY, value BLOB, expires_at)
    - credentials (key PRIMARY KEY, value_encrypted BLOB)

  // Indexes for performance
  indexes:
    - idx_messages_conversation_id
    - idx_messages_timestamp
    - idx_memory_type
    - idx_cache_expires_at
}
```

**Implementation Notes**:
- Use `better-sqlite3` for synchronous API in Node.js
- Enable WAL mode for better concurrent read performance
- Implement automatic vacuum and optimization
- Support encryption via SQLCipher for sensitive deployments

#### 5.6.3 Storage Interface Definition

```typescript
interface StorageProvider {
  // Basic CRUD operations
  get<T>(collection: string, key: string): Promise<T | null>;
  set<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;

  // Bulk operations
  getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>>;
  setMany<T>(collection: string, entries: Map<string, T>): Promise<void>;
  deleteMany(collection: string, keys: string[]): Promise<void>;

  // Query operations
  list<T>(collection: string, options?: ListOptions): Promise<T[]>;
  query<T>(collection: string, filter: QueryFilter): Promise<T[]>;
  count(collection: string, filter?: QueryFilter): Promise<number>;

  // Transaction support
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // Maintenance
  clear(collection: string): Promise<void>;
  vacuum(): Promise<void>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}

interface ListOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
}

interface QueryFilter {
  where?: Record<string, any>;
  orderBy?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
```

#### 5.6.4 Storage Factory

```typescript
// src/core/storage/index.ts

import type { StorageProvider } from './interface';

export async function createStorageProvider(): Promise<StorageProvider> {
  if (__BUILD_MODE__ === 'extension') {
    const { IndexedDBStorageProvider } = await import('./indexeddb');
    const provider = new IndexedDBStorageProvider();
    await provider.initialize();
    return provider;
  } else {
    const { SQLiteStorageProvider } = await import('./sqlite');
    const provider = new SQLiteStorageProvider({
      path: path.join(getDataDir(), 'pi.db'),
      walMode: true,
    });
    await provider.initialize();
    return provider;
  }
}
```

#### 5.6.5 Storage Categories

| Category | Content | Extension (IndexedDB) | Native (SQLite) |
|----------|---------|----------------------|-----------------|
| **Settings** | User preferences, UI state | `settings` store + `chrome.storage.sync` | `settings` table |
| **Conversations** | Chat history, context | `conversations` + `messages` stores | `conversations` + `messages` tables |
| **Credentials** | API keys, OAuth tokens | `chrome.storage.local` (encrypted) | OS Keychain via `keytar` |
| **Cache** | LLM response cache, tool results | `cache` store with TTL index | `cache` table with expiry |
| **Memory** | Long-term agent memory, embeddings | `memory` store | `memory` table with vector support |

#### 5.6.6 Secure Credential Storage

For sensitive data (API keys, tokens), each platform uses its native secure storage:

**Chrome Extension**:
- Uses `chrome.storage.local` which is encrypted at rest by Chrome
- Isolated per-extension, inaccessible to other extensions or websites
- Automatically backed up if user enables Chrome sync (optional)

**Native App**:

| Platform | Storage Mechanism | Library |
|----------|-------------------|---------|
| macOS | Keychain | `keytar` |
| Windows | Credential Manager | `keytar` |
| Linux | Secret Service (libsecret) | `keytar` |

```typescript
// src/core/storage/credentials.ts

interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, password: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

// Extension implementation uses chrome.storage.local
// Native implementation uses keytar for OS-level secure storage
```

#### 5.6.7 Data Migration

When users transition between extension and native app, or when upgrading versions:

```
┌─────────────────────────────────────────────────────────────────┐
│                    DATA MIGRATION FLOW                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Extension → Native App Migration:                              │
│  ────────────────────────────────                               │
│  1. Export IndexedDB data to JSON via extension                 │
│  2. Native app imports JSON into SQLite                         │
│  3. Credentials manually re-entered (security best practice)    │
│                                                                  │
│  Version Upgrades:                                               │
│  ────────────────                                                │
│  1. Check schema version in storage                              │
│  2. Run migration scripts sequentially                           │
│  3. Update schema version                                        │
│  4. Backup original data before destructive migrations          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.7 LLM Router

#### 5.7.1 Purpose

Manage connections to multiple LLM providers, handle routing, fallback, and rate limiting.

#### 5.7.2 Supported Providers

| Provider | SDK/Protocol | Models |
|----------|--------------|--------|
| OpenAI | openai SDK | gpt-4o, gpt-4-turbo, gpt-3.5-turbo |
| Anthropic | anthropic SDK | claude-3-opus, claude-3-sonnet, claude-3-haiku |
| Google | google-generativeai | gemini-pro, gemini-ultra |
| Fireworks | OpenAI-compatible | Various open models |
| Ollama | OpenAI-compatible | Local models |
| Custom | OpenAI-compatible | User-specified endpoints |

#### 5.7.3 Routing Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| **Primary** | Always use configured primary provider | Simple setup |
| **Fallback** | Try primary, fall back to secondary on error | Reliability |
| **Cost-Optimized** | Route based on task complexity | Cost savings |
| **Latency-Optimized** | Route to fastest available provider | Speed |

---

## 6. Build System

### 6.1 Dual Build Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      SOURCE STRUCTURE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  src/                                                            │
│  ├── core/                    # Shared code (both modes)        │
│  │   ├── agent/               # Agent runtime                   │
│  │   ├── channels/            # Channel abstractions            │
│  │   │   ├── ChannelAdapter.ts      # Interface                 │
│  │   │   ├── ChannelManager.ts      # Orchestrator              │
│  │   │   └── index.ts               # Factory                   │
│  │   ├── llm/                 # LLM router                      │
│  │   ├── tools/               # Tool registry + built-ins       │
│  │   │   ├── browser/                                           │
│  │   │   │   ├── interface.ts       # Abstract interface        │
│  │   │   │   ├── extension.ts       # chrome.debugger impl      │
│  │   │   │   └── cdp.ts             # puppeteer-core impl       │
│  │   │   └── ...                                                │
│  │   ├── storage/             # Storage abstraction             │
│  │   │   ├── interface.ts           # StorageProvider interface │
│  │   │   ├── indexeddb.ts           # IndexedDB impl (extension)│
│  │   │   ├── sqlite.ts              # SQLite impl (native)      │
│  │   │   ├── credentials.ts         # Secure credential storage │
│  │   │   └── migrations/            # Schema migration scripts  │
│  │   └── types/               # Shared types                    │
│  │                                                               │
│  ├── extension/               # Chrome extension specific       │
│  │   ├── manifest.json                                          │
│  │   ├── background.ts        # Service worker                  │
│  │   ├── content.ts           # Content scripts                 │
│  │   ├── channels/            # Extension channel adapters      │
│  │   │   ├── SidePanelChannel.ts                                │
│  │   │   └── TabPageChannel.ts                                  │
│  │   ├── popup/               # Popup UI (Svelte)               │
│  │   └── sidepanel/           # Side panel UI (Svelte)          │
│  │                                                               │
│  └── pi/                      # Native app specific             │
│      ├── main.ts              # Entry point                     │
│      ├── daemon.ts            # Background service              │
│      ├── tray.ts              # System tray (Tauri)             │
│      ├── cli.ts               # TUI entry                       │
│      ├── channels/            # Channel adapters                │
│      │   ├── TauriChannel.ts                                    │
│      │   ├── WebSocketChannel.ts                                │
│      │   ├── TelegramChannel.ts                                 │
│      │   ├── WhatsAppChannel.ts                                 │
│      │   └── ...                                                │
│      ├── tools/               # Native-only tools               │
│      │   ├── terminal.ts                                        │
│      │   └── mcp-client.ts                                      │
│      └── ui/                  # Tauri GUI (Svelte)              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Build Configurations

#### 6.2.1 Extension Build

```
vite.config.extension.ts
├── Entry: src/extension/background.ts
├── Output: dist/extension/
├── Target: Chrome Extension (Manifest V3)
├── Excludes: src/pi/**
└── Defines: __BUILD_MODE__ = 'extension'
```

#### 6.2.2 PI GUI Build (Tauri)

```
vite.config.pi-gui.ts
├── Entry: src/pi/main.ts
├── Output: dist/pi-gui/
├── Target: Tauri application
├── Excludes: src/extension/**
├── Includes: Tauri Rust backend
└── Defines: __BUILD_MODE__ = 'native'
```

#### 6.2.3 PI CLI Build

```
vite.config.pi-cli.ts
├── Entry: src/pi/cli.ts
├── Output: dist/pi-cli/
├── Target: Node.js executable
├── Excludes: src/extension/**, src/pi/ui/**
├── Bundled with: pkg or esbuild
└── Defines: __BUILD_MODE__ = 'native'
```

### 6.3 NPM Scripts

```json
{
  "scripts": {
    "dev": "vite --config vite.config.extension.ts",
    "dev:pi": "tauri dev",
    "dev:cli": "ts-node src/pi/cli.ts",

    "build": "vite build --config vite.config.extension.ts",
    "build:pi": "tauri build",
    "build:cli": "esbuild src/pi/cli.ts --bundle --platform=node --outfile=dist/pi-cli/pi.js",

    "test": "vitest",
    "test:e2e:extension": "playwright test --config=playwright.extension.config.ts",
    "test:e2e:pax": "playwright test --config=playwright.pax.config.ts"
  }
}
```

### 6.4 Conditional Imports

Use build-time constants to tree-shake platform-specific code:

```typescript
// src/core/tools/browser/index.ts

import type { BrowserController } from './interface';

export async function createBrowserController(): Promise<BrowserController> {
  if (__BUILD_MODE__ === 'extension') {
    const { ExtensionBrowserController } = await import('./extension');
    return new ExtensionBrowserController();
  } else {
    const { CDPBrowserController } = await import('./cdp');
    return new CDPBrowserController();
  }
}
```

---

## 7. Platform Considerations

### 7.1 macOS

#### 6.1.1 Permissions Required

| Permission | Purpose | How to Request |
|------------|---------|----------------|
| Accessibility | Global hotkeys, UI automation | System Preferences prompt |
| Full Disk Access | iMessage integration, file access | System Preferences prompt |
| Screen Recording | Screenshot tool | System Preferences prompt |
| Automation | AppleScript for iMessage | Per-app prompt |

#### 6.1.2 Code Signing & Notarization

For distribution outside App Store:

1. **Developer ID Certificate**: Required for Gatekeeper
2. **Notarization**: Submit to Apple for malware scanning
3. **Stapling**: Attach notarization ticket to app

#### 6.1.3 Auto-Start

Create LaunchAgent plist in `~/Library/LaunchAgents/`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pax.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/PI.app/Contents/MacOS/pax</string>
        <string>--daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

### 7.2 Windows

#### 6.2.1 Permissions

Windows has fewer permission gates than macOS:

| Feature | Requirement |
|---------|-------------|
| General execution | UAC prompt only if modifying system |
| File access | Standard user permissions |
| Network access | Windows Firewall (usually auto-allowed for outbound) |
| Startup | No special permission |

#### 6.2.2 Code Signing

For avoiding SmartScreen warnings:

1. **EV Code Signing Certificate**: Instant reputation
2. **Standard Code Signing**: Builds reputation over time
3. **Self-signed**: Will show warnings (OK for dev)

#### 6.2.3 Auto-Start

Options:
1. **Registry**: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
2. **Startup Folder**: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`
3. **Task Scheduler**: For more control (delay, conditions)

### 7.3 Linux

#### 6.3.1 Desktop Environments

Must support multiple DEs for tray icon:

| DE | Tray Support | Notes |
|----|--------------|-------|
| GNOME | Extension needed | AppIndicator extension |
| KDE | Native | StatusNotifierItem |
| XFCE | Native | Traditional systray |
| i3/Sway | Varies | polybar, waybar |

Tauri handles most of this, but may need fallback to no-tray mode.

#### 6.3.2 Auto-Start

Standard XDG autostart:

```ini
# ~/.config/autostart/pax.desktop
[Desktop Entry]
Type=Application
Name=PI Agent
Exec=/usr/local/bin/pax --daemon
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
```

Or systemd user service:

```ini
# ~/.config/systemd/user/pax.service
[Unit]
Description=PI Personal Assistant

[Service]
ExecStart=/usr/local/bin/pax --daemon
Restart=on-failure

[Install]
WantedBy=default.target
```

---

## 8. Security Model

### 8.1 Threat Model

| Threat | Severity | Mitigation |
|--------|----------|------------|
| Unauthorized remote access | Critical | User whitelist, no public exposure by default |
| Command injection via LLM | High | Command sandboxing, dangerous command blocklist |
| Credential theft | High | Secure credential storage, no plaintext secrets |
| Malicious MCP server | High | User must explicitly configure servers |
| Session hijacking (messaging) | Medium | Session stored locally, encrypted at rest |
| Data exfiltration | Medium | No telemetry, all data stays local |

### 8.2 Authorization Model

#### 7.2.1 User Authorization

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTHORIZATION FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Incoming Message                                                │
│        │                                                         │
│        ▼                                                         │
│  ┌─────────────┐                                                │
│  │ Extract     │                                                │
│  │ User ID     │ (Telegram ID, phone number, etc.)              │
│  └──────┬──────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐     ┌─────────────────────────────────────┐   │
│  │ Check       │────►│ Authorized Users List               │   │
│  │ Whitelist   │     │ - telegram: [123456789, ...]        │   │
│  └──────┬──────┘     │ - whatsapp: [+1234567890, ...]      │   │
│         │            └─────────────────────────────────────┘   │
│         │                                                        │
│    ┌────┴────┐                                                  │
│    │         │                                                   │
│ Authorized  Not                                                 │
│    │      Authorized                                            │
│    │         │                                                   │
│    ▼         ▼                                                  │
│ Process   Ignore/                                               │
│ Request   Log                                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 7.2.2 Tool Authorization

Per-tool permissions can be:
1. **Always Allow**: Safe operations
2. **Allow Once**: Require confirmation per execution
3. **Allow Session**: Allow for current session after first confirmation
4. **Always Deny**: Blocked operations

### 8.3 Terminal Command Security

#### 7.3.1 Command Filtering

```
┌─────────────────────────────────────────────────────────────────┐
│                 TERMINAL SECURITY LAYERS                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: Blocklist (Always Denied)                             │
│  ─────────────────────────────────                              │
│  - rm -rf /                                                      │
│  - mkfs.*                                                        │
│  - dd if=* of=/dev/*                                            │
│  - chmod -R 777 /                                                │
│  - curl * | sh                                                   │
│  - wget * | bash                                                 │
│                                                                  │
│  Layer 2: Sudo Detection (Requires Explicit Approval)           │
│  ─────────────────────────────────────────────────              │
│  - Any command starting with sudo                                │
│  - Any command containing | sudo                                 │
│                                                                  │
│  Layer 3: Allowlist Mode (Optional, Paranoid)                   │
│  ─────────────────────────────────────────────                  │
│  - Only pre-approved commands can run                           │
│  - E.g., ls, cat, grep, git status, npm test                    │
│                                                                  │
│  Layer 4: Sandbox (Recommended)                                 │
│  ─────────────────────────────                                  │
│  - Run commands in restricted shell                              │
│  - Limit file system access                                      │
│  - Limit network access                                          │
│  - Resource limits (CPU, memory, time)                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 7.3.2 Sandbox Options

| Option | Security | Complexity | Cross-Platform |
|--------|----------|------------|----------------|
| **firejail** | High | Low | Linux only |
| **Docker container** | High | Medium | All (Docker required) |
| **nsjail** | Very High | High | Linux only |
| **Custom chroot** | Medium | High | Unix only |
| **No sandbox** | Low | None | All |

Recommended: Use firejail on Linux, Docker as fallback for all platforms.

### 8.4 Network Security

#### 7.4.1 Outbound Only Model

PI makes only outbound connections:
- LLM API calls (HTTPS)
- Telegram/Discord API (HTTPS/WSS)
- WhatsApp Web (HTTPS/WSS)
- Google Calendar API (HTTPS)
- MCP servers (local stdio or localhost HTTP)

No inbound listening ports by default.

#### 7.4.2 Optional Remote Access

If user enables remote access (Tailscale):
- Private mesh network only
- No public internet exposure
- User must explicitly install and configure Tailscale
- PI only binds to Tailscale interface

---

## 9. Configuration System

### 9.1 Configuration Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                  CONFIGURATION PRECEDENCE                        │
│                  (Higher overrides lower)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Command-line arguments                                       │
│     pax --port 3001 --debug                                     │
│                                                                  │
│  2. Environment variables                                        │
│     PI_PORT=3001 PI_DEBUG=true                                │
│                                                                  │
│  3. Project config (if running in a project)                    │
│     ./pi.yaml or ./.pax/config.yaml                            │
│                                                                  │
│  4. User config                                                  │
│     ~/.pi/config.yaml                                          │
│                                                                  │
│  5. System config (admin-provided defaults)                     │
│     /etc/pi/config.yaml                                        │
│                                                                  │
│  6. Built-in defaults                                            │
│     Hardcoded in application                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 Configuration Schema

```yaml
# ~/.pi/config.yaml

# General settings
general:
  log_level: info              # debug, info, warn, error
  data_dir: ~/.pax             # Where to store data
  auto_start: true             # Start on login

# LLM Configuration
llm:
  default_provider: openai
  providers:
    openai:
      api_key: ${OPENAI_API_KEY}  # Environment variable reference
      model: gpt-4o
      temperature: 0.7
    anthropic:
      api_key: ${ANTHROPIC_API_KEY}
      model: claude-3-sonnet-20240229
    ollama:
      base_url: http://localhost:11434
      model: llama3

# Agent behavior
agent:
  max_iterations: 25
  tool_timeout: 30s
  total_timeout: 5m
  require_confirmation:
    - terminal_execute
    - file_write
    - file_delete

# Channel configurations
channels:
  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN}
    allowed_users:
      - 123456789
      - 987654321

  whatsapp:
    enabled: false
    session_path: ~/.pi/whatsapp-session
    allowed_contacts:
      - "+1234567890"

  imessage:
    enabled: false  # macOS only
    allowed_contacts:
      - "+1234567890"
      - "user@icloud.com"

  calendar:
    enabled: true
    credentials_path: ~/.pi/google-credentials.json
    calendar_id: primary
    command_prefix: "PI:"

# MCP servers
mcp:
  servers:
    filesystem:
      command: npx
      args: ["-y", "@anthropic/mcp-server-filesystem", "~"]
      auto_start: true

    git:
      command: npx
      args: ["-y", "@anthropic/mcp-server-git"]
      auto_start: true

# Security settings
security:
  terminal:
    sandbox: firejail        # none, firejail, docker
    blocked_commands:
      - "rm -rf /"
      - "mkfs"
    allowed_paths:
      - "~"
      - "/tmp"

  browser:
    allowed_domains:
      - "*"                   # Or specific domains
    blocked_domains:
      - "*.bank.com"         # Extra caution for banking

# UI settings (Tauri GUI)
ui:
  theme: system              # light, dark, system
  tray_icon: true
  start_minimized: true
  hotkey: "Ctrl+Shift+P"     # Global hotkey to open
```

### 9.3 Secrets Management

Secrets should never be in config files. Options:

1. **Environment Variables**: `${VAR_NAME}` syntax in config
2. **Secure Storage**: API keys stored in OS keychain
3. **Config Prompts**: First-run wizard prompts for secrets

---

## 10. Distribution Strategy

### 10.1 Distribution Channels

| Channel | Target Audience | Update Mechanism |
|---------|-----------------|------------------|
| **GitHub Releases** | Developers, early adopters | Manual download |
| **Homebrew (macOS)** | macOS users | `brew upgrade` |
| **Chocolatey (Windows)** | Windows users | `choco upgrade` |
| **AUR (Linux)** | Arch users | `yay/paru` |
| **AppImage (Linux)** | Universal Linux | Manual download |
| **npm** | CLI users | `npm update -g` |

### 10.2 Auto-Update

Tauri includes built-in auto-update support:

1. **Check**: On startup, check GitHub releases for new version
2. **Notify**: Show notification if update available
3. **Download**: Download in background
4. **Install**: Apply on next restart (or immediately if user chooses)

### 10.3 Release Artifacts

| Platform | Artifact | Size (Estimated) |
|----------|----------|------------------|
| macOS Intel | PI-x.y.z-darwin-x64.dmg | ~15MB |
| macOS ARM | PI-x.y.z-darwin-arm64.dmg | ~15MB |
| Windows | PI-x.y.z-windows-x64.msi | ~20MB |
| Linux | PI-x.y.z-linux-x64.AppImage | ~25MB |
| Linux | PI-x.y.z-linux-x64.deb | ~15MB |
| CLI (all) | pax-cli-x.y.z.tar.gz | ~5MB |

---

## 11. Migration Path

### 11.1 Phase 1: Code Restructuring

**Goal**: Reorganize codebase without breaking existing extension

1. Create `src/core/` directory
2. Move shared code from `src/` to `src/core/`
3. Create `src/extension/` for extension-specific code
4. Update imports to use new paths
5. Ensure extension still builds and works

**Risk**: Low (no functionality changes)

### 11.2 Phase 2: Abstraction Layer

**Goal**: Create interfaces that work for both modes

1. Define `BrowserController` interface
2. Implement `ExtensionBrowserController` (wraps existing code)
3. Define `StorageProvider` interface
4. Implement `ChromeStorageProvider` (wraps existing code)
5. Update DomTool to use injected `BrowserController`

**Risk**: Medium (refactoring core functionality)

### 11.3 Phase 3: Native Implementation

**Goal**: Implement native-mode specific code

1. Implement `CDPBrowserController`
2. Implement `FileStorageProvider`
3. Add terminal tool
4. Add MCP client
5. Create PI entry points (CLI and Tauri)

**Risk**: Medium (new code, but isolated from extension)

### 11.4 Phase 4: Multi-Channel Architecture

**Goal**: Separate Agent, Tools, and UI with pluggable channel system

1. Define `ChannelAdapter` interface
2. Implement `ChannelManager` orchestrator
3. Refactor `MessageRouter` to use channel abstraction
4. Implement Extension channels (SidePanelChannel, TabPageChannel)
5. Implement Tauri channel (TauriChannel)
6. Implement WebSocket channel for remote control
7. Add messaging adapters (Telegram, WhatsApp, iMessage)
8. Update `BrowserxAgent` to use `ChannelManager` for event dispatch

**Risk**: Medium (refactoring core message flow, but well-defined interfaces)

### 11.5 Phase 5: Polish & Distribution

**Goal**: Prepare for release

1. Add auto-update
2. Create installers for each platform
3. Set up Homebrew/Chocolatey packages
4. Write user documentation
5. Create first-run setup wizard

**Risk**: Low (non-core functionality)

---

## 12. Future Considerations

### 12.1 Potential Enhancements

| Feature | Description | Complexity |
|---------|-------------|------------|
| **Voice Input** | Trigger via voice command | Medium |
| **Screen Understanding** | Analyze screenshots for context | Medium |
| **Workflow Recording** | Record and replay browser workflows | High |
| **Multi-Agent** | Multiple specialized agents | High |
| **Plugin System** | User-installable extensions | Medium |
| **Mobile Companion** | Dedicated mobile app | High |

### 12.2 Scalability Considerations

Currently designed for single-user. Future multi-user support would require:

1. User authentication system
2. Per-user data isolation
3. Resource quotas
4. Usage logging and billing (if commercial)

### 12.3 Technology Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| WhatsApp blocks unofficial clients | WhatsApp channel unavailable | Telegram as default; official API as backup |
| Chrome changes CDP | Browser control breaks | Abstract interface allows switching to Playwright |
| Tauri major version change | Significant refactoring | Pin Tauri version; plan migration budget |
| MCP spec evolves | Compatibility issues | Implement spec versioning |

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **CDP** | Chrome DevTools Protocol - wire protocol for browser automation |
| **ChannelAdapter** | Interface for UI channels that send submissions and receive events |
| **ChannelManager** | Orchestrator that routes submissions to agent and dispatches events to channels |
| **EQ** | Event Queue - outbound events from agent to UI channels |
| **EventMsg** | Event message type emitted by agent (TaskStarted, ToolCall, AssistantText, etc.) |
| **MCP** | Model Context Protocol - standard for LLM tool integration |
| **Op** | Operation/Submission type sent to agent (UserTurn, Interrupt, ExecApproval, etc.) |
| **PI** | Personal AI - the native agent product name |
| **SQ** | Submission Queue - inbound operations from UI channels to agent |
| **TUI** | Terminal User Interface |
| **GUI** | Graphical User Interface |
| **Tauri** | Rust-based framework for building desktop apps |

## Appendix B: Reference Documents

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Tauri Documentation](https://tauri.app/v1/guides/)
- [Tailscale Documentation](https://tailscale.com/kb/)

## Appendix C: Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-02 | Use Tauri instead of Electron | Smaller bundle size, better performance |
| 2026-02-02 | Default to Telegram for messaging | Free, official API, reliable |
| 2026-02-02 | Use Tailscale for remote access | Free, easy, secure, no port forwarding |
| 2026-02-02 | MCP for tool extensibility | Industry standard, compatible with other tools |
| 2026-02-02 | Profile-copy strategy for browser control | PI copies essential Chrome profile data (~100-500MB) to separate directory, launches Chrome with debugging enabled. Allows user's Chrome to stay open, PI Chrome has all login sessions. Copy takes 2-10 seconds. No user action required. |
| 2026-02-02 | Skip Cache/History in profile copy | Cache can be 1-5GB, not needed for login sessions. Skipping reduces copy time from minutes to seconds. |
| 2026-02-02 | Use puppeteer-core for CDP | Lightweight (no bundled Chromium), connects to user's Chrome, mature API, good TypeScript support |
| 2026-02-03 | Edge as fallback on Windows | If Chrome not found on Windows, use Microsoft Edge (also Chromium-based, full CDP support). On macOS, prompt user to install Chrome. |
| 2026-02-03 | DebuggerClient abstraction layer | Create middle layer between DomService and chrome.debugger/CDP. DomService logic stays unchanged, only swap the communication layer. Enables code reuse and easier testing. |
| 2026-02-03 | Retry-first error handling | On browser control failures: retry up to 3 times with backoff, attempt auto-reconnect on connection errors. After all retries fail, prompt user with manual instructions. |
| 2026-02-03 | Extension and PI are separate products | No communication between BrowserX extension and PI native app for now. Can be designed later if needed. |
| 2026-02-03 | No onboarding flow for MVP | First-run experience deferred. Users configure via config file initially. |
| 2026-02-03 | Unit tests with mock DebuggerClient | Test DomService with mocked DebuggerClient interface. Integration tests with real Chrome in CI (headless). |
| 2026-02-03 | Multi-Channel Architecture | Separate Agent, Tools, and UI into distinct layers with `ChannelAdapter` interface. UI channels (side panel, tab page, Tauri, WebSocket, Telegram) all implement same interface. Agent core receives `Op` submissions and emits `EventMsg` events. Enables remote control via WebSocket API. Builds on existing SQ/EQ pattern in codebase. |
| 2026-02-03 | WebSocket for remote control | Port 8765 WebSocket server enables external clients (CLI, scripts, other apps) to send tasks and receive streaming events. JSON protocol with `submission` and `event` message types. No authentication for localhost by default. |
| 2026-02-03 | ChannelManager orchestrator | Central component that routes submissions to agent and dispatches events to appropriate channels. Tracks session-to-channel mapping for proper response routing. |