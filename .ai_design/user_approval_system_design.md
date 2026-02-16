# User Approval System Design

## Version 3.0 - Unified Cross-Platform Risk-Aware Tool Approval

**Status**: Design
**Date**: 2026-02-12
**Author**: AI Design Assistant
**Platforms**: Browserx (Chrome Extension) + Pi (Desktop/Tauri)

> **Design principle**: This document treats both platforms as equal first-class citizens.
> Browserx operates in the browser (DOM tools, navigation, extension APIs).
> Pi operates on the desktop (terminal commands, file operations, MCP browser tools, Tauri APIs).
> The approval system core is shared; platform-specific detectors plug in at startup.

---

## Table of Contents

1. [Industry Research Summary](#1-industry-research-summary)
2. [Current State & Gap Analysis](#2-current-state--gap-analysis)
3. [Design Principles](#3-design-principles)
4. [Architecture Overview](#4-architecture-overview)
5. [Risk Classification System](#5-risk-classification-system)
6. [Policy Rules Engine](#6-policy-rules-engine)
7. [Approval Flow & Lifecycle](#7-approval-flow--lifecycle)
8. [Risk Detection by Platform](#8-risk-detection-by-platform)
9. [UI/UX Design](#9-uiux-design)
10. [Integration Points](#10-integration-points)
11. [Data Model & Storage](#11-data-model--storage)
12. [Implementation Phases](#12-implementation-phases)

---

## 1. Industry Research Summary

### How Leading AI Agents Handle Approval

| Agent | Approach | Key Innovation |
|-------|----------|----------------|
| **Claude Code** | 3-tier tool classification (read-only/bash/file-modify) with allow/ask/deny rules | Glob-pattern matching for commands; deny rules always win; hooks for custom logic |
| **Cursor AI** | YOLO mode + hooks system (beforeShellExecution, beforeMCPExecution) | Per-hook allow/deny/ask return; 6 lifecycle hooks for custom approval logic |
| **Devin** | Confidence-based (green/yellow/red) with interactive planning | Agent self-assesses confidence; auto-proceeds on high confidence |
| **OpenAI Operator** | Three modes: Normal / Takeover / Watch | Domain-aware sensitivity; takeover for credentials; watch for financial sites |
| **GitHub Copilot** | Terminal command allowlist/denylist per command prefix | `chat.agent.terminal.autoApprove` per-command config |
| **Anthropic Computer Use** | Recommendation-based (sandbox, limit actions) | Red-team tested with 23.6% attack success rate without protection |
| **Skyvern** | Threshold-based pause + validator agent | Pause before purchases over threshold; separate validator checks outcomes |

### Converged Industry Patterns

**1. Risk Classification Matrix (2x2)**

|                | Reversible        | Irreversible           |
|----------------|-------------------|------------------------|
| **Low Impact** | Auto-approve      | Ask user               |
| **High Impact**| Ask user          | Ask user + extra verify|

**2. Standard Action Tiers**

*Browser Agent Tiers (Browserx extension + Pi MCP browser tools):*

| Tier | Risk | Actions | Default |
|------|------|---------|---------|
| 0 | None | DOM snapshot, scroll, read page content, console logs | Auto-approve |
| 1 | Low | Click tabs/menus, navigate URLs, hover | Auto-approve |
| 2 | Medium | Type into fields, click non-submit buttons | Ask (configurable) |
| 3 | High | Form submit, file upload/download, send messages | Always ask |
| 4 | Critical | Payment/checkout, account deletion, financial ops | Always ask + verify |

*Terminal/CLI Agent Tiers (Pi desktop):*

| Tier | Risk | Actions | Default |
|------|------|---------|---------|
| 0 | None | ls, cat, head, tail, grep, pwd, echo, find, wc | Auto-approve |
| 1 | Low | git status/log/diff, npm list, pip list, env | Auto-approve |
| 2 | Medium | git add/commit, npm install, pip install, curl, wget, file write | Ask (configurable) |
| 3 | High | rm, mv to sensitive paths, chmod/chown, git push, sudo, docker | Always ask |
| 4 | Critical | rm -rf, dd, mkfs, curl|sh, system shutdown, fork bomb | Always deny |

**3. Policy Configuration Pattern (from Claude Code)**

```
deny → ask → allow (first match wins, deny always takes precedence)
```

**4. Approval Fatigue Solutions**

- Allowlists for routine operations (Claude Code, Cursor, Copilot)
- Confidence-based auto-approval (Devin)
- Sandboxing to reduce prompts by 84% (Claude Code)
- "Remember this decision" for session/permanent (Claude Code)
- YOLO mode for dev environments (Cursor)

---

## 2. Current State & Gap Analysis

### What browserx Already Has

| Component | File | Status |
|-----------|------|--------|
| `ApprovalManager` | `src/core/ApprovalManager.ts` | Built but not wired into tool execution |
| `ApprovalDialog.svelte` | `src/extension/sidepanel/components/common/ApprovalDialog.svelte` | Full modal dialog with risk display, countdown, history |
| `ApprovalEvent.svelte` | `src/extension/sidepanel/components/event_display/ApprovalEvent.svelte` | Inline chat approval with approve/reject/request-change |
| `ExecApproval` op | `src/core/protocol/types.ts:74` | Protocol type for approval decisions |
| `PatchApproval` op | `src/core/protocol/types.ts:80` | Protocol type for patch decisions |
| `AskForApproval` | `src/core/protocol/types.ts:112` | Policy enum: `untrusted \| on-failure \| on-request \| never` |
| `ApprovalPolicy` | `src/core/ApprovalManager.ts:51` | `always_ask \| auto_approve_safe \| auto_reject_unsafe \| never_ask` |
| `ApprovalDetails` | `src/core/ApprovalManager.ts:21` | Has `riskLevel`, `impact[]`, `command`, `url`, etc. |
| `ToolMetadata` | `src/tools/BaseTool.ts:55` | Has `permissions[]`, `capabilities[]` (unused) |
| `ExecApprovalRequest` event | `src/core/protocol/events.ts:48` | Event type exists for approval requests |
| `Session.notifyApproval()` | `src/core/Session.ts:1166` | Resolves pending approval promise |

### Critical Gaps

| Gap | Impact | Platform | Priority |
|-----|--------|----------|----------|
| **No risk classifier** | Tools execute without any risk assessment | Both | P0 |
| **ApprovalManager not wired into ToolRegistry** | `ToolRegistry.execute()` bypasses approval entirely | Both | P0 |
| **No per-action risk rules** | Can't distinguish DOM `snapshot` (safe) from `click` on submit button (risky) | Both | P0 |
| **SecurityFilter not unified with ApprovalManager** | Desktop terminal has its own blocklist, not integrated with policy engine | Pi | P0 |
| **No domain-aware sensitivity** | No detection of banking/email/financial sites | Both | P1 |
| **No "remember decision"** | Users must re-approve identical actions every time | Both | P1 |
| **No allow/deny rule engine** | No way to configure per-action policies | Both | P1 |
| **No semantic risk detection** | Can't detect submit/delete/purchase buttons by aria-label/text | Browserx | P1 |
| **No file operation risk assessment** | Desktop file ops (write/delete) have no risk classification | Pi | P1 |
| **MCP tool approval missing** | Desktop browser tools via MCP bypass approval entirely | Pi | P1 |
| **No agent self-assessment** | Agent can't signal confidence level for its proposed actions | Both | P2 |
| **ToolMetadata not utilized** | `permissions[]` and `capabilities[]` fields are defined but ignored | Both | P2 |

### Platform Comparison: What Exists Today

| Component | Browserx (Extension) | Pi (Desktop) |
|-----------|---------------------|--------------|
| **ApprovalManager** | Built, not wired in | Built, not wired in (shared core) |
| **ApprovalDialog UI** | Svelte modal component | Same component (shared Svelte UI) |
| **Tool-level security** | None | SecurityFilter for terminal only |
| **Risk classification** | None | Terminal risk scoring (0-10) only |
| **Confirmation flow** | None | Terminal `needsConfirmation()` only |
| **Storage** | chrome.storage.local | SQLite + OS Keychain (Tauri) |
| **Messaging** | ChromeMessageService | TauriMessageService |
| **Notification** | Chrome notifications API | Tauri notification API |

---

## 3. Design Principles

### 3.1 Safety-First, Friction-Second

> "Deny by default for unknown actions; approve by default for known-safe actions."

Follow Claude Code's evolution: start with allowlist (not blocklist) approach. Unknown actions require approval. Known-safe patterns are pre-approved.

### 3.2 Approval Fatigue Prevention

Design for the user who approves 50+ actions per session. Key strategies:
- **Smart defaults**: Read-only actions never prompt
- **Session memory**: "Allow for this session" remembers approval
- **Pattern matching**: "Allow all clicks on *.google.com" applies broadly
- **Progressive trust**: Start strict, relax as user builds trust patterns

### 3.3 Transparent Risk Communication

Users must understand **why** an action is flagged:
- Show the specific action (click, type, submit)
- Show the target (button text, form action URL, element context)
- Show the risk reason (sensitive domain, submit button detected, irreversible action)
- Show the impact (what could happen if approved)

### 3.4 Non-Blocking for Safe Actions

The approval gate must be invisible for Tier 0-1 actions. The agent should flow naturally through read/navigate actions without any user interaction.

### 3.5 Composable with Existing Architecture

Build on the existing `ApprovalManager`, `ExecApproval` protocol, and event system. Wire into the existing `ToolRegistry.execute()` flow without breaking the tool handler contract.

---

## 4. Architecture Overview

### 4.1 Component Diagram (Platform-Agnostic Core)

The approval system core is identical on both platforms. Only the transport layer
and storage adapter differ:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Shared Svelte UI                            │
│  ┌────────────────┐  ┌──────────────────────┐                   │
│  │ ApprovalBanner  │  │ ApprovalSettingsPanel │                   │
│  │ (inline chat)   │  │ (rules config UI)     │                   │
│  └───────┬─────────┘  └──────────┬────────────┘                  │
└──────────┼───────────────────────┼──────────────────────────────┘
           │                       │
  ─────────┼── Platform Transport ─┼──────────────────────────────
           │  (chrome.runtime      │
           │   OR Tauri events)    │
           │                       │
┌──────────┼───────────────────────┼──────────────────────────────┐
│          ▼                       ▼                               │
│  ┌────────────────┐  ┌───────────────────────────┐              │
│  │ IMessageService │  │  IPolicyStorageAdapter     │              │
│  │ (approval msgs) │  │  (extension: chrome.storage│              │
│  │                  │  │   desktop: TauriConfig)    │              │
│  └───────┬──────────┘  └──────────┬────────────────┘             │
│          │                        │                              │
│          ▼                        ▼                              │
│  ┌──────────────────────────────────────────────────┐           │
│  │              ApprovalGate (orchestrator)           │           │
│  │  ┌────────────────────┐ ┌──────────────────────┐ │           │
│  │  │ IRiskAssessor       │ │  PolicyRulesEngine   │ │           │
│  │  │ (from each tool)    │ │  (deny > ask > allow)│ │           │
│  │  └────────┬───────────┘ └──────────┬───────────┘ │           │
│  │           │                        │              │           │
│  │           ▼                        ▼              │           │
│  │  ┌───────────────────┐  ┌──────────────────┐     │           │
│  │  │ IContextEnhancer[] │  │ ApprovalManager  │     │           │
│  │  │ (pluggable, per-  │  │ (user prompt,    │     │           │
│  │  │  platform startup)│  │  timeout, memory) │     │           │
│  │  └───────────────────┘  └──────────────────┘     │           │
│  └──────────────────────────────────────────────────┘           │
│          ▲                                                       │
│  ┌───────┴──────────┐                                           │
│  │   ToolRegistry    │──► Tool Handlers                          │
│  │  .execute()       │                                           │
│  └──────────────────┘                                           │
│                                                                  │
│  Agent Process (Extension: Service Worker | Desktop: Main Thread)│
└─────────────────────────────────────────────────────────────────┘
```

**Per-platform tool handlers registered at startup:**

| Platform | Tool | IRiskAssessor | IContextEnhancers |
|----------|------|---------------|-------------------|
| **Browserx** | `browser_dom` (snapshot, click, type, scroll) | `DomToolRiskAssessor` | `DomainSensitivityEnhancer`, `SemanticElementEnhancer` |
| **Browserx** | `navigation_tool` (navigate, back, forward) | `NavigationRiskAssessor` | `DomainSensitivityEnhancer` |
| **Pi** | `terminal` (execute commands) | `TerminalRiskAssessor` | `SensitivePathEnhancer` |
| **Pi** | `browser__*` (MCP browser tools) | `McpBrowserRiskAssessor` | `DomainSensitivityEnhancer`, `SemanticElementEnhancer` |
| **Both** | `web_search`, `planning_tool` | None (default: auto-approve) | None |

**Platform transport mapping:**

| Component | Browserx (Extension) | Pi (Desktop) |
|-----------|---------------------|--------------|
| **IMessageService** | `ChromeMessageService` (chrome.runtime) | `TauriMessageService` (Tauri events) |
| **IPolicyStorageAdapter** | `ChromePolicyStorage` (chrome.storage.local) | `TauriPolicyStorage` (TauriConfigStorage JSON) |
| **Agent process** | Background Service Worker | Main thread (DesktopAgentBootstrap) |
| **UI transport** | chrome.runtime.sendMessage | Tauri `emit`/`listen` events |
| **Notification** | Chrome notifications API + badge | Tauri notification API + system tray |

### 4.2 Design Problem: Why a Monolithic Classifier Doesn't Work

A central `RiskClassifier` that knows about every tool breaks extensibility:

```
BAD: Central classifier knows about all tools
┌──────────────────────────────┐
│       RiskClassifier          │
│  if (tool === 'browser_dom') │  ← must be modified for every new tool
│  if (tool === 'terminal')    │  ← MCP tools can't be added at build time
│  if (tool === 'mcp:github')  │  ← grows forever
└──────────────────────────────┘
```

Instead, **each tool should own its risk assessment**. The approval gate is tool-agnostic:

```
GOOD: Tools provide their own risk assessor
┌─────────────────────────────────────────────────┐
│  ApprovalGate (tool-agnostic orchestrator)       │
│                                                   │
│  1. Ask the tool: "how risky is this action?"    │
│  2. Ask context enhancers: "any extra risk?"     │
│  3. Ask policy engine: "allow, ask, or deny?"    │
│  4. If ask → prompt user via ApprovalManager     │
└─────────────────────────────────────────────────┘
         ▲               ▲                ▲
         │               │                │
   ┌─────┴─────┐  ┌─────┴──────┐  ┌──────┴──────┐
   │ DOMTool    │  │ Terminal   │  │ MCP Tool X  │
   │ .assess()  │  │ .assess()  │  │ .assess()   │
   └───────────┘  └────────────┘  └─────────────┘
   Each tool provides          Dynamic tools register
   its own IRiskAssessor       assessors at runtime
```

### 4.3 New Components (Extensible Architecture)

**Core (tool-agnostic, shared):**

| Component | Responsibility |
|-----------|---------------|
| **ApprovalGate** | Orchestrator: ask tool assessor → enhance with context → evaluate policy → approve/ask/deny |
| **PolicyRulesEngine** | Evaluates rules (deny > ask > allow) against the risk assessment |
| **ApprovalManager** | Handles user prompt, timeout, decision memory (existing, enhanced) |
| **IPolicyStorageAdapter** | Abstract storage; chrome.storage.local or Tauri config store |

**Interfaces (tools implement):**

| Interface | Who Implements | Purpose |
|-----------|---------------|---------|
| **IRiskAssessor** | Each tool at registration time | Tool-specific risk scoring for its own actions |
| **IContextEnhancer** | Platform-specific plugins | Add contextual risk signals (domain, element semantics, etc.) |

**Built-in context enhancers:**

| Enhancer | Platform | Purpose |
|----------|----------|---------|
| **DomainSensitivityEnhancer** | Shared | Boost risk for banking/email/financial domains |
| **SemanticElementEnhancer** | Browserx | Boost risk for submit/delete/purchase buttons |
| **SensitivePathEnhancer** | Pi | Boost risk for .env, /etc/, .ssh paths |

**UI (shared Svelte):**

| Component | Purpose |
|-----------|---------|
| **ApprovalBanner.svelte** | Inline chat approval |
| **ApprovalSettings.svelte** | Rules configuration |

### 4.4 Enhanced Components

| Component | Enhancement |
|-----------|-------------|
| **ApprovalManager** | Add session memory, "remember" decisions, rule-based auto-decisions |
| **ToolRegistry** | Accept optional `IRiskAssessor` at registration; call `ApprovalGate` before `execute()` |
| **ToolMetadata** | Add `riskProfile` for static risk declaration (fallback when no assessor) |

---

## 5. Risk Classification System

### 5.1 Risk Dimensions

Risk is computed from four dimensions:

```typescript
interface RiskAssessment {
  /** Overall computed risk level */
  level: 'none' | 'low' | 'medium' | 'high' | 'critical';

  /** Numeric score (0-100) for fine-grained comparison */
  score: number;

  /** Individual dimension scores */
  dimensions: {
    /** How destructive is this action? (0-100) */
    destructiveness: number;

    /** Can this action be undone? (0-100, 100=irreversible) */
    irreversibility: number;

    /** Does this action have external side effects? (0-100) */
    externalImpact: number;

    /** How sensitive is the current context/domain? (0-100) */
    contextSensitivity: number;
  };

  /** Human-readable reasons for the risk level */
  reasons: string[];

  /** Suggested approval mode */
  suggestedAction: 'auto_approve' | 'ask_user' | 'ask_user_with_warning' | 'block';

  /** Category for UI grouping */
  category: RiskCategory;
}

type RiskCategory =
  | 'read_only'           // Snapshot, scroll, observe
  | 'navigation'          // URL navigation, tab switching
  | 'input'               // Typing, clicking non-critical elements
  | 'form_submission'     // Submitting forms
  | 'data_modification'   // Deleting, editing external data
  | 'authentication'      // Login, credential entry
  | 'financial'           // Payments, purchases, transfers
  | 'system_command'      // Terminal/shell commands
  | 'file_operation'      // File upload, download
  | 'communication'       // Sending emails, messages, posts
  | 'account_management'; // Account settings, deletion
```

### 5.2 Core Interfaces: IRiskAssessor and IContextEnhancer

The extensibility comes from two interfaces that decouple the approval gate from specific tools:

```typescript
/**
 * IRiskAssessor - Each tool provides its own implementation.
 * Registered alongside the tool handler in ToolRegistry.
 *
 * The tool knows its own actions best. A DOM tool knows that 'snapshot'
 * is read-only. A terminal tool knows that 'sudo rm' is dangerous.
 * The approval gate doesn't need to know any of this.
 */
interface IRiskAssessor {
  /**
   * Assess base risk for this tool's action.
   * Called by ApprovalGate before every tool execution.
   *
   * @param action - The action being performed (e.g., 'click', 'execute', 'search')
   * @param parameters - The action parameters (e.g., { node_id: '0:42' }, { command: 'ls' })
   * @param context - Runtime context (current URL, tab ID, etc.)
   * @returns Base risk assessment from the tool's perspective
   */
  assess(
    action: string,
    parameters: Record<string, any>,
    context: ApprovalContext
  ): RiskAssessment;
}

/**
 * IContextEnhancer - Pluggable modules that add contextual risk signals.
 * Multiple enhancers can be registered. They run in sequence after the
 * tool's base assessment, each potentially boosting the risk score.
 *
 * This is what makes the system extensible without modifying existing code:
 * - Add a new website category? Add a DomainSensitivityEnhancer pattern.
 * - Add a new danger signal? Register a new IContextEnhancer.
 * - New platform? Register platform-specific enhancers at startup.
 */
interface IContextEnhancer {
  /** Unique identifier */
  id: string;

  /** Which platforms this enhancer runs on */
  platforms: ('extension' | 'desktop')[];

  /**
   * Enhance a risk assessment with additional context.
   * Can increase the score and add reasons, but cannot decrease it.
   *
   * @param assessment - Current risk assessment (from tool + previous enhancers)
   * @param toolName - Which tool is being executed
   * @param action - The action being performed
   * @param parameters - The action parameters
   * @param context - Runtime context
   * @returns Enhancement to apply (score boost + reasons)
   */
  enhance(
    assessment: RiskAssessment,
    toolName: string,
    action: string,
    parameters: Record<string, any>,
    context: ApprovalContext
  ): RiskEnhancement;
}

/**
 * Approval context passed to assessors and enhancers.
 * Platform-agnostic - each field is optional since not all
 * platforms/tools provide all context.
 */
interface ApprovalContext {
  /** Current page URL (both platforms - browser context) */
  currentUrl?: string;

  /** Current page domain extracted for convenience */
  currentDomain?: string;

  /** Tab/window ID */
  tabId?: number;

  /** Session ID */
  sessionId: string;

  /** Turn ID */
  turnId: string;

  /** Last DOM snapshot (browserx: direct, pi: from MCP) */
  domSnapshot?: SerializedDom;

  /** Current working directory (pi: terminal context) */
  cwd?: string;

  /** Agent mode */
  platform: 'extension' | 'desktop';
}

/**
 * Result from IContextEnhancer.enhance()
 */
interface RiskEnhancement {
  /** Score to ADD to current risk (0-100, cannot be negative) */
  scoreBoost: number;

  /** Override the risk category if this enhancer detected something more specific */
  categoryOverride?: RiskCategory;

  /** Human-readable reasons for the boost */
  reasons: string[];
}
```

### 5.3 How Tools Register Risk Assessors

The key change: `ToolRegistry.register()` accepts an optional `IRiskAssessor`:

```typescript
// Enhanced ToolRegistry.register()
async register(
  tool: ToolDefinition,
  handler: ToolHandler,
  riskAssessor?: IRiskAssessor  // NEW: optional, tool-provided
): Promise<void> {
  // ... existing validation ...

  const entry: ToolRegistryEntry = {
    definition: tool,
    handler,
    riskAssessor: riskAssessor ?? null,  // null = use static metadata fallback
    registrationTime: Date.now(),
  };

  this.tools.set(toolName, entry);
}
```

**Each tool provides its own assessor at registration time:**

```typescript
// === Browserx: DOMTool registration ===
await registry.register(
  domToolDefinition,
  domToolHandler,
  new DomToolRiskAssessor()   // Tool owns its risk logic
);

// === Pi: Terminal registration ===
await registry.register(
  terminalDefinition,
  terminalHandler,
  new TerminalRiskAssessor()  // Replaces SecurityFilter
);

// === Pi: MCP browser tools (dynamic, at runtime) ===
for (const mcpTool of discoveredMcpTools) {
  await registry.register(
    mcpTool.definition,
    mcpTool.handler,
    new McpBrowserRiskAssessor(mcpTool.name)  // Maps MCP tool names to risk
  );
}

// === Any future tool ===
await registry.register(
  myNewToolDef,
  myNewToolHandler,
  new MyNewToolRiskAssessor()  // New tool ships its own assessor
);

// === Simple read-only tool (no assessor needed) ===
await registry.register(
  webSearchDef,
  webSearchHandler
  // No assessor = falls back to ToolMetadata.riskProfile or defaults to 'none'
);
```

### 5.4 Built-in Risk Assessor Implementations

**DomToolRiskAssessor** (browserx: `browser_dom`):

```typescript
class DomToolRiskAssessor implements IRiskAssessor {
  assess(action: string, params: Record<string, any>, ctx: ApprovalContext): RiskAssessment {
    switch (action) {
      case 'snapshot':
      case 'scroll':
        return { score: 0, level: 'none', category: 'read_only', reasons: [] };

      case 'click':
        return { score: 15, level: 'low', category: 'input', reasons: ['Clicking an element'] };

      case 'type':
        return { score: 15, level: 'low', category: 'input', reasons: ['Typing into an element'] };

      case 'keypress':
        // Enter key is riskier (potential form submit)
        if (params.key === 'Enter') {
          return { score: 25, level: 'low', category: 'input',
            reasons: ['Pressing Enter (may submit form)'] };
        }
        return { score: 10, level: 'low', category: 'input', reasons: ['Key press'] };

      default:
        return { score: 20, level: 'low', category: 'input', reasons: [`Unknown DOM action: ${action}`] };
    }
  }
}
```

**TerminalRiskAssessor** (pi: `terminal`):

```typescript
class TerminalRiskAssessor implements IRiskAssessor {
  // Reuses patterns from existing SecurityFilter
  private blocklist = SecurityFilter.getBlocklistPatterns();

  assess(action: string, params: Record<string, any>, ctx: ApprovalContext): RiskAssessment {
    const command = params.command || '';

    // Hard block check (existing SecurityFilter patterns)
    for (const pattern of this.blocklist) {
      if (pattern.test(command)) {
        return { score: 100, level: 'critical', category: 'system_command',
          reasons: [`Blocked command pattern detected`],
          suggestedAction: 'block' };
      }
    }

    let score = 20; // Base: all terminal commands start at 'low'
    const reasons: string[] = [];

    // Read-only commands are safe
    if (/^(ls|cat|head|tail|grep|find|echo|pwd|whoami|date|wc)\b/.test(command)) {
      return { score: 5, level: 'none', category: 'system_command',
        reasons: ['Read-only command'] };
    }

    if (/^sudo\b/.test(command))     { score += 30; reasons.push('Elevated privileges (sudo)'); }
    if (/\brm\b/.test(command))       { score += 25; reasons.push('File deletion'); }
    if (/\b(chmod|chown)\b/.test(command)) { score += 20; reasons.push('Permission change'); }
    if (/\b(curl|wget)\b/.test(command))   { score += 10; reasons.push('Network operation'); }
    if (/\bgit\s+push\b/.test(command))    { score += 15; reasons.push('Git push'); }
    if (/[|;&]/.test(command))              { score += 5;  reasons.push('Command chaining'); }

    return {
      score: Math.min(score, 100),
      level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low',
      category: 'system_command',
      reasons,
    };
  }
}
```

**McpBrowserRiskAssessor** (pi: dynamic MCP tools):

```typescript
class McpBrowserRiskAssessor implements IRiskAssessor {
  // Maps MCP tool names to equivalent risk levels
  private static RISK_MAP: Record<string, { score: number; category: RiskCategory }> = {
    'browser__snapshot':         { score: 0, category: 'read_only' },
    'browser__console_logs':     { score: 0, category: 'read_only' },
    'browser__scroll':           { score: 0, category: 'read_only' },
    'browser__navigate_page':    { score: 10, category: 'navigation' },
    'browser__go_back':          { score: 0, category: 'navigation' },
    'browser__click':            { score: 15, category: 'input' },
    'browser__type':             { score: 15, category: 'input' },
    'browser__select_option':    { score: 15, category: 'input' },
    'browser__file_upload':      { score: 60, category: 'file_operation' },
    'browser__press_key':        { score: 10, category: 'input' },
  };

  constructor(private toolName: string) {}

  assess(action: string, params: Record<string, any>, ctx: ApprovalContext): RiskAssessment {
    const mapping = McpBrowserRiskAssessor.RISK_MAP[this.toolName];
    if (mapping) {
      return { score: mapping.score, level: this.scoreToLevel(mapping.score),
        category: mapping.category, reasons: [] };
    }
    // Unknown MCP tool → default to medium (ask user)
    return { score: 40, level: 'medium', category: 'input',
      reasons: [`Unknown MCP tool: ${this.toolName}`] };
  }
}
```

**Static fallback** (tools registered without an assessor):

```typescript
class StaticRiskAssessor implements IRiskAssessor {
  /**
   * Fallback assessor that reads from ToolMetadata.riskProfile.
   * Used when a tool doesn't provide its own IRiskAssessor.
   */
  constructor(private metadata: ToolMetadata) {}

  assess(action: string, params: Record<string, any>, ctx: ApprovalContext): RiskAssessment {
    const profile = this.metadata.riskProfile;
    if (!profile) {
      // No risk info at all → default to 'none' (auto-approve)
      return { score: 0, level: 'none', category: 'read_only', reasons: [] };
    }

    const actionProfile = profile.actions?.[action];
    if (actionProfile) {
      return {
        score: this.levelToScore(actionProfile.risk),
        level: actionProfile.risk,
        category: actionProfile.category,
        reasons: [actionProfile.description],
      };
    }

    return {
      score: this.levelToScore(profile.defaultRisk),
      level: profile.defaultRisk,
      category: 'input',
      reasons: [`Default risk for ${action}`],
    };
  }
}
```

### 5.5 ApprovalGate Pipeline

The `ApprovalGate` is completely tool-agnostic. It orchestrates but doesn't know about any specific tool:

```typescript
class ApprovalGate {
  private contextEnhancers: IContextEnhancer[] = [];
  private policyEngine: PolicyRulesEngine;
  private approvalManager: ApprovalManager;

  /** Register a context enhancer (called at startup per platform) */
  registerEnhancer(enhancer: IContextEnhancer): void {
    this.contextEnhancers.push(enhancer);
  }

  /**
   * Main entry point. Called by ToolRegistry.execute() before every tool call.
   * Completely tool-agnostic - works with any tool that has an IRiskAssessor.
   */
  async evaluate(
    toolName: string,
    action: string,
    parameters: Record<string, any>,
    riskAssessor: IRiskAssessor | null,
    metadata: ToolMetadata | undefined,
    context: ApprovalContext
  ): Promise<ApprovalDecision> {

    // ── Step 1: Get base risk from the tool's own assessor ──
    let assessment: RiskAssessment;
    if (riskAssessor) {
      assessment = riskAssessor.assess(action, parameters, context);
    } else {
      // Fallback to static metadata
      assessment = new StaticRiskAssessor(metadata ?? {}).assess(action, parameters, context);
    }

    // ── Step 2: Run context enhancers (additive, cannot decrease risk) ──
    for (const enhancer of this.contextEnhancers) {
      if (!enhancer.platforms.includes(context.platform)) continue;

      const enhancement = enhancer.enhance(assessment, toolName, action, parameters, context);
      if (enhancement.scoreBoost > 0) {
        assessment.score = Math.min(100, assessment.score + enhancement.scoreBoost);
        assessment.level = this.scoreToLevel(assessment.score);
        assessment.reasons.push(...enhancement.reasons);
        if (enhancement.categoryOverride) {
          assessment.category = enhancement.categoryOverride;
        }
      }
    }

    // ── Step 3: Check session memory (previously approved identical actions) ──
    const sessionKey = this.buildSessionKey(toolName, action, parameters, context);
    const remembered = this.sessionDecisions.get(sessionKey);
    if (remembered) {
      return { decision: remembered.effect === 'allow' ? 'approve' : 'deny',
        source: 'session_memory', assessment };
    }

    // ── Step 4: Evaluate policy rules (deny > ask > allow) ──
    const policyResult = this.policyEngine.evaluate(toolName, action, assessment, context);

    if (policyResult.effect === 'allow') {
      return { decision: 'approve', source: 'policy_rule',
        matchedRule: policyResult.rule, assessment };
    }
    if (policyResult.effect === 'deny') {
      return { decision: 'deny', source: 'policy_rule',
        matchedRule: policyResult.rule, assessment };
    }

    // ── Step 5: Ask the user ──
    const approvalResponse = await this.approvalManager.requestApproval({
      id: crypto.randomUUID(),
      type: this.categoryToApprovalType(assessment.category),
      title: this.buildTitle(toolName, action, parameters),
      description: this.buildDescription(assessment),
      details: {
        action,
        riskLevel: assessment.level,
        impact: assessment.reasons,
        command: parameters.command,
        url: context.currentUrl,
      },
      metadata: {
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolName,
        timestamp: Date.now(),
        rollbackable: false,
      },
      timeout: this.getTimeout(assessment.level),
    });

    // ── Step 6: Remember decision if user chose to ──
    // (UI sends remember scope with the decision)

    return {
      decision: approvalResponse.decision === 'approve' ? 'approve' : 'deny',
      source: 'user_decision',
      assessment,
    };
  }
}
```

### 5.6 Runtime Behavior: 100% Rule-Based, No LLM

#### Why Not LLM

The approval gate runs on **every single tool call**. If the agent takes 20 actions
in a task, that's 20 evaluations. An LLM call would be unacceptable here:

| | Rule-Based (our approach) | LLM Call (rejected) |
|---|---|---|
| **Latency** | < 5ms per evaluation | 500ms-3s per evaluation |
| **Cost** | Free | API cost on every tool call |
| **Determinism** | Same input = same output always | May flag differently each time |
| **Offline?** | Yes | No |
| **Circular dependency?** | No | Yes - LLM approving LLM's own actions |

#### What IRiskAssessor Does at Runtime

Pure pattern matching on **structured data already available** (action name, parameter values):

```typescript
// TerminalRiskAssessor - regex matching on the command string
// Input is structured: params.command = "sudo rm -rf /tmp/cache"
assess(action, params) {
  const command = params.command;

  // Read-only? Return immediately.
  if (/^(ls|cat|head|tail|grep|pwd|echo)\b/.test(command)) {
    return { score: 5, level: 'none', category: 'system_command', reasons: [] };
  }

  let score = 20;
  const reasons: string[] = [];

  if (/^sudo\b/.test(command))         { score += 30; reasons.push('Elevated privileges'); }
  if (/\brm\b/.test(command))          { score += 25; reasons.push('File deletion'); }
  if (/\b-rf\b/.test(command))         { score += 20; reasons.push('Recursive + forced'); }

  return { score: 75, level: 'high', category: 'system_command', reasons };
  // Total execution time: ~0.1ms
}
```

```typescript
// DomToolRiskAssessor - switch on the action enum
// Input is an enum value: action = 'click' | 'snapshot' | 'type' | ...
assess(action, params) {
  switch (action) {
    case 'snapshot':
    case 'scroll':
      return { score: 0, level: 'none', category: 'read_only', reasons: [] };
    case 'click':
      return { score: 15, level: 'low', category: 'input', reasons: ['Clicking element'] };
    case 'type':
      return { score: 15, level: 'low', category: 'input', reasons: ['Typing text'] };
    case 'keypress':
      if (params.key === 'Enter') {
        return { score: 25, level: 'low', category: 'input',
          reasons: ['Enter key (may submit form)'] };
      }
      return { score: 10, level: 'low', category: 'input', reasons: ['Key press'] };
  }
  // Total execution time: ~0.05ms
}
```

No ambiguity. Action names are known enums. Parameters are structured objects.
This is a lookup table, not a reasoning task.

#### What IContextEnhancer Does at Runtime

Also pattern matching, on data **already in memory** from previous agent actions:

```typescript
// DomainSensitivityEnhancer - regex match on the current URL
// The URL is already known (current tab URL, passed in ApprovalContext)
enhance(assessment, toolName, action, params, context) {
  const domain = context.currentDomain;  // "chase.com" - already extracted

  for (const pattern of this.sensitivePatterns) {
    if (pattern.regex.test(domain)) {    // /bank|paypal|chase/i.test("chase.com")
      return {
        scoreBoost: pattern.boost,       // +50 for financial
        categoryOverride: pattern.category,
        reasons: [`Sensitive domain: ${domain} (${pattern.category})`],
      };
    }
  }
  return { scoreBoost: 0, reasons: [] };
  // Total execution time: ~0.5ms
}
```

```typescript
// SemanticElementEnhancer (browserx) - string matching on DOM element attributes
// The DOM snapshot is already in memory from the agent's previous 'snapshot' call
enhance(assessment, toolName, action, params, context) {
  if (action !== 'click' && action !== 'keypress') {
    return { scoreBoost: 0, reasons: [] };
  }

  const element = findElement(context.domSnapshot, params.node_id);
  if (!element) return { scoreBoost: 0, reasons: [] };

  // Element text/label is a structured field, not free text
  const text = (element.aria_label || element.text || '').toLowerCase();

  if (/\b(delete|remove|deactivate)\b/.test(text)) {
    return { scoreBoost: 40, categoryOverride: 'data_modification',
      reasons: [`Delete action detected: "${text}"`] };
  }
  if (/\b(submit|confirm|place order)\b/.test(text)) {
    return { scoreBoost: 30, categoryOverride: 'form_submission',
      reasons: [`Submit action detected: "${text}"`] };
  }
  if (/\b(buy|purchase|checkout|pay)\b/.test(text)) {
    return { scoreBoost: 50, categoryOverride: 'financial',
      reasons: [`Purchase action detected: "${text}"`] };
  }
  if (/\b(send|post|publish|tweet)\b/.test(text)) {
    return { scoreBoost: 25, categoryOverride: 'communication',
      reasons: [`Communication action detected: "${text}"`] };
  }

  return { scoreBoost: 0, reasons: [] };
  // Total execution time: ~1ms (DOM tree lookup + regex)
}
```

#### Complete Runtime Timeline

```
Agent calls: browser_dom({ action: 'click', node_id: '0:42' })
  on page: https://www.chase.com/checkout
  element: <button aria-label="Complete Purchase">Complete Purchase</button>

 0.0ms  ToolRegistry.execute() called
 0.0ms  ApprovalGate.evaluate() starts
 0.1ms    Step 1: DomToolRiskAssessor.assess('click')
                  → score: 15, category: 'input'
 0.6ms    Step 2: DomainSensitivityEnhancer.enhance()
                  → chase.com matches /chase/i → +50
                  → score: 65, category: 'financial'
 1.1ms    Step 2: SemanticElementEnhancer.enhance()
                  → "Complete Purchase" matches /purchase/i → +50
                  → score: 100 (capped), category: 'financial'
 1.2ms    Step 3: Check session memory → no previous decision
 1.3ms    Step 4: PolicyRulesEngine.evaluate()
                  → no matching allow/deny rule → effect: 'ask'
 1.3ms    Step 5: ApprovalManager.requestApproval()
                  → emit ApprovalRequested event to UI
 1.4ms  ── Agent execution PAUSES ──

         ... user sees approval banner in chat:
         ┌──────────────────────────────────────────────┐
         │ 🔴 CRITICAL: Click "Complete Purchase"       │
         │ Domain: chase.com (Financial)                 │
         │ Reason: Purchase action on financial domain   │
         │ [Approve] [Deny] □ Remember for session  ⏱58s│
         └──────────────────────────────────────────────┘

5000ms  User clicks [Approve] with "Remember for session" checked
5001ms    Step 6: Store session decision for chase.com+click
5001ms  ApprovalGate returns { decision: 'approve' }
5001ms  ToolRegistry proceeds to execute DOMTool handler
5050ms  DomService.click('0:42') executes on the page

Total approval gate overhead: ~1.4ms (invisible)
Only wait: human decision (when risk is medium+)
```

#### Contrast: A Safe Browser Action (No User Interaction)

```
Agent calls: browser_dom({ action: 'snapshot' })
  on page: https://www.google.com

 0.0ms  ToolRegistry.execute() called
 0.0ms  ApprovalGate.evaluate() starts
 0.1ms    Step 1: DomToolRiskAssessor.assess('snapshot')
                  → score: 0, category: 'read_only'
 0.5ms    Step 2: DomainSensitivityEnhancer → google.com → no match → +0
 0.6ms    Step 2: SemanticElementEnhancer → action is 'snapshot', skip → +0
 0.7ms    Step 3: Session memory → N/A (score is 0)
 0.7ms    Step 4: PolicyRulesEngine → matches 'builtin:allow-read-only' → effect: 'allow'
 0.8ms  ApprovalGate returns { decision: 'approve', source: 'policy_rule' }
 0.8ms  ToolRegistry proceeds to execute handler immediately

Total: 0.8ms, zero user interaction, no UI shown
```

#### Pi Desktop: Terminal Command (Risky — User Prompted)

```
Agent calls: terminal({ command: 'sudo chmod -R 777 /etc/nginx/' })
  cwd: /home/user/project

 0.0ms  ToolRegistry.execute() called
 0.0ms  ApprovalGate.evaluate() starts
 0.1ms    Step 1: TerminalRiskAssessor.assess('execute', { command: 'sudo chmod...' })
                  → sudo: +30, chmod: +20, score: 70, category: 'system_command'
 0.3ms    Step 2: SensitivePathEnhancer.enhance()
                  → /etc/ matches system directory pattern → +40
                  → score: 100 (capped), category: 'system_command'
 0.4ms    Step 3: Check session memory → no previous decision
 0.5ms    Step 4: PolicyRulesEngine.evaluate()
                  → no matching allow/deny rule → effect: 'ask'
 0.5ms    Step 5: ApprovalManager.requestApproval()
                  → emit ApprovalRequested event to Tauri webview

 0.6ms  ── Agent execution PAUSES ──

         ... user sees approval banner in chat:
         ┌──────────────────────────────────────────────┐
         │ 🔴 CRITICAL: sudo chmod -R 777 /etc/nginx/   │
         │ Elevated privileges + system directory        │
         │ [Approve] [Deny]  □ Remember for session  ⏱58s│
         └──────────────────────────────────────────────┘

8000ms  User clicks [Deny]
8001ms  ApprovalGate returns { decision: 'deny' }
8001ms  ToolRegistry returns APPROVAL_DENIED error to agent
8001ms  Agent receives: "Action denied: Elevated privileges; System directory"
```

#### Pi Desktop: Safe Terminal Command (No User Interaction)

```
Agent calls: terminal({ command: 'ls -la /home/user/project/src/' })
  cwd: /home/user/project

 0.0ms  ToolRegistry.execute() called
 0.0ms  ApprovalGate.evaluate() starts
 0.1ms    Step 1: TerminalRiskAssessor.assess('execute', { command: 'ls -la...' })
                  → matches read-only pattern /^ls\b/ → score: 5, category: 'read_only'
 0.2ms    Step 2: SensitivePathEnhancer → /home/user/project → no match → +0
 0.3ms    Step 3: Session memory → N/A (score is 5)
 0.3ms    Step 4: PolicyRulesEngine → matches 'builtin:desktop:allow-readonly-cmds' → 'allow'
 0.4ms  ApprovalGate returns { decision: 'approve', source: 'policy_rule' }
 0.4ms  ToolRegistry executes terminal handler immediately

Total: 0.4ms, zero user interaction, no UI shown
```

#### Where LLM Reasoning Fits (Upstream, Not in the Gate)

The LLM's role in risk assessment is **upstream** - in the agent's own reasoning
before it decides to call a tool. This is handled via the system prompt:

```
┌──────────────────────────────────────────────────────────┐
│  Agent (LLM) - reasoning about what to do next            │
│                                                            │
│  "I need to click 'Place Order' to complete the purchase. │
│   This is a financial action on a shopping site.           │
│   I should explain what I'm about to do so the user        │
│   has context when the approval prompt appears."           │
│                                                            │
│  → Agent outputs: "I'm going to click 'Place Order'       │
│    to complete your $149.99 purchase on Amazon."           │
│  → Agent calls: browser_dom({ action: 'click', ... })     │
└──────────────────────────────┬───────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────┐
│  ApprovalGate (rule-based, no LLM, ~1ms)                  │
│  Deterministic safety net that catches things              │
│  the LLM might miss                                       │
│  → CRITICAL risk detected → ask user                      │
└──────────────────────────────────────────────────────────┘
```

The LLM reasons about risk naturally as part of its planning. The approval gate
is a **deterministic safety net** that operates independently. This separation means:

1. Even if the LLM is manipulated by prompt injection, the gate still fires
2. Even if the LLM doesn't mention the risk, the gate catches it
3. The gate's behavior is auditable and predictable (no LLM variance)

### 5.7 Score Combination Formula

```
Pipeline:
  toolScore (from IRiskAssessor)
    + enhancer1.scoreBoost
    + enhancer2.scoreBoost
    + ...
  = finalScore (capped at 100)

Risk Levels:
  0-10:   none      → auto-approve
  11-30:  low       → auto-approve (default) or ask (configurable)
  31-60:  medium    → ask user
  61-85:  high      → ask user with warning
  86-100: critical  → ask user with strong warning + confirmation
```

### 5.8 Adding a New Tool: Zero Core Changes

Here's the extensibility proof. To add a hypothetical "email_tool" to pi desktop:

```typescript
// 1. Implement IRiskAssessor for the new tool
class EmailToolRiskAssessor implements IRiskAssessor {
  assess(action: string, params: Record<string, any>): RiskAssessment {
    if (action === 'read') return { score: 5, level: 'none', category: 'read_only', reasons: [] };
    if (action === 'draft') return { score: 20, level: 'low', category: 'communication', reasons: ['Drafting email'] };
    if (action === 'send') return { score: 60, level: 'high', category: 'communication',
      reasons: ['Sending email is irreversible'] };
    return { score: 40, level: 'medium', category: 'communication', reasons: [] };
  }
}

// 2. Register with ToolRegistry (pass assessor)
await registry.register(emailToolDef, emailToolHandler, new EmailToolRiskAssessor());

// 3. Done. No changes to ApprovalGate, PolicyRulesEngine, or any core code.
//    The existing rules engine, UI, and storage all work automatically.
```

Similarly for MCP tools discovered at runtime:

```typescript
// MCP tool discovered dynamically - create assessor on the fly
const assessor = mcpTool.riskProfile
  ? new StaticRiskAssessor({ riskProfile: mcpTool.riskProfile })
  : new DefaultMcpRiskAssessor(mcpTool.name);  // Unknown = medium risk

await registry.register(mcpTool.definition, mcpTool.handler, assessor);
```

---

## 6. Policy Rules Engine

### 6.1 Rule Structure

Inspired by Claude Code's allow/ask/deny pattern with glob matching:

```typescript
interface ApprovalRule {
  /** Unique rule ID */
  id: string;

  /** Rule priority (lower = higher priority). Deny rules implicitly get priority 0 */
  priority: number;

  /** What this rule does */
  effect: 'allow' | 'ask' | 'deny';

  /** Matching conditions (ALL must match) */
  conditions: RuleCondition[];

  /** Human-readable description */
  description: string;

  /** Rule scope */
  scope: 'session' | 'permanent';

  /** When this rule was created */
  createdAt: number;

  /** Who/what created this rule */
  source: 'built_in' | 'user_configured' | 'session_approval' | 'agent_suggested';
}

interface RuleCondition {
  /** What field to match */
  field: RuleField;

  /** Match operator */
  operator: 'equals' | 'matches' | 'contains' | 'starts_with' | 'in_list';

  /** Value to match against (supports glob for 'matches') */
  value: string | string[];
}

type RuleField =
  | 'tool'              // Tool name: 'browser_dom', 'navigation_tool'
  | 'action'            // Action name: 'click', 'type', 'snapshot'
  | 'risk_level'        // Computed risk: 'none', 'low', 'medium', 'high', 'critical'
  | 'risk_category'     // Risk category: 'read_only', 'form_submission', etc.
  | 'domain'            // Current page domain: '*.google.com', 'bank.example.com'
  | 'url_pattern'       // URL pattern: 'https://mail.google.com/*'
  | 'element_role'      // ARIA role: 'button', 'link', 'textbox'
  | 'element_text'      // Element visible text (for button clicks): 'Submit', 'Delete'
  | 'parameter'         // Specific parameter value: 'text=*password*'
  | 'mcp_server';       // MCP server name: 'github', 'filesystem'
```

### 6.2 Rule Evaluation Order

Following Claude Code's pattern: **deny > ask > allow**, with priority ordering within each group:

```
1. Evaluate all DENY rules (priority-ordered) → if any match → DENY
2. Evaluate all ASK rules (priority-ordered) → if any match → ASK
3. Evaluate all ALLOW rules (priority-ordered) → if any match → ALLOW
4. Fall back to risk-based default:
   - risk == 'none' or 'low' → ALLOW
   - risk == 'medium' → ASK
   - risk == 'high' or 'critical' → ASK with warning
```

### 6.3 Built-in Default Rules

Rules are organized into three groups: **shared** (both platforms), **extension-specific** (browserx), and **desktop-specific** (Pi). They are merged at startup based on `__BUILD_MODE__`.

```typescript
// ═══════════════════════════════════════════════════════════════
// SHARED RULES (both platforms)
// ═══════════════════════════════════════════════════════════════
const SHARED_BUILT_IN_RULES: ApprovalRule[] = [
  // ── ALLOW: Safe read-only actions ──
  {
    id: 'builtin:allow-read-only',
    priority: 100,
    effect: 'allow',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'read_only' }
    ],
    description: 'Auto-approve all read-only actions (snapshot, scroll, search, ls, cat)',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:allow-navigation',
    priority: 100,
    effect: 'allow',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'navigation' }
    ],
    description: 'Auto-approve navigation actions',
    scope: 'permanent',
    source: 'built_in',
  },

  // ── ASK: Risky but legitimate ──
  {
    id: 'builtin:ask-form-submission',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'form_submission' }
    ],
    description: 'Ask before submitting forms',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:ask-communication',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'communication' }
    ],
    description: 'Ask before sending messages/emails/posts',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:ask-data-modification',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'data_modification' }
    ],
    description: 'Ask before modifying/deleting data',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:ask-file-operation',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'file_operation' }
    ],
    description: 'Ask before file upload/download/write/delete',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:ask-sensitive-domain',
    priority: 40,
    effect: 'ask',
    conditions: [
      { field: 'domain', operator: 'matches', value: '*.bank.*|*.paypal.*|*.venmo.*|*.chase.*|*.wellsfargo.*' }
    ],
    description: 'Ask for any action on financial domains',
    scope: 'permanent',
    source: 'built_in',
  },

  // ── DENY: Dangerous defaults ──
  {
    id: 'builtin:deny-financial',
    priority: 10,
    effect: 'deny',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'financial' }
    ],
    description: 'Block financial transactions by default',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:deny-account-deletion',
    priority: 10,
    effect: 'deny',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'account_management' },
      { field: 'element_text', operator: 'matches', value: '*delete*account*|*deactivate*' },
    ],
    description: 'Block account deletion actions',
    scope: 'permanent',
    source: 'built_in',
  },
];

