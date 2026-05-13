# Track 03: Command & Skill System

## Problem

BrowserX already has a functional skill system with several capabilities matching Claudy's architecture. The **existing infrastructure** includes:

- **YAML frontmatter parsing**: `SkillParser.parseSkillMd()` (`src/core/skills/SkillParser.ts:17`) extracts and validates YAML frontmatter using the `yaml` library and Zod schemas
- **Typed skill schemas**: `SkillFrontmatter` interface (`src/core/skills/types.ts:51`) with `name`, `description`, `metadata`, `allowed-tools`, `compatibility`; `Skill` interface with `invocationMode` ('manual' | 'auto' | 'hybrid'), `trusted` flag, `source` tracking
- **Discovery and invocation**: `SkillRegistry` (`src/core/skills/SkillRegistry.ts:23`) with `discover()`, `invoke()` (with `$ARGUMENTS` and `$1`-`$9` positional variable substitution), and `getAutoInvocableSkills()`
- **Auto-invocable prompt generation**: `SkillRegistry.buildSkillsSystemPrompt()` generates model-facing skill instructions for auto/hybrid-mode trusted skills
- **Model-invocable `use_skill` tool**: Registered in `DesktopAgentBootstrap.ts:403` via `registerSkillsToolOnAgent()`, allowing the agent to invoke skills autonomously
- **Trust-based access control**: Imported skills default to untrusted/manual; `trustSkill()` gates auto-invocation
- **File-based skill provider**: `FilesystemSkillProvider` with discovery and import/export

What BrowserX is **still missing** compared to Claudy:

- Typed command hierarchy (prompt vs. local vs. plugin command kinds)
- Multi-source loading with precedence (bundled < plugin < project < user)
- Conditional activation based on context (domain, file paths, feature flags)
- Skill-specific hooks (PreToolUse/PostToolUse scoped to a skill)
- Forked execution context for skills (inline vs. sub-agent)

Claudy has 80+ commands with 3 typed command kinds, source precedence, and rich lifecycle management. BrowserX should **extend its existing skill stack** to close these gaps, not rebuild it.

## What Claudy Does

### Command Type Hierarchy

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)

type CommandBase = {
  type: 'prompt' | 'local' | 'local-jsx'  // NOTE: claudy uses `local-jsx` (hyphen), not `local_jsx`. Only `prompt` commands are model-invocable.
  name: string
  aliases?: string[]
  description: string
  whenToUse?: string           // Detailed usage scenarios for model invocation
  isEnabled?: () => boolean    // Dynamic enable/disable
  isHidden?: boolean           // Hide from /help listing
  disableModelInvocation?: boolean  // Prevent SkillTool from invoking
  loadedFrom?: 'skills' | 'plugin' | 'bundled' | 'mcp'
  argumentHint?: string        // Hint text: "<file> <pattern>"
}

// Command result types (claudy):
// - LocalCommandResult = { type: 'text' | 'compact' | 'skip', ... }  — `local` commands only
// - PromptCommand returns raw `ContentBlockParam[]`
// There is no unified result wrapper across command kinds.

type PromptCommand = CommandBase & {
  type: 'prompt'
  source: 'builtin' | 'plugin' | 'bundled' | 'mcp' | SettingSource
  model?: string               // haiku, sonnet, opus, or full model ID
  context?: 'inline' | 'fork'  // Expand in-place or spawn sub-agent
  agent?: string               // Agent type for forked context
  hooks?: HooksSettings        // Skill-specific hooks
  paths?: string[]             // File pattern visibility filter
  effort?: EffortValue         // Thinking effort
  allowedTools?: string[]      // Restrict available tools
  getPromptForCommand(args, context): Promise<ContentBlockParam[]>
}
```

### Skill Frontmatter Format

Skills are markdown files with YAML frontmatter:

```yaml
---
description: Deploy to production
when-to-use: When changes are ready for production deployment
arguments: environment, version
argument-hint: "<environment> [version]"
allowed-tools: Bash, Write, Edit
user-invocable: true            # default true — when false, skill is not user-invocable
disable-model-invocation: false # default false — when true, SkillTool cannot invoke
model: sonnet
effort: high                    # 'low' | 'medium' | 'high' | 'max' | number — controls thinking budget
shell: bash                     # 'bash' | 'powershell'
version: 1.0.0                  # metadata only; claudy has no dependency graph on this
context: fork
agent: deployment-agent
paths: "src/**/*.ts, deploy/**"
hooks:
  PreToolUse:
    - matcher: Bash(docker:*)
      hooks:
        - type: command
          command: "docker ps"
