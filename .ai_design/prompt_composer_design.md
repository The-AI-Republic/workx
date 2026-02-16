# PromptComposer Design Document

## Status: Draft
## Date: 2025-10-22

---

## 1. Problem Statement

Currently, `src/core/PromptLoader.ts` statically loads `agent_prompt.md` at build time via Vite `?raw` imports. This single prompt is used for **both** the Chrome extension (browserx) agent and the desktop (pi) agent, even though they operate in fundamentally different environments:

- **browserx agent** (Chrome Extension): Operates inside a browser tab, uses DOMTool/PageVision/NavigationTool/StorageTool
- **pi agent** (Desktop App): Operates on a local machine, uses TerminalTool, MCP-based browser control, has OS access

The current prompt (`agent_prompt.md`) is written exclusively for the browserx agent. The pi agent receives this same prompt despite having different capabilities, different tools, and needing OS-awareness.

Additionally, the compaction prompt lives in `src/core/compact/constants.ts` as a hardcoded string, disconnected from the prompt management system.

---

## 2. Goals

1. **Runtime system prompt composition** — `PromptComposer` assembles prompts dynamically based on agent type and runtime context.
2. **PromptLoader remains the single source of truth** — `PromptLoader.loadPrompt()` calls `PromptComposer.compose()` internally. The agent only ever calls `PromptLoader` — never `PromptComposer` directly.
3. **Per-turn freshness** — `loadPrompt()` is called on every user message submission, and each call produces a freshly composed prompt with current runtime metadata.
4. **Agent-specific prompts** — Serve distinct system prompts for browserx (Chrome extension) and pi (desktop) agents.
5. **Runtime metadata injection** — Embed real-time host machine info (OS, platform, shell, date/time) into the system prompt.
6. **Centralized prompt management** — Move all prompt content (including compaction prompts) under `src/prompts/` managed through `PromptComposer`.

---

## 3. Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│  Build Time (Vite ?raw)                                        │
│                                                                │
│  src/prompts/                                                  │
│  ├── default_browserx_agent_prompt.md  (renamed, fallback)     │
│  ├── user_instruction.md               (unchanged)             │
│  └── fragments/                        (new)                   │
│      ├── safety.md                                             │
│      ├── browserx_intro.md                                     │
│      ├── pi_intro.md                                           │
│      ├── browserx_tools.md                                     │
│      ├── pi_tools.md                                           │
│      ├── task_execution_policies.md                             │
│      ├── compact_summarization.md                              │
│      └── compact_summary_prefix.md                             │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  src/prompts/PromptComposer.ts                                 │
│  ├── composeMainInstruction(agentType, runtimeCtx) → string  │
│  ├── composeCompactPrompt() → string                           │
│  └── composeSummaryPrefix() → string                           │
│                                                                │
│  Imports fragments via ?raw. Assembles sections + metadata.    │
│  Never called by agent directly — only by PromptLoader.        │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  src/core/PromptLoader.ts  (single source of truth for agent)  │
│                                                                │
│  loadPrompt() {                                                │
│    if (configured) → return composer.composeMainInstruction() │
│    else → return default_browserx_agent_prompt.md (fallback)   │
│  }                                                             │
│                                                                │
│  Called on EVERY user message in processUserInputWithTask()    │
│  → result set via taskContext.setBaseInstructions()             │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  Agent (BrowserxAgent.ts)                                      │
│                                                                │
│  Only calls loadPrompt() / loadUserInstructions()              │
│  Never touches PromptComposer directly.                        │
└────────────────────────────────────────────────────────────────┘
```

**Data flow per user message:**
```
User sends message
  → processUserInputWithTask()
    → loadPrompt()                                    // PromptLoader
      → PromptComposer.composeMainInstruction(      // called inside PromptLoader
          agentType, { currentDateTime, os, ... })
      → returns composed prompt
    → taskContext.setBaseInstructions(prompt)
    → session.spawnTask(...)
      → TurnManager.runTurn()
        → reads turnContext.getBaseInstructions()
        → OpenAIResponsesClient: instructions = composed prompt