// ═══════════════════════════════════════════════════════════════
// EXTENSION-ONLY RULES (browserx Chrome extension)
// ═══════════════════════════════════════════════════════════════
const EXTENSION_BUILT_IN_RULES: ApprovalRule[] = [
  {
    id: 'builtin:ext:allow-dom-snapshot',
    priority: 100,
    effect: 'allow',
    conditions: [
      { field: 'tool', operator: 'equals', value: 'browser_dom' },
      { field: 'action', operator: 'equals', value: 'snapshot' },
    ],
    description: 'Auto-approve DOM snapshots',
    scope: 'permanent',
    source: 'built_in',
  },
  {
    id: 'builtin:ext:ask-storage-write',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'tool', operator: 'equals', value: 'storage_tool' },
      { field: 'action', operator: 'in_list', value: ['write', 'delete'] },
    ],
    description: 'Ask before modifying browser storage',
    scope: 'permanent',
    source: 'built_in',
  },
];

// ═══════════════════════════════════════════════════════════════
// DESKTOP-ONLY RULES (Pi Tauri desktop)
// ═══════════════════════════════════════════════════════════════
const DESKTOP_BUILT_IN_RULES: ApprovalRule[] = [
  // ── Terminal: read-only commands auto-approved ──
  {
    id: 'builtin:desktop:allow-readonly-cmds',
    priority: 90,
    effect: 'allow',
    conditions: [
      { field: 'tool', operator: 'equals', value: 'terminal' },
      { field: 'parameter', operator: 'matches',
        value: 'command=ls *|command=cat *|command=pwd|command=echo *|command=grep *|command=find *|command=head *|command=tail *|command=wc *' },
    ],
    description: 'Auto-approve read-only terminal commands',
    scope: 'permanent',
    source: 'built_in',
  },
  // ── Terminal: all other commands require approval ──
  {
    id: 'builtin:desktop:ask-terminal',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'tool', operator: 'equals', value: 'terminal' },
    ],
    description: 'Ask before executing terminal commands',
    scope: 'permanent',
    source: 'built_in',
  },
  // ── Terminal: block destructive system commands ──
  {
    id: 'builtin:desktop:deny-destructive-cmds',
    priority: 10,
    effect: 'deny',
    conditions: [
      { field: 'tool', operator: 'equals', value: 'terminal' },
      { field: 'parameter', operator: 'matches',
        value: 'command=rm -rf /*|command=mkfs*|command=dd if=*of=/dev/*|command=:(){ :|:& };:' },
    ],
    description: 'Block destructive system commands (rm -rf /, mkfs, dd, fork bomb)',
    scope: 'permanent',
    source: 'built_in',
  },
  // ── File operations: ask before write/delete ──
  {
    id: 'builtin:desktop:ask-file-write',
    priority: 50,
    effect: 'ask',
    conditions: [
      { field: 'risk_category', operator: 'equals', value: 'file_operation' },
      { field: 'action', operator: 'in_list', value: ['write', 'delete', 'move'] },
    ],
    description: 'Ask before modifying files on disk',
    scope: 'permanent',
    source: 'built_in',
  },
];

