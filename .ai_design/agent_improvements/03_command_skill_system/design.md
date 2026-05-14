# Track 03: Command & Skill System

## Problem

BrowserX already has a functional skill system with several capabilities matching Claudy's architecture. The **existing infrastructure** includes:

- **YAML frontmatter parsing**: `parseSkillMd()` in `src/core/skills/SkillParser.ts` extracts and validates YAML frontmatter using the `yaml` library and Zod schemas
- **Typed skill schemas**: `SkillFrontmatter`, `Skill`, and `SkillMeta` interfaces in `src/core/skills/types.ts:24-57` with Zod validation in `skillFrontmatterSchema` (`types.ts:85`)
- **Discovery and invocation**: `SkillRegistry` (`src/core/skills/SkillRegistry.ts:12`) with `discover()`, `invoke()` (with `$ARGUMENTS` and `$1`-`$9` positional variable substitution via `substituteVariables`), `getAutoInvocableSkills()`, `getSkillMetas()`, and 3-level lazy loading (meta → body → references)
- **Auto-invocable prompt generation**: `SkillRegistry.buildSkillsSystemPrompt()` (`SkillRegistry.ts:69`) generates model-facing skill instructions for auto/hybrid-mode trusted skills
- **Model-invocable `use_skill` tool**: Registered per-session in `DesktopAgentBootstrap.registerSkillsToolOnAgent()` (`src/desktop/agent/DesktopAgentBootstrap.ts:410`) and equivalently in `ServerAgentBootstrap`. Currently registered with `new StaticRiskAssessor(0)` (no approval gate).
- **Trust-based access control**: Imported skills default to untrusted/manual; `trustSkill()` gates auto-invocation. Reserved built-in command names (`new`, `help`, `settings`) blocked at `SkillRegistry.ts:6`.
- **Storage providers**: Platform-specific `ISkillProvider` implementations — `FilesystemSkillProvider` (desktop, Tauri fs) and `IndexedDBSkillProvider` (extension)
- **Hook system (Track 01, merged in PR #198)**: Full hook infrastructure in `src/core/hooks/` — `HookRegistry`, `HookDispatcher`, `HookMatcher`, `HookExecutor`, `SessionHookStore`, `ConfigHookLoader`. Already supports `current_url` / `current_domain` / `tab_id` in `HookInput` (`src/core/hooks/types.ts:189-191`) and as variable substitution `$CURRENT_URL` / `$CURRENT_DOMAIN` (`src/core/hooks/HookExecutor.ts:354-355`).
- **Sub-agent infrastructure**: `sub_agent` tool already registered (`src/tools/AgentTool/SubAgentTool.ts`, registration at `DesktopAgentBootstrap.ts:461-480`). Supports synchronous `{success, response, runId, turnCount, ...}` and background `{kind: "background", status: "launched", runId, ...}` returns. Forked skill execution can build on this rather than waiting for full Track 06.
- **Tool registry**: `ToolRegistry.register(tool, handler, options)` (`src/tools/ToolRegistry.ts`). No built-in `allowed-tools` enforcement scope today — currently a session-wide registry.
- **Command registry**: `CommandRegistryImpl` singleton in `src/webfront/commands/CommandRegistry.ts` with three built-ins (`/new`, `/help`, `/settings`). Flat `{name, description, argumentHint, action}` shape — no type discriminant or source tracking.

What BrowserX is **still missing** compared to Claudy:

- Typed command hierarchy (prompt vs. local vs. local-jsx command kinds)
- Multi-source loading with explicit precedence (bundled < plugin < project < user) and a deduplication policy
- Conditional activation based on context (Claudy: file paths; BrowserX needs: domain / URL)
- Skill-specific hooks (PreToolUse/PostToolUse scoped to a skill's lifetime)
- Forked execution context for skills (inline expansion vs. sub-agent delegation)
- `allowed-tools` enforcement scope at skill invocation time
- Approval gate integration for `use_skill` (currently bypassed via `StaticRiskAssessor(0)`)

Claudy has 80+ commands with 3 typed command kinds, source precedence, rich lifecycle management, and battle-tested conditional skill activation. BrowserX should **extend its existing skill stack** to close these gaps, not rebuild it.

## What Claudy Does

### Command Type Hierarchy

Source: `claudy/src/types/command.ts:16-207`

```typescript
export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)

// Discriminant lives on PromptCommand / LocalCommand / LocalJSXCommand;
// CommandBase holds shared metadata.
type CommandBase = {
  name: string
  description: string
  availability?: CommandAvailability[]   // 'claude-ai' | 'console'
  isEnabled?(): boolean                  // dynamic gate (defaults true)
  isHidden?: boolean                     // exclude from typeahead/help
  isMcp?: boolean
  userInvocable?: boolean                // default true
  disableModelInvocation?: boolean       // default false; hides from SkillTool
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'
  immediate?: boolean
  isSensitive?: boolean
  whenToUse?: string
  version?: string
  userFacingName?(): string
}

type PromptCommand = CommandBase & {
  type: 'prompt'                         // discriminant — only `prompt` is model-invocable
  progressMessage: string
  contentLength: number
  argNames?: string[]
  allowedTools?: string[]
  model?: string                         // 'haiku' | 'sonnet' | 'opus' | 'inherit' | full id
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  hooks?: HooksSettings                  // skill-scoped hooks
  skillRoot?: string                     // base dir for $CLAUDE_PLUGIN_ROOT
  context?: 'inline' | 'fork'            // expand inline (default) or spawn sub-agent
  agent?: string                         // agent type for forked context
  effort?: EffortValue                   // thinking effort
  paths?: string[]                       // glob patterns for conditional activation
  getPromptForCommand(args, context): Promise<ContentBlockParam[]>
}

type LocalCommand = CommandBase & {
  type: 'local'                          // CLI-only, never model-invocable
  supportsNonInteractive: boolean
  load(): Promise<{ call: LocalCommandCall }>
}

type LocalJSXCommand = CommandBase & {
  type: 'local-jsx'                      // TUI w/ React rendering; CLI-only
  load(): Promise<{ call: LocalJSXCommandCall }>
}

// Result shapes are NOT unified across kinds:
type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'compact'; compactionResult: CompactionResult; displayText?: string }
  | { type: 'skip' }                     // skip writing to history
// PromptCommand returns raw `ContentBlockParam[]` from getPromptForCommand.
```

`SettingSource` (`claudy/src/constants.ts:7-22`) is the load-time source for settings:
`'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'`.

### Skill Frontmatter Format

Source: `claudy/src/utils/frontmatterParser.ts:10-59` (FrontmatterData type)

Skills are markdown files with YAML frontmatter (kebab-case keys):

```yaml
---
description: Deploy to production
when-to-use: When changes are ready for production deployment
allowed-tools: Bash, Write, Edit
argument-hint: "<environment> [version]"
user-invocable: true            # default true
disable-model-invocation: false # default false
model: sonnet                   # 'haiku'|'sonnet'|'opus'|'inherit'|full id
effort: high                    # 'low'|'medium'|'high'|'max' | integer
shell: bash                     # 'bash' | 'powershell' (default bash)
version: 1.0.0                  # metadata only — no dependency graph
context: fork                   # 'inline' (default) | 'fork'
agent: deployment-agent         # required when context: 'fork'
paths: "src/**/*.ts, deploy/**" # comma-separated or YAML array
hooks:                          # skill-scoped hooks (HooksSettings shape)
  PreToolUse:
    - matcher: Bash(docker:*)
      hooks:
        - type: command
          command: "docker ps"
---
# Deployment skill content (prompt body)
...
```

**Field normalization details (frontmatterParser.ts):**
- Boolean fields are coerced from string `'true'` / `'false'` via `parseBooleanFrontmatter()`
- Glob patterns are auto-quoted via `quoteProblematicValues()` (lines 85-121) before YAML parsing — `**/*.{ts,tsx}` would otherwise break the YAML grammar
- `paths` is split via `splitPathInFrontmatter` (lines 189-232) which respects brace patterns: `src/*.{ts,tsx}` → `["src/*.ts", "src/*.tsx"]`
- If `description` is missing, it's auto-extracted from the first paragraph of the markdown body
- Unrecognized `shell` values fall back to `'bash'` with a logged warning

**Argument schema:** Claudy does **not** validate command arguments with Zod. Arguments are plain string-template substitution — `$ARGUMENTS`, `$0..$9`, `$name` (named via `argumentNames` array), `$ARGUMENTS[0]` (indexed bracket form). See `claudy/src/utils/argumentSubstitution.ts`. If BrowserX wants typed argument validation, that is a net-new feature on top of claudy's model.

### Source Precedence

Skills are loaded from four directories in **`getSkillDirCommands`** (`claudy/src/skills/loadSkillsDir.ts:638-803`), parallelized via `Promise.all`:

1. **Managed** — `${getManagedFilePath()}/.claude/skills` (policy-level)
2. **User** — `${getClaudeConfigHomeDir()}/skills` (user home, gated by `userSettings` enabled + skills not locked)
3. **Project** — `.claude/skills` + nested ancestors up to home (`projectDirsUpToHome`), gated by `projectSettings`
4. **Additional** — `--add-dir` paths (also project-gated)

**Dedup is by file identity (realpath), not by name** — `claudy/src/skills/loadSkillsDir.ts:725-763`:

```typescript
const seenFileIds = new Map<string, SettingSource>()
for (const { skill, filePath } of allSkillsWithPaths) {
  const fileId = await getFileIdentity(filePath)  // realpath()
  if (seenFileIds.has(fileId)) {
    logForDebugging(`Skipping duplicate skill '${skill.name}'...`)
    continue
  }
  seenFileIds.set(fileId, skill.source)
  deduplicatedSkills.push(skill)
}
```

Symlinks pointing at the same underlying file dedupe to one entry. **First source encountered wins.** There is no implicit "user overrides bundled" override semantics — if BrowserX wants override-by-source it must reorder the load array or run an explicit precedence pass before dedupe.

The outer `loadAllCommands` (`claudy/src/commands.ts:451-470`) concatenates in this order, with **first-by-name-wins** semantics applied implicitly by downstream consumers:

```typescript
return [
  ...bundledSkills,           // 1st (highest precedence by name)
  ...builtinPluginSkills,
  ...skillDirCommands,        // managed+user+project+additional
  ...workflowCommands,
  ...pluginCommands,
  ...pluginSkills,
  ...COMMANDS(),              // built-in commands, lowest precedence
]
```

### Conditional Activation (re-verified)

**The earlier draft of this design claimed Claudy's `paths` field was unwired. That was wrong.** Claudy fully wires conditional activation; the mechanism is **lazy promotion driven by file-tool calls**.

Source: `claudy/src/skills/loadSkillsDir.ts:771-1058`

**Three in-memory maps:**
```typescript
const conditionalSkills           = new Map<name, Skill>()  // dormant — has `paths`, not yet matched
const dynamicSkills               = new Map<name, Skill>()  // activated — promoted via path match
const activatedConditionalSkillNames = new Set<name>()      // sticky across cache clears
```

**At load time** (`loadSkillsDir.ts:771-790`), skills with non-empty `paths` arrays are stripped out of the unconditional list and stored in `conditionalSkills` instead. The model isn't told they exist.

**At runtime, three file tools trigger activation** by passing the absolute file path they just touched:

| Tool | File:Line |
|---|---|
| `FileEditTool` | `claudy/src/tools/FileEditTool/FileEditTool.ts:422` |
| `FileReadTool` | `claudy/src/tools/FileReadTool/FileReadTool.ts:590` |
| `FileWriteTool` | `claudy/src/tools/FileWriteTool/FileWriteTool.ts:245` |

The activator (`loadSkillsDir.ts:997-1058`) uses the [`ignore`](https://www.npmjs.com/package/ignore) library (gitignore-style globs):

```typescript
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  const activated: string[] = []
  for (const [name, skill] of conditionalSkills) {
    if (skill.type !== 'prompt' || !skill.paths?.length) continue
    const skillIgnore = ignore().add(skill.paths)
    for (const filePath of filePaths) {
      const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      if (skillIgnore.ignores(rel)) {
        dynamicSkills.set(name, skill)               // promote
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)     // sticky
        activated.push(name)
        break
      }
    }
  }
  return activated
}
```

**Activation is monotonic (one-way) for the session.** Once a skill moves from `conditionalSkills` → `dynamicSkills`, it stays activated until the process ends. `activatedConditionalSkillNames` is a `Set` that survives `clearSkillCaches()` (`loadSkillsDir.ts:806-811`), so cache invalidation does not deactivate skills.

**Other gating mechanisms:**
- `isEnabled()` function: dynamic checks at every `getCommands()` call (feature flags, platform, etc.)
- `disableModelInvocation`: hides skill from `SkillTool` (still available to user via `/skill-name`)
- `userInvocable: false`: hides skill from `/skill-name` typeahead (still available to model)

### Model-Invocable Skills (`SkillTool`)

Source: `claudy/src/tools/SkillTool/SkillTool.ts`

Input schema (`SkillTool.ts:291-298`):
```typescript
z.object({
  skill: z.string().describe('The skill name. E.g., "commit", "review-pr"'),
  args: z.string().optional().describe('Optional arguments for the skill'),
})
```

Lookup (`SkillTool.ts:615-616`) merges all sources and uses `findCommand` for fuzzy / alias resolution.

Permission check (`SkillTool.ts:432-578`) walks `getRuleByContentsForTool()` for deny → allow → safe-properties → ask:
```typescript
const denyRules  = getRuleByContentsForTool(permissionContext, SkillTool, 'deny')
const allowRules = getRuleByContentsForTool(permissionContext, SkillTool, 'allow')
// → 'deny' | 'allow' | 'ask'
```

Inside `getPromptForCommand` execution (`SkillTool.ts:385-390`), the skill's `allowed-tools` field is merged into `alwaysAllowRules.command` for the duration of the skill run:
```typescript
alwaysAllowRules: {
  ...appState.toolPermissionContext.alwaysAllowRules,
  command: allowedTools,    // from skill frontmatter
}
```

Output schema (`SkillTool.ts:301-327`):
```typescript
// inline (default)
{ success: boolean, commandName: string, status: 'inline',
  allowedTools?: string[], model?: string }

// forked
{ success: boolean, commandName: string, status: 'forked',
  agentId: string, result: string }
```

The two helpers `getSkillToolCommands` vs `getCommands` differ by audience:
- `getSkillToolCommands` (`commands.ts:565`) filters to prompt-type, model-invocable, non-builtin, with descriptions — this is what the **model** sees in its system prompt.
- `getCommands` (`commands.ts:478`) returns every visible command after `meetsAvailabilityRequirement` + `isCommandEnabled` checks — this is what the **typeahead UI** sees.

### Forked Execution

Source: `claudy/src/tools/SkillTool/SkillTool.ts:122-289` (`executeForkedSkill`)

Path:
```typescript
if (command?.type === 'prompt' && command.context === 'fork') {
  return executeForkedSkill(command, commandName, args, context, ...)
}
```

The forked path calls `prepareForkedCommandContext(...)` to assemble a child agent definition, then drives `runAgent({...})` (a generator) and extracts the final text:

```typescript
const { modifiedGetAppState, baseAgent, promptMessages, skillContent }
  = await prepareForkedCommandContext(command, args, context)

const agentDefinition = command.effort !== undefined
  ? { ...baseAgent, effort: command.effort }   // explicit override
  : baseAgent                                  // else inherits parent's effort

for await (const message of runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext: { ...context, getAppState: modifiedGetAppState },
  canUseTool,
  isAsync: false,
  querySource: 'agent:custom',
  model: command.model as ModelAlias | undefined,
  availableTools: context.options.tools,
  override: { agentId: createAgentId() },
})) { agentMessages.push(message) }

return { data: { success: true, commandName, status: 'forked', agentId,
                 result: extractResultText(agentMessages, 'Skill execution completed') } }
```

**Inheritance:**
- `effort`: parent default unless skill specifies its own
- `model`: parent default unless skill specifies a `ModelAlias`
- `allowedTools`: derived in `prepareForkedCommandContext` from `command.allowedTools` ∩ `context.options.tools`

**Return shape:** parent gets a single `result` text. Intermediate `agentMessages` are extracted but **not persisted to parent history**.

### Skill-Scoped Hooks

Source: `claudy/src/utils/hooks/registerSkillHooks.ts` + `claudy/src/utils/processSlashCommand.tsx:877`

Registration trigger when a skill runs:
```typescript
const hooksAllowed = !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source)
if (command.hooks && hooksAllowed) {
  registerSkillHooks(context.setAppState, getSessionId(), command.hooks,
                     command.name, command.skillRoot)
}
```

`registerSkillHooks` walks every event in `HOOK_EVENTS`, every matcher, every hook, and calls `addSessionHook(...)`. Hooks tagged `once: true` are auto-removed via `onHookSuccess` callback after first execution. Otherwise hooks are scoped to **session lifetime** (not skill lifetime in Claudy — Claudy lacks per-skill cleanup; BrowserX should do better here).

## BrowserX Mapping

### Current State (Existing Infrastructure)

```
src/core/skills/
├── SkillParser.ts              # parseSkillMd, validateSkill, substituteVariables
├── SkillRegistry.ts            # discover, invoke, getAutoInvocableSkills, buildSkillsSystemPrompt, save, delete, importFromContent, trustSkill
├── SkillProvider.ts            # ISkillProvider interface
├── types.ts                    # SkillFrontmatter, Skill, SkillMeta, ICommandRegistry, Zod schemas
├── FilesystemSkillProvider.ts  # Tauri fs (desktop)
└── IndexedDBSkillProvider.ts   # IndexedDB (extension/server)

src/webfront/commands/
├── CommandRegistry.ts          # CommandRegistryImpl singleton, parseCommandInput
├── builtinCommands.ts          # /new, /help, /settings registrations
└── index.ts

src/core/hooks/
├── HookRegistry.ts             # register, registerFromConfig, unregister, unregisterBySource, getMatchingHooks, hasHooksFor
├── HookDispatcher.ts           # fire(event, input, options): AggregatedHookResult
├── HookExecutor.ts             # spawn child process, var substitution ($CURRENT_URL/$CURRENT_DOMAIN/$TAB_ID/...)
├── HookMatcher.ts              # exact | alternatives | tool(action) syntax
├── HookAggregator.ts
├── types.ts                    # HookEvent union, HookInput, HookCommand, HooksConfig
└── loaders/
    ├── ConfigHookLoader.ts     # static load() / watch() from settings
    └── SessionHookStore.ts     # add(event, command, matcher) → id, remove(id), clear(), size

src/tools/AgentTool/
└── SubAgentTool.ts             # buildSubAgentToolDefinition; sync + background returns

src/tools/
├── ToolRegistry.ts             # register(tool, handler, options); single session-wide registry
└── BaseTool.ts                 # protected getActiveTab() — chrome.tabs.query (line 571)
```

```typescript
// src/core/skills/types.ts (verbatim)
export type InvocationMode = 'manual' | 'auto' | 'hybrid';

export interface Skill {
  name: string;
  description: string;
  body: string;
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
  sourceUrl?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];        // already exists, NOT enforced today
  compatibility?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  compatibility?: string;
}

export const skillFrontmatterSchema = z.object({
  name: skillNameSchema,                                // /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
  description: z.string().min(1).max(1024),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
  compatibility: z.string().max(500).optional(),
});
```

```typescript
// src/desktop/agent/DesktopAgentBootstrap.ts:410 (current handler — abridged)
private async registerSkillsToolOnAgent(agent: RepublicAgent): Promise<void> {
  if (!this.skillRegistry) return;
  const allSkills = this.skillRegistry.getSkillMetas();
  if (allSkills.length === 0) return;

  await agent.getToolRegistry().register(
    { type: 'function', function: { name: 'use_skill', description: '...',
      parameters: { /* {name, arguments?} */ } } },
    async (params) => {
      const skillName = params.name as string;
      const args = params.arguments as string | undefined;
      const known = new Set(this.skillRegistry!.getSkillMetas().map(s => s.name));
      if (!known.has(skillName)) return { error: `Skill "${skillName}" not found...` };
      const body = await this.skillRegistry!.invoke(skillName, args ? args.split(/\s+/) : []);
      return body ?? { error: `Failed to load skill "${skillName}"` };
    },
    new StaticRiskAssessor(0)        // ← no approval gate today
  );
}
```

```typescript
// src/webfront/commands/CommandRegistry.ts (verbatim shape)
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  action(args?: string): void | Promise<void>;
}
// Singleton: commandRegistry.register / get / getAll / filter / has / unregister
// NAME_PATTERN = /^[a-z0-9-]+$/
```

```typescript
// src/core/hooks/loaders/SessionHookStore.ts (verbatim shape)
export class SessionHookStore {
  constructor(private readonly registry: HookRegistry) {}
  add(event: HookEvent, command: HookCommand, matcher?: string): string;
  remove(hookId: string): boolean;
  clear(): number;            // remove all hooks added through this store
  get size(): number;
}
```

This is the per-skill cleanup primitive Track 03 needs — wrap `SessionHookStore` once per skill invocation.

### Proposed New Files

```
src/core/commands/                          # NEW
├── types.ts                                # CommandKind union, CommandBase, PromptCommand, LocalCommand
├── CommandLoader.ts                        # multi-source loader, dedupe by realpath/name
├── loaders/
│   ├── BuiltinCommandLoader.ts             # imports from webfront/commands/builtinCommands
│   ├── SkillCommandLoader.ts               # SkillRegistry.getSkillMetas() → PromptCommand[]
│   └── PluginCommandLoader.ts              # future, deferred to MCP/plugin work
└── precedence.ts                           # source array, dedupe policy

src/core/skills/
├── (existing files extended, not replaced)
├── SkillExecutor.ts                        # NEW: inline | fork dispatch, args → body, hook lifecycle
├── SkillDomainFilter.ts                    # NEW: domain-glob matching, conditional/dynamic maps
└── SkillHookScope.ts                       # NEW: thin wrapper around SessionHookStore for skill-scoped lifetime

src/core/tabs/                              # NEW (cross-target abstraction)
├── ActiveTabService.ts                     # subscribe(listener: (tab) => void); getActiveTab()
├── ChromeActiveTabAdapter.ts               # chrome.tabs.onActivated + onUpdated → ActiveTabService
└── DesktopActiveTabAdapter.ts              # Tauri equivalent (webview URL change events)
```

### Key Design Decisions

#### 1. Two parallel registries, one model surface

Keep `webfront/commands/CommandRegistry` for **UI-only** built-in commands (`/new`, `/help`, `/settings`) — these are `local` commands by Claudy's taxonomy. Add a new `src/core/commands/` layer for **typed commands** that includes both UI and prompt kinds. The slash typeahead reads from both; the model only sees prompt commands (via existing `use_skill` tool, extended to honor metadata).

This avoids touching `webfront/commands` for non-UI concerns (separation of layers — `core/` cannot depend on `webfront/`).

#### 2. Extend `SkillFrontmatter` and the Zod schema in place

Add net-new optional fields. The existing `parseSkillMd` already passes through arbitrary YAML; the gate is the Zod schema and the TypeScript interface. Updates needed in `src/core/skills/types.ts`:

```typescript
// src/core/skills/types.ts — proposed additions
export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;                        // EXISTING
  compatibility?: string;                          // EXISTING
  // ── new ──
  'when-to-use'?: string;                          // claudy parity
  'argument-hint'?: string;                        // claudy parity
  model?: string;                                  // 'haiku'|'sonnet'|'opus'|'inherit'
  effort?: 'low' | 'medium' | 'high' | 'max' | number;
  context?: 'inline' | 'fork';                     // default 'inline'
  agent?: string;                                  // sub-agent type when context='fork'
  hooks?: HooksSettings;                           // import from src/core/hooks/types.ts
  domains?: string | string[];                     // BrowserX-specific (parallel of claudy paths)
  'user-invocable'?: boolean | 'true' | 'false';  // default true
  'disable-model-invocation'?: boolean | 'true' | 'false'; // default false
  version?: string;
}

export const skillFrontmatterSchema = z.object({
  name: skillNameSchema,
  description: z.string().min(1).max(1024),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
  compatibility: z.string().max(500).optional(),
  // ── new ──
  'when-to-use': z.string().max(2048).optional(),
  'argument-hint': z.string().max(256).optional(),
  model: z.enum(['haiku', 'sonnet', 'opus', 'inherit']).or(z.string()).optional(),
  effort: z.union([z.enum(['low', 'medium', 'high', 'max']), z.number().int().min(0)]).optional(),
  context: z.enum(['inline', 'fork']).default('inline'),
  agent: z.string().optional(),
  hooks: hooksSettingsSchema.optional(),           // exported from src/core/hooks/types.ts
  domains: z.union([z.string(), z.array(z.string())]).optional(),
  'user-invocable': z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional().default(true),
  'disable-model-invocation': z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional().default(false),
  version: z.string().optional(),
}).refine(
  (s) => s.context !== 'fork' || !!s.agent,
  { message: "context='fork' requires `agent`", path: ['agent'] },
);
```

Add corresponding fields to `Skill` and `SkillMeta` (project `domains`, `context`, `model`, `effort`, `userInvocable`, `disableModelInvocation` onto `SkillMeta` so the system-prompt builder and filter don't need to load Level 2 just to check them).

#### 3. Domain-based conditional activation (BrowserX equivalent of `paths`)

Mirror Claudy's three-map design but flip the activation lifecycle:

```typescript
// src/core/skills/SkillDomainFilter.ts
type Hostname = string;

class SkillDomainFilter {
  private conditionalSkills = new Map<string, SkillMeta>();
  private activeSkills      = new Map<string, SkillMeta>();

  init(metas: SkillMeta[]) {
    for (const s of metas) {
      if (s.domains && s.domains.length > 0) this.conditionalSkills.set(s.name, s);
      else                                   this.activeSkills.set(s.name, s);
    }
  }

  /** Promote skills whose domain glob matches; demote skills no longer matching. */
  onActiveTabChange(hostname: Hostname): { activated: string[]; deactivated: string[] } {
    // BIDIRECTIONAL — unlike claudy's monotonic activation
    const activated:   string[] = [];
    const deactivated: string[] = [];

    // promote
    for (const [name, s] of this.conditionalSkills) {
      if (this.matches(hostname, s.domains)) {
        this.activeSkills.set(name, s);
        this.conditionalSkills.delete(name);
        activated.push(name);
      }
    }
    // demote
    for (const [name, s] of this.activeSkills) {
      if (s.domains && s.domains.length > 0 && !this.matches(hostname, s.domains)) {
        this.conditionalSkills.set(name, s);
        this.activeSkills.delete(name);
        deactivated.push(name);
      }
    }
    return { activated, deactivated };
  }

  private matches(hostname: Hostname, patterns: string[]): boolean {
    // Use micromatch (already in node_modules via vite plugins) or implement a small matcher:
    // - exact:    "mail.google.com"
    // - wildcard: "*.google.com"
    // - any:      "*"
    return patterns.some(p => globToRegExp(p).test(hostname));
  }

  getAvailableSkills(): SkillMeta[] { return [...this.activeSkills.values()]; }
}
```

**Why bidirectional and not monotonic?** Claudy's "once activated, stays for the session" works because file context accumulates — touching one `.ts` file makes TS skills permanently relevant. Tab context does not accumulate: visiting `gmail.com` once does not make Gmail skills relevant for the rest of the day. Tabs come and go.

**Domain match syntax (v1 decision):**
- Exact host: `"mail.google.com"`
- Single-segment wildcard: `"*.google.com"` matches `mail.google.com`, `drive.google.com` but not `google.com`
- `"*"`: match all (treated as no filter — matches Claudy's `**` skip behavior)
- No path/query matching in v1 — hostname only. Path-aware activation can be a v2 add-on.

#### 4. Trigger source unified across targets

```typescript
// src/core/tabs/ActiveTabService.ts
interface ActiveTabSnapshot { url: string; hostname: string; tabId?: number; }

class ActiveTabService {
  private current: ActiveTabSnapshot | null = null;
  private listeners = new Set<(snap: ActiveTabSnapshot) => void>();

  setSnapshot(snap: ActiveTabSnapshot) {
    if (this.current?.hostname === snap.hostname && this.current?.url === snap.url) return;
    this.current = snap;
    for (const l of this.listeners) l(snap);
  }
  subscribe(listener: (snap: ActiveTabSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getCurrent(): ActiveTabSnapshot | null { return this.current; }
}
```

- **Extension**: `ChromeActiveTabAdapter` listens to `chrome.tabs.onActivated` and `chrome.tabs.onUpdated` (filter to `changeInfo.url || changeInfo.status === 'complete'`), then calls `ActiveTabService.setSnapshot(...)`.
- **Desktop (Tauri)**: existing webview/MCP browser session emits URL change events; adapter pipes them to `ActiveTabService`.
- **Server (headless)**: no active tab — the service's `getCurrent()` returns `null`, the domain filter degrades to "show only unconditional skills".

`SkillRegistry` (or a thin `SkillRuntime` wrapper) subscribes once at startup; `SkillDomainFilter.onActiveTabChange` runs per emission.

`BaseTool.getActiveTab()` (`src/tools/BaseTool.ts:571`) is the existing extension-only equivalent. The new `ActiveTabService` generalizes it cross-target and provides the subscribe model that `getActiveTab()` cannot.

#### 5. Forked execution via existing `sub_agent` tool

BrowserX already has `sub_agent` (`src/tools/AgentTool/SubAgentTool.ts`). Track 03 does **not** need to wait for full Track 06 multi-agent coordination to ship forked skill execution. The existing tool returns `{success, response, runId, turnCount, ...}` synchronously, which maps exactly to claudy's forked return shape.

Skeleton:

```typescript
// src/core/skills/SkillExecutor.ts
class SkillExecutor {
  constructor(
    private skills: SkillRegistry,
    private toolRegistry: ToolRegistry,
    private hookRegistry: HookRegistry,
    private subAgentInvoker: (params: { type: string; prompt: string; description: string }) => Promise<SubAgentResult>,
  ) {}

  async execute(skillName: string, args: string, parentCtx: ToolContext): Promise<UseSkillResult> {
    const meta = this.skills.getSkillMetas().find(s => s.name === skillName);
    if (!meta) return { error: `Skill "${skillName}" not found` };

    const body = await this.skills.invoke(skillName, args ? args.split(/\s+/) : []);
    if (!body) return { error: `Failed to load skill "${skillName}"` };
    const skill = await this.skills.getProvider().load(skillName);  // need full record for context/agent/hooks/allowedTools

    // Skill-scoped hook lifetime
    const hookScope = new SessionHookStore(this.hookRegistry);
    if (skill.hooks) registerSkillScopedHooks(hookScope, skill.hooks);
    try {
      if (skill.context === 'fork') {
        if (!skill.agent) return { error: `Skill "${skillName}" declares context: 'fork' but no agent` };
        const result = await this.subAgentInvoker({
          type: skill.agent, prompt: body, description: `Skill: ${skillName}`,
        });
        return { success: result.success, status: 'forked', commandName: skillName,
                 agentId: result.runId, result: result.response };
      }
      // inline: enforce allowed-tools by intersecting visible tools for this turn,
      // then return the body to be re-injected into the conversation
      return { success: true, status: 'inline', commandName: skillName,
               body, allowedTools: skill.allowedTools, model: skill.model };
    } finally {
      hookScope.clear();   // skill-scoped cleanup, regardless of inline/fork
    }
  }
}
```

The existing `use_skill` handler in `DesktopAgentBootstrap.ts:435-450` becomes a thin wrapper that delegates to `SkillExecutor.execute()` and routes the `sub_agent` invocation through the same agent's `ToolRegistry` (so the sub-agent shares MCP servers, channels, etc.).

#### 6. `allowed-tools` enforcement for inline skills

`ToolRegistry` is currently session-wide — there is no per-call scope. Two options:

**(a) Filter on the model side**: when an inline skill is active, the system prompt advertises only the intersected tool set. The model can still try forbidden tools but the handler rejects them.

**(b) Wrap the registry**: subclass `ToolRegistry` with a `ScopedToolRegistry` that intercepts `register`/`getToolDefinition` and filters by allow-list for the duration of the skill. `Session` swaps registries on entry/exit.

**v1 picks (a)** — simpler, no Session surgery. Add a guard in `ToolRegistry.executeTool()` (or in the `RepublicAgent` tool-call dispatcher) that consults a per-turn allow-list set by the active skill executor.

#### 7. Approval gate for `use_skill`

Replace `new StaticRiskAssessor(0)` (`DesktopAgentBootstrap.ts:451`) with a real assessor that:
1. Consults skill `disable-model-invocation` (auto-deny if true and caller is the model)
2. Checks `trusted` flag on `SkillMeta` (untrusted → `behavior: 'ask'`)
3. Falls through to `ApprovalGate.check()` for the wrapping tool call

This mirrors claudy's `getRuleByContentsForTool()` flow on the BrowserX side. Since BrowserX's `ApprovalGate` already supports per-domain rules, an `alwaysAllowRules.command`-style policy is implicit (a "trusted skill" is the equivalent of "always allow this command").

### Phase Plan

**Phase 1: Typed command surface (Week 1)**
- `src/core/commands/types.ts` — `CommandKind`, `CommandBase`, `PromptCommand`, `LocalCommand` (no `local-jsx` for v1 — BrowserX UI is Svelte, not React)
- `src/core/commands/CommandLoader.ts` — load from BuiltinCommandLoader + SkillCommandLoader; dedupe by name (first-wins, matching claudy)
- `src/core/commands/precedence.ts` — defines source order: `bundled < skill < plugin` (project/user distinction lives inside `SkillRegistry` via `SkillMeta.source` already)
- Wire `webfront/commands/builtinCommands` to register through `BuiltinCommandLoader` so the typeahead can show metadata uniformly
- Tests: command registration with source precedence, dedupe by name, hidden-command exclusion

**Phase 2: Extended frontmatter (Week 2)**
- Edit `src/core/skills/types.ts` — extend `SkillFrontmatter` and `Skill` with new fields (see schema above), update `SkillMeta` with the subset needed for filtering (`domains`, `context`, `userInvocable`, `disableModelInvocation`)
- Edit `skillFrontmatterSchema` Zod definition
- `parseSkillMd` is already pass-through — no parser changes needed
- Adapt `FilesystemSkillProvider` and `IndexedDBSkillProvider` `listMeta` projections to include new fields
- Tests: round-trip parse+validate for every new field, kebab-case→camelCase normalization, default values, fork-without-agent rejection

**Phase 3: Conditional activation (Week 3)**
- New `src/core/tabs/ActiveTabService.ts` + `ChromeActiveTabAdapter` (extension) + `DesktopActiveTabAdapter` (Tauri)
- New `src/core/skills/SkillDomainFilter.ts` with bidirectional activation
- Wire `SkillRegistry.discover()` → seed `SkillDomainFilter`
- Wire `ActiveTabService.subscribe(filter.onActiveTabChange)` at bootstrap (Desktop + Server bootstraps, where the agent factory currently calls `registerSkillsToolOnAgent`)
- Update `SkillRegistry.buildSkillsSystemPrompt()` to read from `filter.getAvailableSkills()` instead of `metas` directly
- Tests: domain glob matcher (`*.google.com`, `mail.google.com`, `*`), bidirectional activation (promote on enter, demote on leave), no-tab fallback (server mode)

**Phase 4: Execution & lifecycle (Week 4)**
- New `src/core/skills/SkillExecutor.ts` — inline vs. fork dispatch, args parsing, hook lifecycle wrap
- New `src/core/skills/SkillHookScope.ts` — wraps `SessionHookStore` with skill name attribution + auto-clear
- Modify `DesktopAgentBootstrap.registerSkillsToolOnAgent` (and ServerAgentBootstrap mirror) to delegate to `SkillExecutor`
- Replace `StaticRiskAssessor(0)` with `SkillRiskAssessor` that consults `disable-model-invocation` + `trusted`
- Wire `allowed-tools` enforcement: per-turn allow-list set by `SkillExecutor`, consulted in tool dispatch
- Wire forked execution through existing `sub_agent` tool (`src/tools/AgentTool/SubAgentTool.ts`) — `subAgentInvoker` callback in executor
- Tests: inline expansion (body returned), forked execution (sub_agent invoked, result string passed back), allowed-tools blocks forbidden call, hook scope clears on completion AND on error, untrusted skill triggers approval

### Forked execution detail

In claudy, a forked skill inherits the parent agent's `effort` unless the skill itself specifies its own `effort`. BrowserX should mirror this — `SkillExecutor` passes `effort: skill.effort` only when defined; otherwise the sub-agent invocation inherits from the agent definition.

The existing `sub_agent` tool's `type` parameter restricts to registered `SubAgentTypeConfig` ids. Skills whose `agent:` field references an unknown type must fail validation at parse time (Phase 2 schema refinement).

### Skill permission flow

Claudy routes skill invocation through `getRuleByContentsForTool()` in `tools/SkillTool/SkillTool.ts`, applying `alwaysAllowRules.command` to determine whether the invocation requires user approval. BrowserX's equivalent is `ApprovalGate.check(toolName, parameters, assessor, context)`. The new `SkillRiskAssessor` in Phase 4 should:

```typescript
class SkillRiskAssessor implements IRiskAssessor {
  constructor(private skills: SkillRegistry) {}
  async assess(_toolName: string, params: { name: string }): Promise<RiskScore> {
    const meta = this.skills.getSkillMetas().find(s => s.name === params.name);
    if (!meta) return { score: 100, reason: 'unknown skill' };          // → likely deny
    if (meta.disableModelInvocation) return { score: 100, reason: 'model-invocation disabled' };
    if (!meta.trusted) return { score: 50, reason: 'untrusted skill' }; // → ask
    return { score: 0, reason: 'trusted user skill' };                  // → allow
  }
}
```

(Adjust to BrowserX's actual `IRiskAssessor` contract — verify in `src/core/approval/risk/IRiskAssessor.ts` before writing.)

## BrowserX-Specific Extensions

Beyond what claudy does, BrowserX should add:

- **Domain-based activation** (Phase 3): primary v1 conditional-activation signal — works on both extension and desktop
- **Path-based activation (desktop only, deferred)**: when the desktop terminal sandbox (Track 016) lands, mirror claudy's `paths` field for skills that care about file context. Same `SkillDomainFilter` map structure can host a parallel `pathConditional` map keyed off terminal-tool paths.
- **Tab-aware skill metadata**: `metadata.tab-types: "gmail|github"` style, surfaced to the model in the auto-invocable system prompt block
- **Visual skills**: skills referencing `page_vision_tool` in `allowed-tools` get a "screenshot suggested" hint in their `whenToUse` rendering

## Risks

- **Frontmatter compatibility**: claudy's format is well-established. New BrowserX fields (`domains`) are additive — claudy parsers ignore unknown keys, so cross-tool authoring stays safe. Reverse direction (claudy `paths` in BrowserX) is also handled — the schema can accept it as `unknown`/`optional` for desktop wiring.
- **Security — model-invocable skills**: Phase 4 must replace `StaticRiskAssessor(0)` before any skill that touches sensitive tools (terminal, network) ships. Today, an attacker who plants a malicious skill in IndexedDB / filesystem can run arbitrary tool sequences via `use_skill` with no approval gate.
- **`SkillMeta` projection drift**: adding fields to both `Skill` and `SkillMeta` introduces a sync risk between providers (`FilesystemSkillProvider`, `IndexedDBSkillProvider`). Add a single `projectMeta(skill: Skill): SkillMeta` helper and use it in both providers' `listMeta()` to keep projection consistent.
- **Bidirectional activation churn**: if the user tab-switches rapidly, the `buildSkillsSystemPrompt()` output changes per turn — this can hurt prompt caching. Mitigation: debounce the subscribe callback (e.g., 500ms) and snapshot at turn-start, not on every tab change.
- **Sub-agent dependency on Track 06**: forked execution uses today's `sub_agent` tool. If Track 06 reshapes the sub-agent contract, `SkillExecutor.subAgentInvoker` is the single integration point — keep the executor decoupled from `SubAgentTool` internals via the callback shape.

## Validation Notes (re-verified vs claudy 2026-05-13)

This section records corrections applied after a re-validation pass against the claudy source tree. Citations refer to claudy paths.

- **Conditional activation by `paths` IS wired** (`claudy/src/skills/loadSkillsDir.ts:771-1058` + `tools/FileEditTool/FileEditTool.ts:422`, `tools/FileReadTool/FileReadTool.ts:590`, `tools/FileWriteTool/FileWriteTool.ts:245`). The earlier draft of this design claimed it was unwired — that was wrong. Activation is gitignore-style glob matching via the `ignore` library, triggered lazily by file-tool invocations, monotonic for the session.
- **Source precedence (`commands.ts`):** Loader iterates sources in array order. Within `getSkillDirCommands`, **dedup is by file identity (realpath), not by name** (`loadSkillsDir.ts:725-763`) — first source encountered wins. `loadAllCommands` (`commands.ts:451-470`) then concatenates skill sources; downstream first-by-name semantics depend on consumer.
- **Command type discriminant (`types/command.ts:16-207`):** Confirmed union is `prompt | local | local-jsx` with hyphen. Only `prompt` commands are model-invocable.
- **Skill frontmatter additions (`skills/loadSkillsDir.ts`, `utils/frontmatterParser.ts:10-59`):** Added missing fields claudy supports: `effort` (`'low' | 'medium' | 'high' | 'max' | number`), `shell` (`'bash' | 'powershell'`), `disable-model-invocation` (default `false`), `user-invocable` (default `true`), `version` (metadata only, no dependency graph).
- **Argument schema (`commands.ts`, `utils/argumentSubstitution.ts`):** Claudy does **not** validate command arguments with Zod or any schema. Args are string-template substitution (`$1..$9`, `$ARGUMENTS`, `$ARGUMENTS[i]`, `$name`).
- **Forked execution effort (`SkillTool.ts:205-236`):** Forked skills inherit the parent agent's `effort` unless the skill specifies its own.
- **Skill permission flow (`SkillTool.ts:432-578`):** Skill invocation routes through `getRuleByContentsForTool()` (deny → allow → safe-properties → ask), applying `alwaysAllowRules.command` for in-execution tool gates.
- **Command result types (`types/command.ts:16-23`):** `LocalCommandResult = { type: 'text' | 'compact' | 'skip', ... }` is for `local` commands only. `prompt` commands return raw `ContentBlockParam[]`. There is no unified result wrapper.
- **Skill-scoped hooks (`utils/hooks/registerSkillHooks.ts`, `processSlashCommand.tsx:877`):** Registered with `addSessionHook` at skill entry; `once: true` hooks self-remove via `onHookSuccess`. Claudy lacks per-skill cleanup — BrowserX should improve on this by wrapping `SessionHookStore` per skill invocation and `clear()`-ing on completion.