```

---

## 4. Detailed Design

### 4.1 File Renames & Moves

| Current Path | New Path | Notes |
|---|---|---|
| `src/prompts/agent_prompt.md` | `src/prompts/default_browserx_agent_prompt.md` | Rename. Fallback when composer not configured. |
| (inline in `constants.ts`) | `src/prompts/fragments/compact_summarization.md` | Extract `SUMMARIZATION_PROMPT` content |
| (inline in `constants.ts`) | `src/prompts/fragments/compact_summary_prefix.md` | Extract `SUMMARY_PREFIX` content |

### 4.2 Prompt Fragments (new: `src/prompts/fragments/`)

Each fragment is a focused, composable markdown file imported at build time via Vite `?raw`.

#### `browserx_intro.md` — BrowserX Agent Identity & Core Directive
```markdown
You are BrowserX, a browser automation agent developed by AI Republic.
Your purpose is to complete user tasks by navigating and acting inside
real web pages within a Chrome browser extension.

You operate as a Chrome Extension sidebar agent. The user interacts with
you through a side panel while browsing. You can observe, navigate, and
manipulate the active browser tab.

## Core Directive
Persist until the task is resolved. Modern web pages are complex by nature.
...

## Capabilities and Context
- Receive user prompts plus metadata such as tab IDs, viewports, or cached state.
- Read processed DOM snapshots—not raw HTML—to reason about visible content.
...
```

#### `pi_intro.md` — Pi Agent Identity & Core Directive
```markdown
You are Pi, a desktop automation agent developed by AI Republic.
Your purpose is to help users accomplish tasks on their local machine
and across the web.

You operate as a desktop application agent. You have access to the local
file system, terminal/shell, and can control a browser through automation.
You work directly on the user's operating system.

## Core Directive
Persist until the task is resolved. Desktop tasks can span multiple
applications and tools. This is expected, not a reason to stop.
...

## Capabilities and Context
- Execute terminal commands on the local machine with security filtering.
- Control a browser via MCP automation server for web tasks.
- Access the local file system for reading, writing, and organizing files.
...
```

#### `safety.md` — Safety & Ethics (shared)
Extracted from current `agent_prompt.md` lines 7-16.

#### `browserx_tools.md` — BrowserX Tool Guidance + Operation Strategy
Extracted from current `agent_prompt.md` lines 51-55, 85-107.

#### `pi_tools.md` — Pi Agent Tool Guidance + Operation Strategy
New content for desktop tools: TerminalTool, MCP browser tools, PlanningTool, Web Search.

#### `task_execution_policies.md` — Shared Policies
Extracted from current `agent_prompt.md`: Tone, Behavioral Guardrails, Planning Tool, Task Execution Policies, Presenting Work, Final Answer, Element References.

#### `compact_summarization.md` — Compaction Prompt
Extracted from `src/core/compact/constants.ts` `SUMMARIZATION_PROMPT` content.

#### `compact_summary_prefix.md` — Summary Prefix
Extracted from `src/core/compact/constants.ts` `SUMMARY_PREFIX` content.

### 4.3 PromptComposer (`src/prompts/PromptComposer.ts`)

```typescript
import browserxIntro from './fragments/browserx_intro.md?raw';
import piIntro from './fragments/pi_intro.md?raw';
import safety from './fragments/safety.md?raw';
import browserxTools from './fragments/browserx_tools.md?raw';
import piTools from './fragments/pi_tools.md?raw';
import taskPolicies from './fragments/task_execution_policies.md?raw';
import compactSummarization from './fragments/compact_summarization.md?raw';
import compactSummaryPrefix from './fragments/compact_summary_prefix.md?raw';

export type AgentType = 'browserx' | 'pi';

export interface RuntimeContext {
  os?: string;              // 'linux' | 'macos' | 'windows'
  arch?: string;            // 'x86_64' | 'aarch64'
  osVersion?: string;
  shell?: string;           // 'bash' | 'zsh' | 'powershell'
  homeDir?: string;
  cwd?: string;
  browserConnection?: string; // 'extension' | 'cdp' | 'mcp'
  currentDateTime?: string;
  memoryGB?: number;
}

export class PromptComposer {
  /**
   * Compose the main agent system prompt.
   *
   * Assembled sections:
   * 1. Self-intro + core directive + capabilities (agent-specific)
   * 2. Runtime metadata (injected fresh each call)
   * 3. Safety guidance (shared)
   * 4. Tool guidance + operation strategy (agent-specific, static for MVP)
   * 5. Task execution policies (shared)
   */
  composeMainInstruction(agentType: AgentType, context?: RuntimeContext): string {
    const sections: string[] = [];
    sections.push(agentType === 'browserx' ? browserxIntro : piIntro);
    sections.push(this.buildRuntimeMetadata(agentType, context));
    sections.push(safety);
    sections.push(agentType === 'browserx' ? browserxTools : piTools);
    sections.push(taskPolicies);
    return sections.filter(Boolean).join('\n\n');
  }

