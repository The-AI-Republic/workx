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

## Phase 2: Extend Existing Skill Frontmatter

> **Note:** BrowserX already has YAML frontmatter parsing (`SkillParser.parseSkillMd()` in `src/core/skills/SkillParser.ts:17`), typed skill schemas (`types.ts:51`), and Zod validation. This phase extends the existing system, not rebuilds it.

- [ ] ~~Implement YAML frontmatter parser~~ **ALREADY EXISTS**: `SkillParser.parseSkillMd()` handles `---` delimited YAML parsing with the `yaml` library
- [ ] ~~Define base frontmatter schema with zod~~ **ALREADY EXISTS**: `skillFrontmatterSchema` in `types.ts` validates `name`, `description`, `metadata`, `allowed-tools`, `compatibility`
- [ ] Extend existing `SkillFrontmatter` interface in `types.ts` with new fields:
  - model: string (sonnet/opus/haiku/inherit)
  - effort: string (low/medium/high/max)
  - context: 'inline' | 'fork'
  - agent: string
  - domains: string[] (BrowserX-specific: website domains)
  - hooks: object (depends on Track 01)
  - when-to-use: string (alias for existing description, for Claudy compatibility)
  - argument-hint: string
- [ ] Update existing Zod schema `skillFrontmatterSchema` to validate new fields
- [ ] Update `SkillParser.parseSkillMd()` to pass through new fields (should work automatically if schema is updated)
- [ ] Convert loaded skills into PromptCommand objects
- [ ] Add `model` override: switch model for skill execution
- [ ] Write tests for extended frontmatter fields

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

## Phase 4: Extend Model Invocation

> **Note:** BrowserX already has a `use_skill` tool registered in `DesktopAgentBootstrap.ts:403` via `registerSkillsToolOnAgent()`. This phase extends it, not replaces it.

- [ ] ~~Implement SkillTool as a registered tool~~ **ALREADY EXISTS**: `use_skill` tool is registered with `name` and `arguments` parameters
- [ ] ~~Generate skill descriptions for model system prompt~~ **ALREADY EXISTS**: `SkillRegistry.buildSkillsSystemPrompt()` generates model-facing instructions for auto/hybrid trusted skills
- [ ] Extend existing `use_skill` handler in `DesktopAgentBootstrap.ts` to support `context: 'fork'`:
  - When skill has `context: 'fork'`, spawn sub-agent with isolated context
  - Pass skill prompt as sub-agent's initial prompt
- [ ] Add `allowed-tools` enforcement to existing `use_skill` handler:
  - Read skill's `allowed-tools` from frontmatter
  - Restrict ToolRegistry for the skill execution scope
- [ ] Ensure skill tool calls go through ApprovalGate (already uses `StaticRiskAssessor(0)` — review if this is sufficient for forked execution)
- [ ] Add skill invocation events to protocol (SkillInvoked, SkillCompleted, SkillFailed)
- [ ] Write tests for extended skill execution (forked context, tool restriction)