// ═══════════════════════════════════════════════════════════════
// MERGE AT STARTUP
// ═══════════════════════════════════════════════════════════════
function getBuiltInRules(): ApprovalRule[] {
  const shared = SHARED_BUILT_IN_RULES;
  const platform = __BUILD_MODE__ === 'desktop'
    ? DESKTOP_BUILT_IN_RULES
    : EXTENSION_BUILT_IN_RULES;
  return [...shared, ...platform];
}
```

### 6.4 Session Memory ("Remember This Decision")

When a user approves/denies an action, they can choose a scope:

```typescript
interface ApprovalDecisionWithMemory {
  decision: ReviewDecision;
  remember: 'no' | 'session' | 'permanent';
  /** Auto-generated rule from the decision context */
  generatedRule?: ApprovalRule;
}
```

When `remember === 'session'`: A session-scoped rule is created matching the tool+action+domain combination. It auto-expires when the session ends.

When `remember === 'permanent'`: A permanent rule is created and persisted via `IPolicyStorageAdapter` (extension: chrome.storage.local, desktop: TauriConfigStorage). It survives across sessions.

Example: User approves "click" on "linkedin.com" and checks "Remember for this session":

```typescript
// Auto-generated rule
{
  id: 'session:abc123',
  priority: 80,
  effect: 'allow',
  conditions: [
    { field: 'tool', operator: 'equals', value: 'browser_dom' },
    { field: 'action', operator: 'equals', value: 'click' },
    { field: 'domain', operator: 'equals', value: 'www.linkedin.com' },
  ],
  description: 'User approved clicking on LinkedIn (session)',
  scope: 'session',
  source: 'session_approval',
}
```

---

## 7. Approval Flow & Lifecycle

### 7.1 End-to-End Flow

```
Agent decides to use tool
         │
         ▼