  composeCompactPrompt(): string {
    return compactSummarization;
  }

  composeSummaryPrefix(): string {
    return compactSummaryPrefix;
  }

  private buildRuntimeMetadata(agentType: AgentType, context?: RuntimeContext): string {
    if (!context) return '';
    const lines: string[] = ['## Runtime Environment'];
    if (context.currentDateTime) {
      lines.push(`- Current date/time: ${context.currentDateTime}`);
    }
    if (agentType === 'pi') {
      if (context.os) {
        const osLabel = { linux: 'Linux', macos: 'macOS', windows: 'Windows' }[context.os] || context.os;
        lines.push(`- Operating system: ${osLabel}`);
      }
      if (context.arch) lines.push(`- Architecture: ${context.arch}`);
      if (context.osVersion) lines.push(`- OS version: ${context.osVersion}`);
      if (context.shell) lines.push(`- Default shell: ${context.shell}`);
      if (context.homeDir) lines.push(`- Home directory: ${context.homeDir}`);
      if (context.cwd) lines.push(`- Working directory: ${context.cwd}`);
      if (context.memoryGB) lines.push(`- Available memory: ${context.memoryGB} GB`);
    }
    if (context.browserConnection) {
      const label = {
        extension: 'Chrome Extension (direct tab access)',
        cdp: 'Chrome DevTools Protocol',
        mcp: 'MCP browser automation server',
      }[context.browserConnection] || context.browserConnection;
      lines.push(`- Browser connection: ${label}`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }
}
```

### 4.4 Updated PromptLoader (`src/core/PromptLoader.ts`)

This is the key change. `PromptLoader` remains the only module the agent imports for prompts. Internally, it delegates to `PromptComposer` when configured.

```typescript
import defaultPrompt from '../prompts/default_browserx_agent_prompt.md?raw';
import userInstructions from '../prompts/user_instruction.md?raw';
import { PromptComposer, type AgentType, type RuntimeContext } from '../prompts/PromptComposer';

// Module-level singleton — configured once, used on every loadPrompt() call
let composer: PromptComposer | null = null;
let agentType: AgentType = 'browserx';
let staticContext: Partial<RuntimeContext> = {};

/**
 * Configure the PromptLoader to use dynamic composition.
 * Called once during agent initialization.
 * After this, every loadPrompt() call returns a freshly composed prompt.
 */
export function configurePromptComposer(
  type: AgentType,
  context: Partial<RuntimeContext> = {}
): void {
  composer = new PromptComposer();
  agentType = type;
  staticContext = context;
}

/**
 * Load the system prompt for the agent.
 *
 * If PromptComposer is configured: composes a fresh prompt with current
 * runtime metadata (date/time refreshed on each call).
 *
 * If not configured: returns the default bundled prompt (fallback).
 *
 * Called on every user message submission — safe to call repeatedly.
 */
export async function loadPrompt(): Promise<string> {
  if (composer) {
    const context: RuntimeContext = {
      ...staticContext,
      currentDateTime: new Date().toISOString(),
    };
    return composer.composeMainInstruction(agentType, context);
  }
  // Fallback: return static default prompt
  return defaultPrompt;
}

/**
 * Load user instructions (unchanged).
 */
export async function loadUserInstructions(): Promise<string> {
  return userInstructions;
}
```

### 4.5 Integration Points

#### BrowserxAgent.initialize() — Configure once

The agent calls `configurePromptComposer()` once during init. After that, every existing `loadPrompt()` call automatically returns composed prompts — **no changes needed at call sites**.

```typescript
import { configurePromptComposer, loadPrompt, loadUserInstructions } from './PromptLoader';
import type { RuntimeContext } from '../prompts/PromptComposer';

// In initialize():
const agentType = __BUILD_MODE__ === 'desktop' ? 'pi' : 'browserx';
const staticContext: Partial<RuntimeContext> = {
  browserConnection: agentType === 'browserx' ? 'extension' : 'mcp',
};

if (agentType === 'pi') {
  try {
    const platformInfo = await invoke<{ os: string; arch: string; version: string }>('get_platform_info');
    staticContext.os = platformInfo.os;
    staticContext.arch = platformInfo.arch;
    staticContext.osVersion = platformInfo.version;
    staticContext.shell = platformInfo.os === 'macos' ? 'zsh'
      : platformInfo.os === 'windows' ? 'powershell' : 'bash';
    staticContext.homeDir = await homeDir();
  } catch (e) {
    console.warn('[BrowserxAgent] Could not fetch platform info:', e);
  }
}

// Configure once — all subsequent loadPrompt() calls use composer
configurePromptComposer(agentType, staticContext);

// These existing lines continue to work unchanged:
const baseInstructions = await loadPrompt();       // now returns composed prompt
taskContext.setBaseInstructions(baseInstructions);
const userInstructions = await loadUserInstructions();
taskContext.setUserInstructions(userInstructions);
```

#### Existing call sites — Zero changes needed

All 3 existing call sites in `BrowserxAgent.ts` (lines 149, 225, 257) and 1 in `TurnManager.ts` (line 465) already call `loadPrompt()`. After `configurePromptComposer()`, they automatically get composed prompts with fresh `currentDateTime` on each call.

```
BrowserxAgent.ts:149  →  const baseInstructions = await loadPrompt();  // ✓ works
BrowserxAgent.ts:225  →  const baseInstructions = await loadPrompt();  // ✓ works
BrowserxAgent.ts:257  →  const baseInstructions = await loadPrompt();  // ✓ works
TurnManager.ts:465    →  const systemPrompt = await loadPrompt();      // ✓ works
```

#### CompactService — Use PromptComposer for compaction prompts

```typescript
// src/core/compact/constants.ts (updated)
import { PromptComposer } from '../../prompts/PromptComposer';
const _composer = new PromptComposer();
export const SUMMARIZATION_PROMPT = _composer.composeCompactPrompt();
export const SUMMARY_PREFIX = _composer.composeSummaryPrefix();
// ... rest unchanged
```

### 4.6 Prompt Assembly Order (Final)

```
┌─────────────────────────────────────────┐
│ 1. SELF-INTRO & CORE DIRECTIVE         │  ← agent-specific
│    "You are BrowserX/Pi, a..."          │
│    Capabilities and context             │
├─────────────────────────────────────────┤
│ 2. RUNTIME METADATA                    │  ← injected fresh each call
│    - Current date/time (always fresh)   │
│    - OS, arch, shell (pi only)          │
│    - Browser connection method          │
├─────────────────────────────────────────┤
│ 3. SAFETY & ETHICS                     │  ← shared
│    - Destructive work refusal           │
│    - Financial operations restriction   │
├─────────────────────────────────────────┤
│ 4. TOOL GUIDANCE + OPERATION STRATEGY  │  ← agent-specific
│    browserx: DOMTool, PageVision, etc.  │
│    pi: Terminal, MCP browser, etc.      │
├─────────────────────────────────────────┤
│ 5. TASK EXECUTION POLICIES             │  ← shared
│    - Tone, behavioral guardrails        │
│    - Planning tool usage                │
│    - Execution templates                │
│    - Presenting work / final answer     │
└─────────────────────────────────────────┘
```

### 4.7 System Prompt Lifecycle

The system prompt is **not** part of conversation history. It's sent as the `instructions` field in the API payload — separate from the `input` array (conversation history). This means:

1. **Overridable mid-conversation** — Changing `baseInstructions` via `setBaseInstructions()` only affects the next LLM call. No history rewriting needed.
2. **Fresh every turn** — Since `loadPrompt()` is called before each turn and produces a new string, the LLM always sees current metadata.
3. **No accumulation** — The system prompt replaces (not appends to) the previous one each turn.

---

## 5. Fragment Decomposition from Current Prompt

The current `agent_prompt.md` (132 lines) maps to fragments:

| Lines | Current Section | Target Fragment | Shared? |
|-------|----------------|-----------------|---------|
| 1 | Identity | `browserx_intro.md` / `pi_intro.md` | No |
| 3-5 | Core Directive | `browserx_intro.md` / `pi_intro.md` | No (adapted per agent) |
| 7-16 | Safety + Financial | `safety.md` | Yes |
| 18-22 | Capabilities and Context | `browserx_intro.md` / `pi_intro.md` | No |
| 24-25 | Tone and Responsiveness | `task_execution_policies.md` | Yes |
| 27-31 | Behavioral Guardrails | `task_execution_policies.md` | Yes |
| 33-49 | Planning Tool | `task_execution_policies.md` | Yes |
| 51-55 | Operation Strategy | `browserx_tools.md` / `pi_tools.md` | No |
| 57-83 | Task Execution Policies | `task_execution_policies.md` | Yes |
| 85-107 | Tool Usage | `browserx_tools.md` | No (browserx only) |
| 109-132 | Presenting Work, Final Answer | `task_execution_policies.md` | Yes |

---

## 6. File Structure (Final)

```
src/
├── prompts/
│   ├── PromptComposer.ts                    (NEW - composition logic)
│   ├── default_browserx_agent_prompt.md     (RENAMED - fallback only)
│   ├── user_instruction.md                  (unchanged)
│   └── fragments/                           (NEW directory)
│       ├── browserx_intro.md
│       ├── pi_intro.md
│       ├── safety.md
│       ├── browserx_tools.md
│       ├── pi_tools.md
│       ├── task_execution_policies.md
│       ├── compact_summarization.md
│       └── compact_summary_prefix.md
├── core/
│   ├── PromptLoader.ts                      (UPDATED - delegates to PromptComposer)
│   ├── BrowserxAgent.ts                     (UPDATED - calls configurePromptComposer once)
│   └── compact/
│       └── constants.ts                     (UPDATED - delegates to PromptComposer)
```

---

## 7. Migration & Backward Compatibility

1. **`loadPrompt()` is still the only API** — All existing callers (`BrowserxAgent`, `TurnManager`) continue calling `loadPrompt()` unchanged. The return value changes from static to dynamic, but the interface is identical.

2. **Fallback behavior** — If `configurePromptComposer()` is never called (e.g., tests, unexpected init failure), `loadPrompt()` returns the default bundled prompt. Zero breakage.

3. **`TurnContext.setBaseInstructions()`** — Continues to receive the prompt from `loadPrompt()`. No interface changes.

4. **`PromptHelpers.get_full_instructions()`** — Works unchanged. Already supports `base_instructions_override`.

5. **`SUMMARIZATION_PROMPT` / `SUMMARY_PREFIX`** — Become thin wrappers via `PromptComposer`. All existing imports work.

6. **Existing call sites** — All 4 call sites (`BrowserxAgent.ts` x3, `TurnManager.ts` x1) work without modification after `configurePromptComposer()` is called in `initialize()`.

---

## 8. MVP Scope

### In scope
- Create `PromptComposer` class
- Decompose `agent_prompt.md` into fragments
- Create `pi_intro.md` and `pi_tools.md` for desktop agent
- Runtime metadata injection (OS, arch, shell, browser connection, date/time)
- Move compaction prompts to fragments
- Rename `agent_prompt.md` → `default_browserx_agent_prompt.md`
- Update `PromptLoader` to delegate to `PromptComposer`
- Add `configurePromptComposer()` call in `BrowserxAgent.initialize()`
- Update `compact/constants.ts` to use `PromptComposer`

### Out of scope (future)
- Dynamic tool composition (tools discovered at runtime injected into prompt)
- Per-model prompt variations
- User-editable prompt fragments via settings UI
- Prompt versioning / A/B testing

---

## 9. Testing Strategy

1. **Unit tests for PromptComposer**:
   - `composeMainInstruction('browserx')` returns prompt with browserx identity and tools
   - `composeMainInstruction('pi', runtimeCtx)` returns prompt with pi identity, OS metadata, and pi tools
   - `composeMainInstruction('pi')` without context still returns valid prompt (graceful degradation)
   - `composeCompactPrompt()` returns summarization prompt
   - `composeSummaryPrefix()` returns summary prefix
   - Verify no duplicate sections in composed output

2. **Unit tests for PromptLoader**:
   - Before `configurePromptComposer()`: `loadPrompt()` returns default prompt
   - After `configurePromptComposer('browserx')`: `loadPrompt()` returns composed browserx prompt
   - After `configurePromptComposer('pi', ctx)`: `loadPrompt()` returns composed pi prompt with metadata
   - Successive `loadPrompt()` calls produce different `currentDateTime` values

3. **Integration tests**:
   - `BrowserxAgent.initialize()` correctly detects agent type from `__BUILD_MODE__`
   - Compaction still uses correct prompts after migration

4. **Regression tests**:
   - Existing extension-mode behavior unchanged
   - `compact/constants.ts` exports still work for all existing importers