---
# Deployment skill content (prompt body)
...
```

**Argument schema note:** Claudy does **not** use Zod (or any schema validator) to validate command arguments. Arguments are plain string-template substitution (`$1..$9`, `$ARGUMENTS`). If BrowserX wants typed argument validation, that is a net-new feature on top of claudy's model.

### Source Precedence

Commands are loaded from multiple sources in this array order:

1. **Bundled** (compiled into binary)
2. **Plugin** (marketplace or local plugins)
3. **Project** (`.claude/skills/` in project directory)
4. **User** (`~/.claude/skills/` in home directory)

**Correction (vs. earlier draft):** Claudy's `commands.ts` loads sources in array order and dedupes by **first-match wins** on `name`. Later sources do **NOT** override earlier ones with the same name — the first occurrence is kept and subsequent duplicates are discarded. There is no "user overrides bundled" semantics built in. If BrowserX wants override-by-source (e.g., user > project > plugin > bundled), it must implement that explicitly (e.g., reverse the load order, or run an explicit precedence pass before dedupe).

### Conditional Activation

- `paths` field: parsed by `utils/frontmatterParser.ts` and stored on the skill, but **the filter is not wired** — claudy's current `getSkillToolCommands()` does not actually filter skills by `paths`. The field exists; the runtime gating does not. BrowserX must implement the path/domain filter itself if it wants real conditional visibility.
- `isEnabled()` function: dynamic checks (feature flags, platform, etc.)
- `disableModelInvocation`: user-only (not auto-invoked by agent)

### Model-Invocable Skills

Claudy's `SkillTool` allows the model to invoke skills autonomously:

```typescript
// Agent sees available skills as a tool:
SkillTool.call({ skill: "deploy", args: "production v2.1" })
// → Loads skill markdown, expands with args, executes inline or in forked agent
```

## BrowserX Mapping

### Current State (Existing Infrastructure)

BrowserX already has a substantial skill system:

```
src/core/skills/
├── SkillParser.ts      # YAML frontmatter parsing with yaml lib + Zod validation
├── SkillRegistry.ts    # Discovery, invocation, auto-invocable prompt generation
├── types.ts            # SkillFrontmatter, Skill, invocationMode, Zod schemas
└── (FilesystemSkillProvider)  # File-based skill storage and discovery
```

```typescript
// SkillParser.ts:17 — Already parses YAML frontmatter
function parseSkillMd(content: string): ParsedSkill  // { frontmatter, body }
function validateSkill(parsed: ParsedSkill): void     // Zod validation, name conflict check

// SkillRegistry.ts:23 — Already has full lifecycle
class SkillRegistry {
  discover(): Promise<Skill[]>                  // Load all skill metadata
  invoke(name: string, args?: string): string   // Variable substitution ($1-$9, $ARGUMENTS)
  getAutoInvocableSkills(): Skill[]             // Filter by invocationMode + trusted
  buildSkillsSystemPrompt(): string             // Generate model-facing instructions
  save(skill): void                             // CRUD operations
  delete(name): void
  importFromContent(content): void              // Import with trust=false default
  trustSkill(name): void                        // Gate auto-invocation
}

// types.ts:51 — Already has typed schemas
interface SkillFrontmatter { name, description, metadata, 'allowed-tools', compatibility }
interface Skill { invocationMode: 'manual' | 'auto' | 'hybrid', trusted: boolean, source: 'user' | 'imported', ... }

// DesktopAgentBootstrap.ts:403 — Already registers use_skill tool
registerSkillsToolOnAgent(agent): void  // Registers use_skill tool with name + arguments params
```

The `CommandRegistry` in `webfront/commands/` handles 3 built-in commands (`/new`, `/help`, `/settings`) with simple string-based dispatch. It has no type hierarchy or source tracking.

### Proposed Extensions (Not Rebuilds)

The goal is to **extend** the existing skill stack, not replace it. New files needed:

```
src/core/commands/
├── CommandTypes.ts           # Command type unions (prompt | local | plugin)
├── CommandLoader.ts          # Multi-source loader with precedence
└── loaders/
    ├── BuiltinCommandLoader.ts   # Built-in commands
    └── PluginCommandLoader.ts    # Load from plugins