┌─────────────────────┐
│   ToolRegistry      │
│   .execute()        │
│   (existing)        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│              ApprovalGate.evaluate()              │
│                                                   │
│  1. RiskClassifier.classify(tool, action, ctx)    │
│     → RiskAssessment { level, score, reasons }    │
│                                                   │
│  2. PolicyRulesEngine.evaluate(assessment, rules) │
│     → PolicyDecision { effect, matchedRule }      │
│                                                   │
│  3. Branch on PolicyDecision.effect:              │
│     ├── 'allow' → return APPROVED                 │
│     ├── 'deny'  → return DENIED                   │
│     └── 'ask'   → go to step 4                    │
│                                                   │
│  4. ApprovalManager.requestApproval(request)      │
│     → Emit ApprovalRequested event                │
│     → Wait for user decision (with timeout)       │
│     → Return APPROVED / DENIED / MODIFIED         │
│                                                   │
│  5. If user chose "remember":                     │
│     → PolicyStorage.addRule(generatedRule)         │
│                                                   │
└─────────────────┬───────────────────────────────┘
                  │
          ┌───────┴───────┐
          │               │
     APPROVED         DENIED
          │               │
          ▼               ▼
   Execute Tool    Return rejection
   Handler         to agent as
                   tool output
```

### 7.2 Approval Request Flow (User-Facing)

Both platforms use the same Svelte UI components; only the transport differs.

**Browserx (Chrome Extension):**
```
Service Worker                     Sidepanel UI
      │                                  │
      │  ApprovalRequested Event         │
      │  (via chrome.runtime.sendMsg)    │
      ├─────────────────────────────────►│
      │                                  │
      │                          ┌───────┴────────┐
      │                          │ Show inline     │
      │                          │ ApprovalBanner  │
      │                          │ in chat stream  │
      │                          └───────┬────────┘
      │                                  │
      │                          User clicks:
      │                          [Approve] [Deny]
      │                          □ Remember for session
      │                                  │
      │  ExecApproval Submission         │
      │  { decision, remember }          │
      │◄─────────────────────────────────┤
      │                                  │
      │  Resolve pending promise         │
      │  Continue tool execution         │
