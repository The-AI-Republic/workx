# Track 03: Command & Skill System

## Problem

BrowserX has a minimal command system: 3 built-in commands (`/new`, `/help`, `/settings`) with a simple `CommandRegistry`. There is no:

- Typed command hierarchy (prompt vs. local vs. plugin)
- Skill frontmatter with metadata (when-to-use, allowed-tools, model override)
- Plugin discovery with source precedence
- Conditional activation based on file paths or context
- Model-invocable skills (agent can invoke skills autonomously)

Claudy has 80+ commands with 3 typed command kinds, skill frontmatter parsing, plugin marketplace, and rich lifecycle management.

## What Claudy Does

### Command Type Hierarchy

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)

type CommandBase = {
  type: 'prompt' | 'local' | 'local-jsx'
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
user-invocable: true
model: sonnet
effort: high
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

### Source Precedence

Commands are loaded from multiple sources with precedence:

1. **Bundled** (compiled into binary) - lowest priority
2. **Plugin** (marketplace or local plugins)
3. **Project** (`.claude/skills/` in project directory)
4. **User** (`~/.claude/skills/` in home directory) - highest priority

Later sources override earlier ones with the same name.

### Conditional Activation

- `paths` field: skill only visible when conversation involves matching file patterns
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

### Current State

```typescript
// CommandRegistry.ts
class CommandRegistry {
  register(name: string, handler: CommandHandler): void
  execute(name: string, args: string[]): Promise<void>
  getCommands(): Map<string, CommandHandler>
}

// 3 built-in commands: /new, /help, /settings
// No frontmatter, no source precedence, no model invocation
```

### Proposed Architecture

```
src/core/commands/
├── CommandRegistry.ts        # Enhanced registry with type hierarchy
├── CommandLoader.ts          # Load from multiple sources with precedence
├── CommandTypes.ts           # Command type unions
└── loaders/
    ├── BuiltinCommandLoader.ts   # Built-in commands
    ├── SkillCommandLoader.ts     # Load from skills/ directories
    └── PluginCommandLoader.ts    # Load from plugins

src/core/skills/
├── SkillRegistry.ts          # Enhanced with frontmatter support
├── SkillLoader.ts            # Markdown parsing with YAML frontmatter
├── SkillFrontmatter.ts       # Frontmatter schema and parsing
├── SkillTool.ts              # Tool wrapper for model invocation
└── SkillExecutor.ts          # Inline vs. forked execution
```

### Key Design Decisions

**1. Reuse existing CommandRegistry, extend it**

Don't replace the existing `CommandRegistry` in `webfront/commands/`. Extend it with:
- Type discrimination (prompt vs. local)
- Source tracking (builtin vs. skill vs. plugin)
- Metadata fields (whenToUse, argumentHint, allowedTools)

**2. Frontmatter parsing for skills**

BrowserX already has a `SkillRegistry` in `src/core/skills/`. Extend it to parse YAML frontmatter from markdown files, matching Claudy's format.

**3. Model invocation via tool**

Register a `SkillTool` that the model can invoke. This allows the agent to use skills autonomously when the `whenToUse` description matches the current task.

**4. Conditional activation based on domain**

BrowserX's equivalent of Claudy's `paths` filter is **domain-based activation**: skills can declare which website domains they're relevant for. Example: a "GitHub" skill only appears when browsing github.com.

### Phase Plan

**Phase 1: Command Type Hierarchy** (Week 1)
- Define `Command` union type with prompt/local/plugin variants
- Extend CommandRegistry with type-aware registration
- Add source tracking (builtin, skill, plugin)
- Add `whenToUse`, `argumentHint`, `isHidden` fields

**Phase 2: Skill Frontmatter** (Week 2)
- Implement YAML frontmatter parser for markdown files
- Define frontmatter schema with zod validation
- Extend SkillRegistry to load from `skills/` directories
- Support `allowed-tools`, `model`, `effort`, `context` fields

**Phase 3: Source Precedence & Loading** (Week 3)
- Implement multi-source loader with precedence
- Load from: built-in → plugin → project → user
- Later sources override earlier ones with same name
- Add conditional activation (domain-based for BrowserX)

**Phase 4: Model Invocation** (Week 4)
- Implement SkillTool wrapper for model-invocable skills
- Register SkillTool in ToolRegistry
- Generate skill descriptions for model context
- Support inline and forked execution modes

## BrowserX-Specific Extensions

Beyond what Claudy does, BrowserX should add:

- **Domain-based activation**: Skills filtered by current website domain
- **Tab-aware skills**: Skills that operate on specific tab types (e.g., "Gmail" skill)
- **Visual skills**: Skills that use page_vision_tool for visual context
- **Workflow skills**: Multi-step browser automations defined as skill sequences

## Risks

- **Frontmatter compatibility**: Claudy's format is well-established. BrowserX should be compatible but may need extensions (domain, tab context).
- **Security**: Model-invocable skills must respect approval gates. A skill that runs Bash commands needs the same approval as direct Bash execution.