src/core/skills/
├── (existing files unchanged)
├── SkillExecutor.ts          # NEW: Inline vs. forked execution
└── SkillDomainFilter.ts      # NEW: Domain-based conditional activation
```

### Key Design Decisions

**1. Extend existing CommandRegistry with type hierarchy**

Don't replace the existing `CommandRegistry` in `webfront/commands/`. Extend it with:
- Type discrimination (prompt vs. local)
- Source tracking (builtin vs. skill vs. plugin)
- Metadata fields (whenToUse, argumentHint, allowedTools)

**2. Extend existing SkillRegistry and SkillFrontmatter**

The existing `SkillFrontmatter` in `types.ts` already supports `name`, `description`, `allowed-tools`. Extend it with Claudy-style fields that are currently missing:
- `model` override (haiku, sonnet, opus)
- `effort` level
- `context` ('inline' | 'fork')
- `hooks` (skill-scoped hook definitions)
- `domains` (BrowserX-specific: website domain activation filter)

**3. Extend existing use_skill tool**

The `use_skill` tool is already registered in `DesktopAgentBootstrap.ts:403`. Extend it with:
- Forked execution support (spawn sub-agent for `context: 'fork'` skills)
- Tool restriction enforcement (honor `allowed-tools` field during execution)

**4. Conditional activation based on domain**

BrowserX's equivalent of Claudy's `paths` filter is **domain-based activation**: skills can declare which website domains they're relevant for. Add a `domains` field to `SkillFrontmatter` and filter `getAutoInvocableSkills()` by current tab domain.

### Phase Plan

**Phase 1: Command Type Hierarchy** (Week 1)
- Define `Command` union type with prompt/local/plugin variants
- Extend CommandRegistry with type-aware registration
- Add source tracking (builtin, skill, plugin)
- Add `whenToUse`, `argumentHint`, `isHidden` fields

**Phase 2: Extend Skill Frontmatter** (Week 2)
- Extend existing `SkillFrontmatter` in `types.ts` with `model`, `effort`, `context`, `hooks`, `domains` fields
- Update Zod schema in `types.ts` for new fields
- Update `SkillParser.parseSkillMd()` to pass through new fields
- No new parser needed — existing YAML frontmatter parsing already works

**Phase 3: Source Precedence & Loading** (Week 3)
- Implement multi-source `CommandLoader` with precedence
- Load from: built-in → plugin → project → user
- Later sources override earlier ones with same name
- Add domain-based activation filter to `SkillRegistry.getAutoInvocableSkills()`

**Phase 4: Forked Execution** (Week 4)
- Implement `SkillExecutor` for inline vs. forked execution modes
- Extend existing `use_skill` tool handler in `DesktopAgentBootstrap.ts` to support `context: 'fork'`
- Enforce `allowed-tools` restriction during skill execution
- Wire skill-scoped hooks into Hook System (depends on Track 01)

**Forked execution detail:** In claudy, a forked skill inherits the **parent agent's `effort`** unless the skill itself specifies its own `effort` value. BrowserX should mirror this behavior so users don't have to redeclare effort on every skill.

**Skill permission flow:** Skill invocation in claudy routes through `getRuleByContentsForTool()` in `tools/SkillTool/SkillTool.ts`, which applies `alwaysAllowRules.command` to determine whether the invocation requires user approval. BrowserX's `use_skill` handler should follow the same pattern so skill execution honors per-command always-allow entries (not just per-tool ones).

## BrowserX-Specific Extensions

Beyond what Claudy does, BrowserX should add:

- **Domain-based activation**: Skills filtered by current website domain
- **Tab-aware skills**: Skills that operate on specific tab types (e.g., "Gmail" skill)
- **Visual skills**: Skills that use page_vision_tool for visual context
- **Workflow skills**: Multi-step browser automations defined as skill sequences

## Risks

- **Frontmatter compatibility**: Claudy's format is well-established. BrowserX should be compatible but may need extensions (domain, tab context).
- **Security**: Model-invocable skills must respect approval gates. A skill that runs Bash commands needs the same approval as direct Bash execution.

## Validation Notes (re-checked vs claudy 2026-05-11)

This section records corrections applied after a re-validation pass against the claudy source tree. Citations refer to claudy paths.

- **Source precedence (`commands.ts`):** Loader iterates sources in array order and dedupes by **first-match wins** on command `name`. There is no implicit "later overrides earlier" semantics. Override-by-source must be implemented explicitly by the consumer (e.g., BrowserX) — corrected in the *Source Precedence* section above.
- **Conditional activation by `paths` (`utils/frontmatterParser.ts`, `tools/SkillTool/SkillTool.ts`):** The `paths` field is parsed and stored, but `getSkillToolCommands()` does **not** filter by it. The runtime gate is unwired. BrowserX must implement its own filter (e.g., domain-based) — clarified in *Conditional Activation*.
- **Command type discriminant (`types/command.ts`):** Confirmed union is `prompt | local | local-jsx` with hyphen, not `local_jsx`. Only `prompt` commands are model-invocable. Annotated in the `CommandBase` snippet.
- **Skill frontmatter additions (`skills/loadSkillsDir.ts`, `utils/frontmatterParser.ts`):** Added missing fields claudy supports: `effort` (`'low' | 'medium' | 'high' | 'max' | number`), `shell` (`'bash' | 'powershell'`), `disable-model-invocation` (default `false`), `user-invocable` (default `true`), `version` (metadata only, no dependency graph).
- **Argument schema (`commands.ts`):** Claudy does **not** validate command arguments with Zod or any schema. Args are string-template substitution (`$1..$9`, `$ARGUMENTS`). Typed argument validation in BrowserX would be a net-new feature.
- **Forked execution effort:** Forked skills inherit the parent agent's `effort` unless the skill specifies its own. Documented in Phase 4.
- **Skill permission flow (`tools/SkillTool/SkillTool.ts`):** Skill invocation routes through `getRuleByContentsForTool()`, applying `alwaysAllowRules.command`. Documented in Phase 4 so BrowserX mirrors the same approval surface.
- **Command result types (`types/command.ts`):** `LocalCommandResult = { type: 'text' | 'compact' | 'skip', ... }` is for `local` commands only. `prompt` commands return raw `ContentBlockParam[]`. There is no unified result wrapper. Annotated next to the `CommandBase` snippet.