```

**Pi (Tauri Desktop):**
```
DesktopAgentBootstrap              Tauri Webview UI
(Main Thread)                      (Same Svelte components)
      │                                  │
      │  ApprovalRequested Event         │
      │  (via TauriChannel.sendEvent     │
      │   → emit 'browserx:event')      │
      ├─────────────────────────────────►│
      │                                  │
      │                          ┌───────┴────────┐
      │                          │ Show inline     │
      │                          │ ApprovalBanner  │
      │                          │ in chat stream  │
      │                          └───────┬────────┘
      │                                  │
      │                          User clicks:
      │                          [Approve] [Deny]
      │                          □ Remember for session
      │                                  │
      │  ExecApproval Submission         │
      │  (via TauriMessageService        │
      │   → emit 'browserx:submit')     │
      │◄─────────────────────────────────┤
      │                                  │
      │  Resolve pending promise         │
      │  Continue tool execution         │
```

**When UI is not visible (Pi only):**
Pi can minimize to system tray. If approval is needed while the window is hidden:
1. `TauriChannel.sendEvent()` emits the approval event
2. System tray shows notification via `showTrayNotification(title, body)`
3. Clicking notification calls `restoreFromTray()` to show the window
4. User sees the approval banner in the chat

### 7.3 Timeout Behavior

| Scenario | Default Timeout | Behavior |
|----------|----------------|----------|
| Low risk action | 30s | Auto-approve on timeout |
| Medium risk action | 60s | Auto-deny on timeout |
| High/Critical risk | 120s | Auto-deny on timeout |
| User actively viewing | No timeout | Wait indefinitely while UI is visible |

### 7.4 Agent Response to Denial

When a tool action is denied, the agent receives a structured error:

```typescript
// Tool output sent back to the agent
{
  type: 'function_call_output',
  call_id: 'call_xyz',
  output: JSON.stringify({
    success: false,
    error: {
      code: 'APPROVAL_DENIED',
      message: 'User denied this action: Click "Delete Account" button',
      details: {
        risk_level: 'critical',
        risk_category: 'account_management',
        user_reason: 'I don\'t want to delete my account',
        suggestion: 'Try a different approach or ask the user for guidance',
      },
    },
  }),
}
```

The agent's system prompt should include instructions to handle denial gracefully:
- Acknowledge the denial
- Explain what it was trying to do
- Suggest alternative approaches
- Ask the user for guidance

---

## 8. Risk Detection by Platform

### 8.0 Three-Layer Architecture

Both platforms share the same layered architecture. Layers 1-2 are shared code;
Layer 3 plugs in platform-specific detectors at startup.

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Platform-Specific Detectors (IContextEnhancer) │
│                                                          │
│  ┌────────────────────────┐ ┌──────────────────────────┐│
│  │ Browserx (Extension)    │ │ Pi (Desktop/Tauri)       ││
│  │                          │ │                          ││
│  │ • SemanticElement       │ │ • SensitivePath          ││
│  │   Enhancer (DOM labels, │ │   Enhancer (.env, /etc/, ││
│  │   submit/delete/buy)    │ │   .ssh, credentials)     ││
│  │ • FormSubmitDetector    │ │ • CommandRiskScorer      ││
│  │   (Enter-in-form)       │ │   (replaces SecurityFilter)│
│  └────────────────────────┘ └──────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  Layer 2: Shared Contextual Enhancers (IContextEnhancer) │
│  • DomainSensitivityEnhancer (URL patterns: bank, email) │
│  • ActionPatternDetector (tool+action generic patterns)  │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Tool-Owned Assessors (IRiskAssessor)           │
│  • Each tool registers its own assessor (or uses static  │
│    ToolMetadata fallback)                                │
│  • DomToolRiskAssessor, TerminalRiskAssessor,            │
│    McpBrowserRiskAssessor, etc.                          │
└─────────────────────────────────────────────────────────┘
```

**Registration at startup:**

```typescript
function registerPlatformDetectors(gate: ApprovalGate): void {
  // Shared (both platforms)
  gate.registerEnhancer(new DomainSensitivityEnhancer());

  if (__BUILD_MODE__ === 'desktop') {
    // Pi desktop enhancers
    gate.registerEnhancer(new SensitivePathEnhancer());
  } else {
    // Browserx extension enhancers
    gate.registerEnhancer(new SemanticElementEnhancer());
  }
}
```

### 8.1 Domain Sensitivity Detector (Shared - Both Platforms)

```typescript
class DomainSensitivityDetector {
  /** Known sensitive domain patterns */
  private patterns: DomainPattern[] = [
    // Financial
    { pattern: /bank|paypal|venmo|stripe|square|wise/i, category: 'financial', boost: 50 },
    { pattern: /chase|wellsfargo|bofa|citi|hsbc/i, category: 'financial', boost: 50 },
    { pattern: /coinbase|binance|kraken|crypto/i, category: 'financial', boost: 50 },

    // Email / Communication
    { pattern: /mail\.google|outlook\.live|yahoo\.mail/i, category: 'communication', boost: 30 },
    { pattern: /slack\.com|discord\.com|teams\.microsoft/i, category: 'communication', boost: 20 },

    // Social Media (posting)
    { pattern: /twitter\.com|x\.com|linkedin\.com|facebook\.com/i, category: 'communication', boost: 15 },

    // Authentication
    { pattern: /accounts\.google|login\.|signin\.|auth\./i, category: 'authentication', boost: 30 },
    { pattern: /sso\.|oauth\.|identity\./i, category: 'authentication', boost: 30 },

    // Shopping / E-commerce
    { pattern: /amazon\.com\/gp\/buy|checkout|cart/i, category: 'financial', boost: 40 },
    { pattern: /shopify|ebay\.com.*buy/i, category: 'financial', boost: 35 },

    // Healthcare
    { pattern: /mychart|patient.*portal|health/i, category: 'account_management', boost: 25 },

    // Government
    { pattern: /\.gov\b|irs\.gov|ssa\.gov/i, category: 'account_management', boost: 40 },
  ];

  assess(url: string): DomainAssessment {
    const domain = new URL(url).hostname;
    for (const pattern of this.patterns) {
      if (pattern.pattern.test(url) || pattern.pattern.test(domain)) {
        return {
          sensitive: true,
          category: pattern.category,
          riskBoost: pattern.boost,
          reason: `Sensitive domain detected: ${domain} (${pattern.category})`,
        };
      }
    }
    return { sensitive: false, category: null, riskBoost: 0, reason: null };
  }
}
```

### 8.2 Semantic Action Analyzer

Analyzes DOM elements to detect risky actions based on element semantics:

```typescript
class SemanticActionAnalyzer {
  /**
   * Analyze a DOM click/type action for risk signals.
   * Uses the element's role, aria-label, text content, and form context.
   */
  assess(
    action: string,
    parameters: Record<string, any>,
    domSnapshot: SerializedDom | null
  ): SemanticAssessment {

    if (action !== 'click' && action !== 'keypress') {
      return { riskBoost: 0, category: null, reasons: [] };
    }

    const nodeId = parameters.node_id;
    if (!nodeId || !domSnapshot) {
      return { riskBoost: 0, category: null, reasons: [] };
    }

    const element = this.findElement(domSnapshot, nodeId);
    if (!element) {
      return { riskBoost: 0, category: null, reasons: [] };
    }

    const reasons: string[] = [];
    let riskBoost = 0;
    let category: RiskCategory | null = null;

    // Check element text/label for danger signals
    const text = (element.aria_label || element.text || '').toLowerCase();
    const role = element.role || element.tag;

    // Submit/Send/Post detection
    if (this.isSubmitAction(text, role, element)) {
      riskBoost += 30;
      category = 'form_submission';
      reasons.push(`Submit action detected: "${text}"`);
    }

    // Delete/Remove detection
    if (this.isDeleteAction(text)) {
      riskBoost += 40;
      category = 'data_modification';
      reasons.push(`Delete action detected: "${text}"`);
    }

    // Purchase/Payment detection
    if (this.isPurchaseAction(text)) {
      riskBoost += 50;
      category = 'financial';
      reasons.push(`Purchase action detected: "${text}"`);
    }

    // Send/Post/Publish (communication) detection
    if (this.isCommunicationAction(text)) {
      riskBoost += 25;
      category = 'communication';
      reasons.push(`Communication action detected: "${text}"`);
    }

    // Login/Signup detection
    if (this.isAuthAction(text)) {
      riskBoost += 20;
      category = 'authentication';
      reasons.push(`Authentication action detected: "${text}"`);
    }

    return { riskBoost, category, reasons };
  }

  private isSubmitAction(text: string, role: string, element: any): boolean {
    const submitPatterns = /\b(submit|confirm|apply|save|update|proceed|continue|next|done|finish|complete)\b/i;
    const isSubmitButton = element.tag === 'button' && element.type === 'submit';
    const isFormSubmit = role === 'button' && submitPatterns.test(text);
    return isSubmitButton || isFormSubmit;
  }

  private isDeleteAction(text: string): boolean {
    return /\b(delete|remove|erase|destroy|drop|clear all|reset|unsubscribe|deactivate|close account)\b/i.test(text);
  }

  private isPurchaseAction(text: string): boolean {
    return /\b(buy|purchase|checkout|pay|place order|subscribe|upgrade|add to cart.*checkout|confirm order)\b/i.test(text);
  }

  private isCommunicationAction(text: string): boolean {
    return /\b(send|post|publish|tweet|reply|comment|share|broadcast|announce)\b/i.test(text);
  }

  private isAuthAction(text: string): boolean {
    return /\b(log ?in|sign ?in|sign ?up|register|create account|forgot password|reset password)\b/i.test(text);
  }
}
```

### 8.3 Enter Key as Form Submit Detection

When the agent presses Enter in a form field, detect if it would trigger form submission:

```typescript
// In RiskClassifier, special handling for keypress Enter
if (action === 'keypress' && parameters.key === 'Enter') {
  // Check if the focused element is inside a <form>
  // If so, elevate risk to 'form_submission' category
  const isInForm = this.isElementInForm(domSnapshot, parameters.node_id);
  if (isInForm) {
    assessment.category = 'form_submission';
    assessment.riskBoost += 25;
    assessment.reasons.push('Enter key in form context may trigger submission');
  }
}
```

### 8.4 Pi Desktop: Terminal Command Risk Scorer

Unifies the existing `SecurityFilter` (blocklist + risk score) with the approval system:

```typescript
class CommandRiskScorer {
  /**
   * Assess risk of a terminal command.
   * Replaces the existing SecurityFilter as the single source of truth.
   * Reuses SecurityFilter's blocklist patterns + adds risk scoring for the approval system.
   */
  assess(command: string): CommandRiskAssessment {
    // 1. Hard-block check (existing SecurityFilter patterns)
    const blockResult = this.checkBlocklist(command);
    if (blockResult.blocked) {
      return {
        riskBoost: 100,
        category: 'system_command',
        reasons: [`Blocked command pattern: ${blockResult.reason}`],
        suggestedAction: 'block',
      };
    }

    // 2. Risk scoring (extends existing SecurityFilter scoring)
    let score = 0;
    const reasons: string[] = [];

    // Privilege escalation
    if (/^sudo\b/.test(command)) {
      score += 30;
      reasons.push('Uses sudo (elevated privileges)');
    }

    // Destructive file operations
    if (/\brm\b/.test(command)) {
      score += 25;
      reasons.push('File deletion command');
      if (/\b-rf?\b/.test(command)) {
        score += 20;
        reasons.push('Recursive/forced deletion');
      }
    }

    // System modification
    if (/\b(chmod|chown|chgrp)\b/.test(command)) {
      score += 20;
      reasons.push('Permission/ownership change');
    }

    // Package management
    if (/\b(apt|brew|npm|pip|cargo)\s+(install|uninstall|remove)\b/.test(command)) {
      score += 15;
      reasons.push('Package installation/removal');
    }

    // Network operations
    if (/\b(curl|wget|ssh|scp|rsync)\b/.test(command)) {
      score += 10;
      reasons.push('Network operation');
    }

    // Git destructive operations
    if (/\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-f)\b/.test(command)) {
      score += 25;
      reasons.push('Destructive git operation');
    }

    // Shell piping (command chaining can obscure intent)
    if (/[|;&]/.test(command)) {
      score += 5;
      reasons.push('Command chaining detected');
    }

    // Process/service management
    if (/\b(kill|killall|systemctl|service)\b/.test(command)) {
      score += 20;
      reasons.push('Process/service management');
    }

    // Docker operations
    if (/\bdocker\s+(rm|rmi|system\s+prune|stop|kill)\b/.test(command)) {
      score += 15;
      reasons.push('Docker container/image modification');
    }

    // Read-only commands (reduce risk)
    if (/^(ls|cat|head|tail|grep|find|echo|pwd|whoami|date|uname|which|env|printenv)\b/.test(command)) {
      score = Math.max(0, score - 10);
    }

    return {
      riskBoost: score,
      category: 'system_command',
      reasons,
      suggestedAction: score >= 40 ? 'ask_user_with_warning' : score >= 15 ? 'ask_user' : 'auto_approve',
    };
  }
}
```

### 8.5 Pi Desktop: File Operation Risk Detector

```typescript
class FileOperationRiskDetector {
  assess(operation: string, filePath: string): FileRiskAssessment {
    let score = 0;
    const reasons: string[] = [];

    // Operation type
    switch (operation) {
      case 'read':
        score += 0; // Reading is safe
        break;
      case 'write':
        score += 15;
        reasons.push('File write operation');
        break;
      case 'delete':
        score += 35;
        reasons.push('File deletion');
        break;
      case 'move':
        score += 20;
        reasons.push('File move/rename');
        break;
    }

    // Sensitive file paths
    if (/\.(env|pem|key|cert|p12|pfx)$/i.test(filePath)) {
      score += 30;
      reasons.push('Sensitive file type (credentials/certificates)');
    }
    if (/\/(\.ssh|\.gnupg|\.config|\.aws)\//i.test(filePath)) {
      score += 30;
      reasons.push('Sensitive directory (credentials/config)');
    }
    if (/^\/etc\/|^\/usr\/|^\/sys\/|^\/boot\//i.test(filePath)) {
      score += 40;
      reasons.push('System directory modification');
    }
    if (/\/(node_modules|\.git)\//i.test(filePath)) {
      score += 5;
      reasons.push('Dependency/VCS directory');
    }

    return { riskBoost: score, category: 'file_operation', reasons };
  }
}
```

