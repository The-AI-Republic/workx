# Track 03: Command & Skill System - Tasks

## Phase 1: Command Type Hierarchy

- [ ] Define `CommandType` union: 'prompt' | 'local' | 'plugin' in `src/core/commands/CommandTypes.ts`
- [ ] Define `CommandBase` interface with: name, aliases, description, whenToUse, argumentHint, isHidden, isEnabled, source, loadedFrom
- [ ] Define `PromptCommand` extending CommandBase with: model, context, agent, allowedTools, effort, getPromptForCommand
- [ ] Define `LocalCommand` extending CommandBase with: execute handler
- [ ] Extend existing `CommandRegistry` with type-aware registration
- [ ] Add source tracking field: 'builtin' | 'skill' | 'plugin'
- [ ] Update `/help` command to show command metadata (description, argumentHint)
- [ ] Add command deduplication (same name from different sources → highest precedence wins)
- [ ] Write tests for command registration with source precedence

## Phase 2: Skill Frontmatter

- [ ] Implement YAML frontmatter parser in `src/core/skills/SkillFrontmatter.ts`
  - Parse `---` delimited YAML header from markdown files
  - Return { frontmatter: object, body: string }
- [ ] Define frontmatter schema with zod:
  - description: string
  - when-to-use: string
  - arguments: string | string[]
  - argument-hint: string
  - allowed-tools: string | string[]
  - user-invocable: boolean (default: true)
  - model: string (sonnet/opus/haiku/inherit)
  - effort: string (low/medium/high/max)
  - context: 'inline' | 'fork'
  - agent: string
  - domains: string[] (BrowserX-specific: website domains)
  - hooks: object (depends on Track 01)
- [ ] Extend `SkillLoader.ts` to parse frontmatter from .md files in skills/ directories
- [ ] Support skill discovery from: project `.browserx/skills/`, user `~/.browserx/skills/`
- [ ] Convert loaded skills into PromptCommand objects
- [ ] Add `allowedTools` enforcement: restrict ToolRegistry during skill execution
- [ ] Add `model` override: switch model for skill execution
- [ ] Write tests for frontmatter parsing with various field combinations

## Phase 3: Source Precedence & Loading

- [ ] Implement `CommandLoader.ts` that discovers commands from multiple sources
- [ ] Define source precedence: builtin (0) → plugin (1) → project (2) → user (3)
- [ ] Implement deduplication: later source overrides earlier for same command name
- [ ] Add domain-based conditional activation for BrowserX:
  - Check current tab URL against skill's `domains` field
  - Only show matching skills in /help and model context
- [ ] Implement `PluginCommandLoader.ts` for loading commands from plugin directories
- [ ] Add `isEnabled()` dynamic check support (feature flags, platform)
- [ ] Register all loaded commands in CommandRegistry at startup
- [ ] Re-evaluate command visibility on tab change (domain filter refresh)
- [ ] Write integration tests for multi-source loading with precedence

## Phase 4: Model Invocation

- [ ] Implement `SkillTool.ts` as a registered tool in ToolRegistry
  - Input: { skill: string, args?: string }
  - Lists available skills in tool description
  - Invokes skill's getPromptForCommand with args
- [ ] Generate skill descriptions for model system prompt:
  - Only include user-invocable skills where isEnabled() = true
  - Include whenToUse for model decision-making
- [ ] Implement inline execution: expand skill prompt into current conversation
- [ ] Implement forked execution: spawn skill as sub-agent with isolated context
- [ ] Enforce allowed-tools restriction during skill execution
- [ ] Ensure skill tool calls go through ApprovalGate (same approval as direct tool use)
- [ ] Add skill invocation events to protocol (SkillInvoked, SkillCompleted, SkillFailed)
- [ ] Write tests for model-invoked skill execution