### 8.6 Pi Desktop: MCP Tool Risk Adapter

Desktop browser tools come via MCP (e.g., `browser__click`, `browser__navigate_page`). These need risk mapping:

```typescript
class MCPToolRiskAdapter {
  /**
   * Map MCP tool names to equivalent risk profiles.
   * Desktop browser tools via MCP have the same risk semantics
   * as extension DOM tools.
   */
  private static MCP_RISK_MAP: Record<string, ActionRiskProfile> = {
    // Read-only
    'browser__snapshot':        { risk: 'none', category: 'read_only', requiresApproval: false, description: 'Page snapshot' },
    'browser__console_logs':    { risk: 'none', category: 'read_only', requiresApproval: false, description: 'Read console' },
    'browser__get_page_metadata': { risk: 'none', category: 'read_only', requiresApproval: false, description: 'Page metadata' },

    // Navigation
    'browser__navigate_page':   { risk: 'low', category: 'navigation', requiresApproval: false, description: 'Navigate' },
    'browser__go_back':         { risk: 'none', category: 'navigation', requiresApproval: false, description: 'Go back' },
    'browser__go_forward':      { risk: 'none', category: 'navigation', requiresApproval: false, description: 'Go forward' },

    // Input (elevated by context)
    'browser__click':           { risk: 'low', category: 'input', requiresApproval: false, description: 'Click element' },
    'browser__type':            { risk: 'low', category: 'input', requiresApproval: false, description: 'Type text' },
    'browser__select_option':   { risk: 'low', category: 'input', requiresApproval: false, description: 'Select option' },
    'browser__scroll':          { risk: 'none', category: 'read_only', requiresApproval: false, description: 'Scroll' },

    // Potentially dangerous
    'browser__file_upload':     { risk: 'high', category: 'file_operation', requiresApproval: true, description: 'Upload file' },
    'browser__press_key':       { risk: 'low', category: 'input', requiresApproval: false, description: 'Press key' },
  };

  assess(mcpToolName: string): ActionRiskProfile {
    return this.MCP_RISK_MAP[mcpToolName] ?? {
      risk: 'medium',
      category: 'input',
      requiresApproval: true,
      description: `Unknown MCP tool: ${mcpToolName}`,
    };
  }
}
```

### 8.7 Pi Desktop: Terminal Risk Profile

```typescript
// Terminal tool risk profile (added alongside DOM_TOOL_RISK)
const TERMINAL_TOOL_RISK: ToolRiskProfile = {
  defaultRisk: 'medium',
  hasExternalSideEffects: true,
  isReversible: false,
  actions: {
    'execute': {
      risk: 'medium',  // Base; elevated by TerminalRiskAssessor
      category: 'system_command',
      requiresApproval: true,  // Always ask by default
      description: 'Execute terminal command',
    },
  },
};
```

### 8.8 SecurityFilter Migration (Pi Desktop)

The existing `SecurityFilter` in `src/desktop/tools/terminal/SecurityFilter.ts` has 26 blocked regex patterns and a risk scoring system (0-10). This is migrated into the unified approval system:

**Before (Current)**:
```
TerminalTool → SecurityFilter.check() → blocked/allowed
TerminalTool → SecurityFilter.needsConfirmation() → userConfirmed check
(Separate from ApprovalManager, no policy rules, no shared UI)
```

**After (Unified)**:
```
TerminalTool → ToolRegistry.execute() → ApprovalGate.evaluate()
  → TerminalRiskAssessor (absorbs SecurityFilter patterns)
    → Reuses SecurityFilter blocklist patterns
    → Produces RiskAssessment (0-100 scale)
  → SensitivePathEnhancer (file path context boost)
  → PolicyRulesEngine (user-configured rules)
  → ApprovalManager (shared UI prompt if needed)
```

**Migration steps**:
1. Extract SecurityFilter's 26 blocklist patterns into `TerminalRiskAssessor`
2. Map SecurityFilter's 0-10 risk scores to 0-100 scale (multiply by 10)
3. Convert `needsConfirmation()` prefixes (sudo, rm, mv, chmod, chown) into built-in ASK rules
4. Remove SecurityFilter from TerminalTool, route through ToolRegistry approval gate
5. TerminalTool handler becomes pure execution (no security checks)

### 8.9 Notification Strategy (Both Platforms)

| Scenario | Browserx (Extension) | Pi (Desktop) |
|----------|---------------------|--------------|
| Approval needed, UI visible | Inline banner in sidepanel chat | Inline banner in Tauri webview chat |
| Approval needed, UI hidden | Chrome notification API + badge icon | Tauri notification API + system tray |
| Critical risk, any state | Modal dialog (blocks chat) | Modal dialog + Tauri dialog API |
| Auto-approved, UI visible | Toast notification (2s fade) | Toast notification (2s fade) |
| Auto-approved, UI hidden | No notification (logged) | No notification (logged) |
| Timeout reached | Auto-deny + notification | Auto-deny + system tray alert |

### 8.10 Tool Risk Profiles: Complete Coverage

| Tool | Platform | Default Risk | Key Actions |
|------|----------|-------------|-------------|
| `browser_dom` | Extension | low | snapshot(none), click(low+context), type(low+context), scroll(none) |
| `browser__*` (MCP) | Desktop | low | Via McpBrowserRiskAssessor mapping (same semantics as browser_dom) |
| `terminal` | Desktop | medium | execute(medium+TerminalRiskAssessor) |
| `navigation_tool` | Extension | low | navigate(low), back/forward(none) |
| `web_search` | Both | none | search(none) |
| `planning_tool` | Both | none | All actions(none) — purely internal |
| `page_vision` | Extension | none | capture(none) |
| `data_extraction` | Extension | none | extract(none) |
| `web_scraping` | Extension | low | scrape(low) |
| `storage_tool` | Extension | medium | read(low), write(medium), delete(high) |
| `form_automation` | Extension | medium | fill(low), submit(high) |
| `network_intercept` | Extension | low | monitor(none), intercept(medium) |
| MCP tools (user-added) | Both | medium | Unknown tools default to ask |

---

## 9. UI/UX Design

### 9.1 Approval UI Modes

Based on industry research, we use **three UI modes** depending on risk level. Both platforms share the same Svelte UI components.

#### Mode 1: Silent Approval (Tier 0-1)

No UI shown. Action proceeds immediately. A subtle log entry appears in the debug/activity panel.

**Browserx example:**
```
[Activity Log]
  ✓ snapshot page DOM (auto-approved: read-only)
  ✓ scroll down (auto-approved: read-only)
  ✓ navigate to linkedin.com/feed (auto-approved: navigation)
```

**Pi example:**
```
[Activity Log]
  ✓ terminal: ls -la /home/user/project (auto-approved: read-only)
  ✓ terminal: cat package.json (auto-approved: read-only)
  ✓ terminal: grep -r "TODO" src/ (auto-approved: read-only)
  ✓ browser__take_snapshot (auto-approved: read-only)
```

#### Mode 2: Inline Banner (Tier 2-3)

Lightweight banner appears inline in the chat stream, replacing the heavy modal for most approval requests:

**Browserx example** (clicking a button):
```
┌──────────────────────────────────────────────────┐
│  ⚠ Approval Required                             │
│                                                    │
│  Click "Post" button on linkedin.com               │
│  Risk: MEDIUM · Category: Communication            │
│  Reason: Communication action on social media      │
│                                                    │
│  [✓ Approve]  [✗ Deny]  □ Remember for session    │
│                                     ⏱ 58s          │
└──────────────────────────────────────────────────┘
```

**Pi example** (terminal command):
```
┌──────────────────────────────────────────────────┐
│  ⚠ Approval Required                             │
│                                                    │
│  Terminal: npm install express                     │
│  Risk: MEDIUM · Category: System Command           │
│  Reason: Package installation (npm install)        │
│                                                    │
│  [✓ Approve]  [✗ Deny]  □ Remember for session    │
│                                     ⏱ 58s          │
└──────────────────────────────────────────────────┘
```

**Pi example** (MCP browser tool):
```
┌──────────────────────────────────────────────────┐
│  ⚠ Approval Required                             │
│                                                    │
│  browser__click element "Submit Application"       │
│  Risk: MEDIUM · Category: Form Submission          │
│  Reason: Submit action on jobs.example.com         │
│                                                    │
│  [✓ Approve]  [✗ Deny]  □ Remember for session    │
│                                     ⏱ 58s          │
└──────────────────────────────────────────────────┘
```

Features:
- Appears inline in the chat flow (not a blocking modal)
- Shows risk level with color indicator (green/yellow/orange/red)
- Shows the specific action and target (DOM element, command, or MCP tool)
- "Remember for session" checkbox
- Countdown timer (auto-denies on timeout)
- Compact design (doesn't overwhelm the chat)

#### Mode 3: Warning Dialog (Tier 4)

Full modal dialog for critical actions (reuses existing `ApprovalDialog.svelte` with enhancements):

**Browserx example** (financial transaction):
```
╔══════════════════════════════════════════════════════╗
║  🔴 HIGH RISK ACTION                                 ║
╠══════════════════════════════════════════════════════╣
║                                                       ║
║  The agent wants to:                                  ║
║  Click "Place Order - $149.99" button                 ║
║                                                       ║
║  Domain: amazon.com (Shopping)                        ║
║  Risk: CRITICAL · Category: Financial                 ║
║                                                       ║
║  ⚠ This action may result in a financial transaction  ║
║  ⚠ This action cannot be undone                       ║
║                                                       ║
║  ┌─────────────────────────────────────────────────┐  ║
║  │ Impact:                                          │  ║
║  │ • May complete a purchase for $149.99            │  ║
║  │ • Payment will be charged to your account        │  ║
║  └─────────────────────────────────────────────────┘  ║
║                                                       ║
║  [✓ Approve]  [✗ Deny]                               ║
║  □ Always allow purchases on amazon.com               ║
║                                           ⏱ 118s     ║
╚══════════════════════════════════════════════════════╝
```

**Pi example** (destructive terminal command):
```
╔══════════════════════════════════════════════════════╗
║  🔴 HIGH RISK ACTION                                 ║
╠══════════════════════════════════════════════════════╣
║                                                       ║
║  The agent wants to execute:                          ║
║  sudo rm -rf /var/log/old-backups/                    ║
║                                                       ║
║  CWD: /home/user/project                              ║
║  Risk: CRITICAL · Category: System Command             ║
║                                                       ║
║  ⚠ Uses elevated privileges (sudo)                    ║
║  ⚠ Recursive forced deletion (rm -rf)                 ║
║  ⚠ This action cannot be undone                       ║
║                                                       ║
║  ┌─────────────────────────────────────────────────┐  ║
║  │ Impact:                                          │  ║
║  │ • Permanently deletes /var/log/old-backups/      │  ║
║  │ • Requires sudo password                          │  ║
║  │ • Files cannot be recovered                       │  ║
║  └─────────────────────────────────────────────────┘  ║
║                                                       ║
║  [✓ Approve]  [✗ Deny]                               ║
║                                           ⏱ 118s     ║
╚══════════════════════════════════════════════════════╝
```

### 9.2 Approval Settings Panel

New settings section accessible from Settings page. The panel adapts to show platform-relevant rules:

**Shared settings (both platforms):**
```
┌──────────────────────────────────────────────────┐
│  Safety & Approvals                               │
│                                                    │
│  Approval Mode:                                    │
│  ○ Cautious (ask for all non-read actions)        │
│  ● Balanced (ask for medium+ risk actions)         │
│  ○ Autonomous (ask only for high+ risk actions)   │
│  ○ YOLO (auto-approve everything - dangerous!)    │
│                                                    │
│  ─────────────────────────────────────────────     │
│                                                    │
│  Built-in Rules:                                   │
│  ✓ Allow: Read-only actions              [shared]  │
│  ✓ Allow: Navigation                     [shared]  │
│  ⚠ Ask: Form submissions                 [shared]  │
│  ⚠ Ask: Send messages/emails              [shared]  │
│  ✗ Deny: Financial transactions           [shared]  │
│                                                    │
│  Trusted Domains:                 [+ Add Domain]   │
│  • google.com (all actions auto-approved)          │
│  • github.com (all actions auto-approved)          │
│                                                    │
│  Blocked Domains:                 [+ Add Domain]   │
│  • *.bank.com (all actions blocked)               │
│                                                    │
│  Session Decisions:                                │
│  ✓ Allowed: Click on linkedin.com (this session)  │
│  [Clear Session Decisions]                         │
└──────────────────────────────────────────────────┘
```

**Additional Pi-specific section (desktop only):**
```
│  ─────────────────────────────────────────────     │
│                                                    │
│  Terminal Rules:                                   │
│  ✓ Allow: Read-only commands (ls, cat, grep...)    │
│  ⚠ Ask: All other terminal commands       [built-in]│
│  ✗ Deny: Destructive commands (rm -rf /)  [built-in]│
│  ──────────────────────────────                    │
│  ✓ Allow: npm install *           [user] [🗑]     │
│  ✓ Allow: git push origin main    [user] [🗑]     │
│                                                    │
│  Allowed Commands:                [+ Add Pattern]  │
│  • git status|log|diff|branch (auto-approved)     │
│  • docker ps|images|logs (auto-approved)          │
│                                                    │
│  Blocked Commands:                [+ Add Pattern]  │
│  • rm -rf /* (always blocked)                     │
│  • curl*|sh (always blocked)                      │
│                                                    │
```

**Additional Browserx-specific section (extension only):**
```
│  ─────────────────────────────────────────────     │
│                                                    │
│  Browser Rules:                                    │
│  ✓ Allow: DOM snapshot                    [built-in]│
│  ⚠ Ask: Browser storage write/delete     [built-in]│
│  ──────────────────────────────                    │
│  ✓ Allow: Click on *.google.com    [user] [🗑]    │
│  ⚠ Ask: Type on mail.google.com    [user] [🗑]    │
│                                                    │
```

### 9.3 Approval Mode Presets

| Mode | Risk Threshold | Use Case |
|------|---------------|----------|
| **Cautious** | Ask for `low` and above | New users, sensitive work, unfamiliar sites |
| **Balanced** | Ask for `medium` and above | Default for most users |
| **Autonomous** | Ask for `high` and above | Experienced users, trusted workflows |
| **YOLO** | Never ask (auto-approve all) | Development/testing only, with warning |

### 9.4 Notification for Auto-Approved Actions

Even when auto-approved, important actions should show a brief toast notification:

```
┌─────────────────────────────────────────┐
│  ✓ Auto-approved: Navigate to github.com │
│  Rule: Allow navigation (built-in)       │
└─────────────────────────────────────────┘
  (fades after 2 seconds)
```

This prevents the "what is it doing?" problem where the agent acts silently.

---

## 10. Integration Points

### 10.1 ToolRegistry Integration

Two changes to ToolRegistry:

**Change 1**: `register()` accepts optional `IRiskAssessor`:

```typescript
// Enhanced ToolRegistry.register()
async register(
  tool: ToolDefinition,
  handler: ToolHandler,
  riskAssessor?: IRiskAssessor  // NEW
): Promise<void> {
  const entry: ToolRegistryEntry = {
    definition: tool,
    handler,
    riskAssessor: riskAssessor ?? null,  // NEW
    registrationTime: Date.now(),
  };
  this.tools.set(toolName, entry);
}
```

**Change 2**: `execute()` calls `ApprovalGate` before the handler:

```typescript
// Enhanced ToolRegistry.execute()
async execute(request: ToolExecutionRequest): Promise<ToolExecutionResponse> {
  const startTime = Date.now();
  const entry = this.tools.get(request.toolName);
  if (!entry) {
    return { success: false, error: { code: 'TOOL_NOT_FOUND', ... }, duration: 0 };
  }

  // Validate parameters (existing, unchanged)
  const validation = this.validate(request.toolName, request.parameters);
  if (!validation.valid) {
    return { success: false, error: { code: 'VALIDATION_ERROR', ... }, duration: 0 };
  }

  // ── NEW: Approval gate ──
  if (this.approvalGate) {
    const action = request.parameters.action || request.toolName;
    const context: ApprovalContext = {
      currentUrl: request.metadata?.currentUrl,
      currentDomain: request.metadata?.currentUrl
        ? new URL(request.metadata.currentUrl).hostname : undefined,
      tabId: request.tabId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      domSnapshot: request.metadata?.lastSnapshot,
      cwd: request.metadata?.cwd,
      platform: __BUILD_MODE__ === 'desktop' ? 'desktop' : 'extension',
    };

    const result = await this.approvalGate.evaluate(
      request.toolName,
      action,
      request.parameters,
      entry.riskAssessor,       // Tool's own assessor (or null)
      entry.definition.metadata, // Static metadata fallback
      context
    );

    if (result.decision === 'deny') {
      return {
        success: false,
        error: {
          code: 'APPROVAL_DENIED',
          message: `Action denied: ${result.assessment.reasons.join('; ')}`,
          details: {
            riskLevel: result.assessment.level,
            category: result.assessment.category,
            source: result.source,
          },
        },
        duration: Date.now() - startTime,
      };
    }
  }

  // Execute tool handler (existing, unchanged)
  return this.executeHandler(entry, request);
}
```

The ToolRegistry knows nothing about specific tools, risk levels, or domains. It just calls `approvalGate.evaluate()` and respects the result.

### 10.2 Event System Integration

New event types added to `EventMsg`:

```typescript
// New events in src/core/protocol/events.ts
| { type: 'ApprovalRequested'; data: ApprovalRequestedEvent }
| { type: 'ApprovalAutoApproved'; data: ApprovalAutoEvent }
| { type: 'ApprovalAutoDenied'; data: ApprovalAutoEvent }
| { type: 'ApprovalUserDecision'; data: ApprovalUserDecisionEvent }
| { type: 'ApprovalTimeout'; data: ApprovalTimeoutEvent }

interface ApprovalRequestedEvent {
  id: string;
  toolName: string;
  action: string;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  riskCategory: RiskCategory;
  reasons: string[];
  title: string;
  description: string;
  elementContext?: {
    tag: string;
    role?: string;
    text?: string;
    ariaLabel?: string;
  };
  domain?: string;
  timeout: number;
}

interface ApprovalAutoEvent {
  id: string;
  toolName: string;
  action: string;
  riskLevel: string;
  matchedRule: string;
  reason: string;
}

interface ApprovalUserDecisionEvent {
  id: string;
  decision: ReviewDecision;
  remember: 'no' | 'session' | 'permanent';
  reason?: string;
}

interface ApprovalTimeoutEvent {
  id: string;
  timeoutMs: number;
  defaultDecision: 'approve' | 'deny';
}
```

### 10.3 Message/Event Integration (Both Platforms)

New message types for approval communication. Same message types, different transports:

```typescript
// Approval message types (used by both platforms)
| 'APPROVAL_REQUEST'        // Agent → UI: Show approval UI
| 'APPROVAL_DECISION'       // UI → Agent: User's decision
| 'APPROVAL_POLICY_UPDATE'  // UI → Agent: Policy config change
| 'APPROVAL_RULES_SYNC'     // Bidirectional: Sync rules between storage and memory
```

**Browserx transport** (chrome.runtime):
```typescript
// Agent → UI: via chrome.runtime.sendMessage from Service Worker
chrome.runtime.sendMessage({ type: 'APPROVAL_REQUEST', data: request });

// UI → Agent: via chrome.runtime.sendMessage from Sidepanel
chrome.runtime.sendMessage({ type: 'APPROVAL_DECISION', data: decision });
```

**Pi transport** (Tauri events):
```typescript
// Agent → UI: via TauriChannel.sendEvent() → emit('browserx:event')
import { emit } from '@tauri-apps/api/event';
emit('browserx:event', { type: 'APPROVAL_REQUEST', data: request });

// UI → Agent: via TauriMessageService → emit('browserx:submit')
emit('browserx:submit', { type: 'APPROVAL_DECISION', data: decision });
```

### 10.4 System Prompt Integration

Add approval instructions to the agent's system prompt. The prompt is platform-adaptive:

**Shared instructions (both platforms):**
```
## Action Approval System

This agent has a safety system that may ask the user for approval before certain
actions are executed. When your action is denied:

1. Acknowledge the denial clearly
2. Explain what you were trying to do and why
3. Suggest alternative approaches if available
4. Ask the user for guidance on how to proceed

When you anticipate an action may require approval, briefly explain what you're
about to do and why, so the user has context when the approval prompt appears.
```

**Browserx-specific additions:**
```
Actions that typically require approval:
- Submitting forms (contact forms, applications, etc.)
- Clicking "Send", "Post", "Publish" buttons
- Actions on financial/banking websites
- File upload or download
- Account management actions (delete, deactivate)

Actions that are auto-approved (no user interaction needed):
- Reading page content (DOM snapshots)
- Scrolling
- Navigation between pages
- Clicking menus, tabs, accordion panels
- Web search
```

**Pi-specific additions:**
```
Actions that typically require approval:
- Terminal commands that modify files (rm, mv, chmod, chown)
- Package installation/removal (npm install, pip install, apt install)
- Network operations (curl, wget, ssh, git push)
- Commands with sudo or elevated privileges
- Browser actions on financial/banking websites
- Clicking "Send", "Post", "Submit" in browser

Actions that are auto-approved (no user interaction needed):
- Read-only terminal commands (ls, cat, grep, find, head, tail, pwd)
- Git read operations (git status, git log, git diff)
- Reading browser page content (snapshots, console logs)
- Web search
- Planning and reasoning

When running terminal commands, prefer read-only alternatives when possible
(e.g., use 'cat' instead of opening in an editor). This reduces approval prompts.
```

### 10.5 Tool Context Passing

To enable contextual risk analysis, the tool execution request carries platform-relevant metadata:

```typescript
// Enhanced ToolExecutionRequest.metadata
interface ToolExecutionRequest {
  toolName: string;
  parameters: Record<string, any>;
  sessionId: string;
  turnId: string;
  tabId?: number;
  timeout?: number;
  metadata?: {
    tabId?: number;

    // ── Shared context (both platforms) ──
    currentUrl?: string;          // Current page URL (extension tab or MCP browser)
    platform: 'extension' | 'desktop';

    // ── Browserx-specific context ──
    lastSnapshot?: SerializedDom; // Last DOM snapshot for element semantic analysis

    // ── Pi-specific context ──
    cwd?: string;                 // Current working directory for terminal commands
    filePath?: string;            // Target file path for file operations
  };
}
```

**Who populates this context:**

| Field | Browserx | Pi |
|-------|----------|-----|
| `currentUrl` | Active tab URL via `chrome.tabs.query()` | MCP browser's current URL (if connected) |
| `lastSnapshot` | Cached from last `browser_dom` snapshot call | Cached from last `browser__take_snapshot` MCP call |
| `cwd` | N/A | Terminal's current working directory |
| `filePath` | N/A | Target path from file operation parameters |
| `platform` | `'extension'` (from `__BUILD_MODE__`) | `'desktop'` (from `__BUILD_MODE__`) |

---

## 11. Data Model & Storage

### 11.1 Storage Schema

#### Storage Backend

Uses the existing **`ConfigStorageProvider`** pattern (same as AgentConfig and MCP config):

| Platform | Implementation | Backend |
|----------|---------------|---------|
| **Browserx** | `ChromePolicyStorage` | `chrome.storage.local` |
| **Pi Desktop** | `TauriPolicyStorage` | Tauri JSON file via `invoke('config_storage_set')` |

This means **no new storage infrastructure** is needed. The approval config rides on the same abstraction that already works cross-platform.

```typescript
/**
 * Platform-agnostic policy storage.
 * Selected at startup based on __BUILD_MODE__.
 */
interface IPolicyStorageAdapter {
  loadRules(): Promise<ApprovalRule[]>;
  saveRules(rules: ApprovalRule[]): Promise<void>;
  addRule(rule: ApprovalRule): Promise<void>;
  removeRule(ruleId: string): Promise<void>;

  loadApprovalMode(): Promise<ApprovalMode>;
  saveApprovalMode(mode: ApprovalMode): Promise<void>;

  loadTrustedDomains(): Promise<string[]>;
  saveTrustedDomains(domains: string[]): Promise<void>;

  loadBlockedDomains(): Promise<string[]>;
  saveBlockedDomains(domains: string[]): Promise<void>;

  loadHistory(limit?: number): Promise<ApprovalHistoryEntry[]>;
  appendHistory(entry: ApprovalHistoryEntry): Promise<void>;
  clearHistory(): Promise<void>;
}

// Implementation selection at startup
function createPolicyStorage(): IPolicyStorageAdapter {
  if (__BUILD_MODE__ === 'desktop') {
    return new TauriPolicyStorage();  // TauriConfigStorage JSON
  }
  return new ChromePolicyStorage();   // chrome.storage.local
}
```

#### Storage Keys

Add to `STORAGE_KEYS` in `src/config/defaults.ts`:

```typescript
export const STORAGE_KEYS = {
  CONFIG: 'agent_config',
  CONFIG_VERSION: 'config_version',
  APPROVAL_CONFIG: 'approval_config',    // NEW
  APPROVAL_HISTORY: 'approval_history',  // NEW
} as const;
```

#### Key 1: `approval_config` (Persistent Settings)

```typescript
interface IApprovalConfig {
  /** Schema version for migrations */
  version: '1.0.0';

  /** Active approval mode preset */
  mode: 'cautious' | 'balanced' | 'autonomous' | 'yolo';

  /** Custom user-configured rules (built-in rules loaded from code, not stored) */
  userRules: ApprovalRule[];

  /** Domains where all actions are auto-approved */
  trustedDomains: string[];

  /** Domains where all actions are denied */
  blockedDomains: string[];

  /** Pi Desktop only: auto-approve terminal command patterns */
  allowedCommands?: string[];

  /** Pi Desktop only: always block terminal command patterns */
  blockedCommands?: string[];

  /** Per-risk-level timeout overrides (ms) */
  timeouts: {
    low: number;      // default: 30000
    medium: number;   // default: 60000
    high: number;     // default: 120000
    critical: number; // default: 120000
  };
}
```

Estimated size: ~5-20KB (well within chrome.storage.local 10MB limit or TauriConfigStorage).

#### Key 2: `approval_history` (Audit Log)

```typescript
// Rotated at 100 entries (oldest removed when limit reached)
type StoredApprovalHistory = ApprovalHistoryEntry[];
```

Estimated size: ~20-50KB at 100 entries.

#### Session-Scoped Decisions (In-Memory Only)

Session approvals ("remember for this session") are **NOT persisted** to storage:

```typescript
// Inside ApprovalGate, cleared on session end
private sessionDecisions = new Map<string, ApprovalRule>();

// Cleared when:
// - Session ends (user starts new conversation)
// - User clicks "Clear Session Decisions" in settings
// - Agent is reinitialized
```

This keeps temporary decisions fast and automatically cleaned up.

#### Why NOT Other Storage Options

| Option | Why Not |
|--------|---------|
| Inside `agent_config` | Config is already large; approval rules grow independently; different migration cadence |
| IndexedDB | Overkill for small config data; IndexedDB is for high-volume data (cache, sessions) |
| CredentialStore / Keychain | Rules aren't secrets; keychain is for API keys |
| Separate file / new mechanism | Breaks existing `ConfigStorageProvider` pattern |

#### Runtime vs Stored Rules

Built-in rules are **loaded from code at startup**, not stored:

```typescript
// At initialization:
const storedConfig = await configStorage.get<IApprovalConfig>('approval_config');
const builtInRules = getBuiltInRules();  // From src/core/approval/defaultRules.ts
const userRules = storedConfig?.userRules ?? [];

// Merge: built-in + user rules (user rules can override built-in)
this.activeRules = [...builtInRules, ...userRules];
```

This way, built-in rules can be updated with new app versions without conflicting with user customizations.

### 11.2 History Entry

```typescript
interface ApprovalHistoryEntry {
  id: string;
  timestamp: number;
  toolName: string;
  action: string;
  domain: string;
  riskLevel: string;
  riskCategory: RiskCategory;
  decision: ReviewDecision;
  decisionSource: 'auto_rule' | 'user_manual' | 'timeout';
  matchedRule?: string;
  sessionId: string;
}
```

### 11.3 Migration

Add approval settings to the existing `AgentConfig` migration chain:

```typescript
// Version 1.2.0: Add approval settings
{
  approval: {
    mode: 'balanced',
    rules: [...BUILT_IN_RULES],
    trustedDomains: [],
    blockedDomains: [],
  }
}
```

---

## 12. Implementation Phases

### Phase 1: Core Infrastructure (P0) — Both Platforms

**Goal**: Wire approval gate into tool execution pipeline for BOTH browserx and Pi.

| Task | Files | Platform | Description |
|------|-------|----------|-------------|
| Create `IRiskAssessor` interface | `src/core/approval/types.ts` | Shared | Interface for tool-owned risk assessment |
| Create `IContextEnhancer` interface | `src/core/approval/types.ts` | Shared | Interface for pluggable context enhancers |
| Create `PolicyRulesEngine` | `src/core/approval/PolicyRulesEngine.ts` | Shared | Rule evaluation with deny/ask/allow ordering |
| Create `ApprovalGate` | `src/core/approval/ApprovalGate.ts` | Shared | Tool-agnostic orchestrator |
| Create `IPolicyStorageAdapter` | `src/core/approval/PolicyStorage.ts` | Shared | Storage interface |
| Create `ChromePolicyStorage` | `src/core/approval/ChromePolicyStorage.ts` | Extension | chrome.storage.local implementation |
| Create `TauriPolicyStorage` | `src/core/approval/TauriPolicyStorage.ts` | Desktop | TauriConfigStorage implementation |
| Enhance `ToolMetadata` | `src/tools/BaseTool.ts` | Shared | Add `riskProfile` field |
| Wire into `ToolRegistry` | `src/tools/ToolRegistry.ts` | Shared | Accept `IRiskAssessor`, call ApprovalGate before execute() |
| Create `DomToolRiskAssessor` | `src/tools/DOMTool.ts` | Extension | Risk assessor for DOM tool |
| Create `TerminalRiskAssessor` | `src/desktop/tools/terminal/` | Desktop | Risk assessor for terminal (replaces SecurityFilter) |
| Create `McpBrowserRiskAssessor` | `src/desktop/tools/` | Desktop | Risk assessor for MCP browser tools |
| Add approval events | `src/core/protocol/events.ts` | Shared | New event types for approval flow |
| Add message types | Both message services | Both | `APPROVAL_REQUEST`, `APPROVAL_DECISION` |
| Create default rules | `src/core/approval/defaultRules.ts` | Shared | Built-in rules (shared + platform-specific) |

### Phase 2: Context Enhancers & Risk Detection (P1)

**Goal**: Intelligent context-aware risk detection for both platforms.

| Task | Files | Platform | Description |
|------|-------|----------|-------------|
| Create `DomainSensitivityEnhancer` | `src/core/approval/enhancers/` | Shared | Domain pattern matching for sensitive sites |
| Create `SemanticElementEnhancer` | `src/core/approval/enhancers/ext/` | Browserx | DOM element semantics (submit/delete/buy buttons) |
| Create `SensitivePathEnhancer` | `src/core/approval/enhancers/desktop/` | Pi | File path sensitivity (.env, /etc/, .ssh) |
| Pass DOM snapshot to risk context | `src/tools/ToolRegistry.ts` | Browserx | Include last snapshot in execution context |
| Pass CWD/file context | `src/desktop/tools/` | Pi | Include cwd, filePath in execution metadata |
| Pass current URL to risk context | Service worker / DesktopBootstrap | Both | Include tab URL in tool execution metadata |
| Enter-as-submit detection | `SemanticElementEnhancer` | Browserx | Detect Enter key in form context |
| Migrate SecurityFilter | `src/desktop/tools/terminal/` | Pi | Absorb SecurityFilter patterns into TerminalRiskAssessor |
| Remove SecurityFilter from TerminalTool | `src/desktop/tools/terminal/TerminalTool.ts` | Pi | Route through ApprovalGate instead of direct SecurityFilter |

### Phase 3: UI/UX (P1)

**Goal**: User-facing approval interface.

| Task | Files | Description |
|------|-------|-------------|
| Create `ApprovalBanner.svelte` | `src/extension/sidepanel/components/` | Inline chat approval banner |
| Enhance `ApprovalDialog.svelte` | Existing file | Add "remember" options, improve critical risk display |
| Create `ApprovalSettingsPanel.svelte` | `src/extension/sidepanel/settings/` | Rules configuration UI |
| Integrate into chat flow | `Main.svelte` or `EventDisplay` | Show banners inline with chat messages |
| Add approval mode selector | Settings page | Cautious/Balanced/Autonomous/YOLO modes |

### Phase 4: Policy & Memory (P1)

**Goal**: Remember decisions and configure policies.

| Task | Files | Description |
|------|-------|-------------|
| Create `PolicyStorage` | `src/core/approval/PolicyStorage.ts` | Persist rules via IPolicyStorageAdapter |
| Session memory | `ApprovalGate` | Track session-scoped decisions in memory |
| "Remember" UI integration | `ApprovalBanner.svelte` | Checkbox for session/permanent remembering |
| Rule auto-generation | `ApprovalGate` | Generate rules from user decisions |
| Built-in rules | `src/core/approval/defaultRules.ts` | Ship default rule set |
| Trusted/blocked domains | `PolicyStorage` | Per-domain override lists |

### Phase 5: Advanced Features (P2)

**Goal**: Polish and advanced capabilities.

| Task | Files | Description |
|------|-------|-------------|
| Agent system prompt | Prompt templates | Add approval-aware instructions |
| Activity log | New UI component | Show auto-approved actions in debug panel |
| Approval analytics | History storage | Track approval patterns for user review |
| MCP tool approval | `MCPToolAdapter.ts` | Apply approval gate to MCP tools |
| Export/import rules | Settings | Allow rule sharing across devices |
| Approval hooks API | `ApprovalGate` | Allow extensions/hooks to add custom rules |

---

## Appendix A: File Structure

```
src/core/approval/                       # SHARED CORE (both platforms)
  ├── types.ts                          # IRiskAssessor, IContextEnhancer, RiskAssessment, etc.
  ├── ApprovalGate.ts                   # Tool-agnostic orchestrator
  ├── PolicyRulesEngine.ts              # Rule evaluation (deny > ask > allow)
  ├── PolicyStorage.ts                  # IPolicyStorageAdapter interface
  ├── ChromePolicyStorage.ts            # Extension: chrome.storage.local
  ├── TauriPolicyStorage.ts             # Desktop: TauriConfigStorage JSON
  ├── defaultRules.ts                   # Built-in rules (shared + platform-specific)
  │
  ├── assessors/                        # Tool-owned IRiskAssessor implementations
  │   ├── DomToolRiskAssessor.ts       # Extension: browser_dom tool
  │   ├── NavigationRiskAssessor.ts    # Extension: navigation_tool
  │   ├── TerminalRiskAssessor.ts      # Desktop: terminal tool (absorbs SecurityFilter)
  │   ├── McpBrowserRiskAssessor.ts    # Desktop: browser__* MCP tools
  │   └── StaticRiskAssessor.ts        # Fallback: reads from ToolMetadata
  │
  ├── enhancers/                        # Pluggable IContextEnhancer implementations
  │   ├── DomainSensitivityEnhancer.ts # Shared: URL patterns (bank, email, auth)
  │   ├── ext/                          # Browserx extension only
  │   │   └── SemanticElementEnhancer.ts  # DOM element labels (submit/delete/buy)
  │   └── desktop/                      # Pi desktop only
  │       └── SensitivePathEnhancer.ts # File path sensitivity (.env, /etc/, .ssh)
  │
  └── __tests__/
      ├── ApprovalGate.test.ts
      ├── PolicyRulesEngine.test.ts
      ├── DomToolRiskAssessor.test.ts
      ├── TerminalRiskAssessor.test.ts
      ├── McpBrowserRiskAssessor.test.ts
      ├── DomainSensitivityEnhancer.test.ts
      ├── SemanticElementEnhancer.test.ts
      └── SensitivePathEnhancer.test.ts

src/extension/sidepanel/components/      # SHARED UI (both platforms use same Svelte)
  ├── approval/
  │   ├── ApprovalBanner.svelte         # Inline chat approval (both platforms)
  │   └── ApprovalActivityLog.svelte    # Auto-approved actions log (both platforms)
  └── common/
      └── ApprovalDialog.svelte         # Enhanced modal (existing, both platforms)

src/extension/sidepanel/settings/
  └── ApprovalSettings.svelte           # Rules config (adapts to platform)
```

## Appendix B: Comparison with Existing ApprovalManager

| Feature | Current ApprovalManager | New ApprovalGate |
|---------|------------------------|-------------------|
| Policy modes | 4 static modes | Dynamic rule engine with priorities |
| Risk classification | Single `riskLevel` field | Tool-owned assessors + context enhancers |
| Domain awareness | `trustedDomains[]` in policy | Pluggable `DomainSensitivityEnhancer` |
| Element semantics | None | Pluggable `SemanticElementEnhancer` |
| Memory | None | Session + permanent rule generation |
| UI | Modal dialog only | Inline banner (default) + modal (critical) |
| Integration | Not wired in | Wired into ToolRegistry.execute() |
| Rules | None | Allow/ask/deny with glob matching |
| Built-in defaults | None | Shared + platform-specific default rules |
| New tool support | N/A | Zero core changes (tool provides IRiskAssessor) |
| MCP tools | N/A | Dynamic assessor registration at runtime |

The existing `ApprovalManager` will be **kept and enhanced**, not replaced. `ApprovalGate` wraps it and adds the risk assessment pipeline, policy rules, and session memory layers on top.

## Appendix C: Extensibility Matrix

How to extend the system for different scenarios without modifying core code:

| Scenario | What To Do | Core Changes? |
|----------|-----------|---------------|
| Add a new tool | Implement `IRiskAssessor`, pass to `registry.register()` | None |
| New MCP tool discovered at runtime | Create assessor from tool metadata or use `DefaultMcpRiskAssessor` | None |
| New sensitive domain pattern | Add pattern to `DomainSensitivityEnhancer` | None (config/data) |
| New danger signal (e.g., CAPTCHA detection) | Implement `IContextEnhancer`, register at startup | None |
| New platform (e.g., mobile) | Register platform-specific enhancers, implement `IPolicyStorageAdapter` | None |
| Custom enterprise rules | Add rules to `approval_config` in storage | None |
| New approval UI variant | New Svelte component consuming same events | None |

---

## Appendix D: Cross-Platform Quick Reference

> **Note**: Cross-platform details are integrated throughout this document
> (Sections 4.1, 6.3, 7.2, 8.0-8.10, 9.2, 10.3-10.5, 11.1, 12).
> This appendix provides a compact summary.

### D.1 Platform Comparison

| Aspect | Browserx (Extension) | Pi (Desktop/Tauri) |
|--------|---------------------|---------------------|
| **Browser tools** | `browser_dom` (Chrome Extension API) | `browser__*` (MCP via chrome-devtools-mcp) |
| **Terminal** | N/A | `terminal` tool (SecurityFilter → TerminalRiskAssessor) |
| **Agent process** | Background Service Worker | Main thread (DesktopAgentBootstrap) |
| **Messaging** | `ChromeMessageService` (chrome.runtime) | `TauriMessageService` (Tauri events) |
| **Storage** | `chrome.storage.local` | `TauriConfigStorage` (JSON via Rust) |
| **Credentials** | `chrome.storage.local` (encrypted) | OS Keychain (KeytarCredentialStore) |
| **Notifications** | Chrome notifications API + badge | Tauri notification API + system tray |
| **UI** | Sidepanel (Svelte) | Tauri Webview (same Svelte components) |
| **Risk assessors** | DomToolRiskAssessor, NavigationRiskAssessor | TerminalRiskAssessor, McpBrowserRiskAssessor |
| **Context enhancers** | SemanticElementEnhancer (DOM labels) | SensitivePathEnhancer (file paths) |
| **Shared enhancers** | DomainSensitivityEnhancer | DomainSensitivityEnhancer |
├─────────────────────┬─────────────────────────────────────────────┤
│  Browserx Detectors │  Pi Desktop Detectors                      │
│  (src/core/approval │  (src/core/approval/detectors/desktop/)    │
│   /detectors/ext/)  │                                            │
│                     │                                            │
│  • SemanticAction   │  • CommandRiskScorer                       │
│    Analyzer (DOM)   │    (terminal cmds, replaces SecurityFilter)│
│  • FormSubmit       │  • FileOperationRiskDetector               │
│    Detector         │    (path sensitivity, op type)             │
│                     │  • MCPToolRiskAdapter                      │
│                     │    (browser__* tool mapping)               │
├─────────────────────┼────────────────────────────────────────────┤
│  Extension UI       │  Desktop UI                                │
│                     │                                            │
│  • ApprovalBanner   │  • ApprovalBanner (same Svelte component)  │
│    (sidepanel chat) │    (Tauri webview chat)                    │
│  • ApprovalDialog   │  • ApprovalDialog (same component)         │
│    (sidepanel modal)│    (Tauri webview modal)                   │
│  • chrome.storage   │  • Tauri notification API for background   │
│    .local for rules │    approvals when window not focused       │
│                     │  • SQLite for rule persistence              │
├─────────────────────┼────────────────────────────────────────────┤
│  Extension Storage  │  Desktop Storage                           │
│                     │                                            │
│  chrome.storage     │  IPolicyStorageAdapter (Tauri SQLite)      │
│  .local             │                                            │
└─────────────────────┴────────────────────────────────────────────┘
```

All detailed content previously in Section 13 has been integrated into the main document:
- **IPolicyStorageAdapter**: Section 11.1
- **IContextEnhancer registration**: Section 8.0
- **SecurityFilter migration**: Section 8.8
- **Notification strategy**: Section 8.9
- **Tool risk profiles**: Section 8.10
- **File structure**: Appendix A
- **Built-in rules**: Section 6.3

---
_End of Document_

<!-- OLD SECTION 13 CONTENT BELOW - RETAINED FOR REFERENCE ONLY -->
<!-- This content has been folded into the relevant sections above -->
<!-- ### 13.2 Platform Abstraction: IPolicyStorageAdapter -->
