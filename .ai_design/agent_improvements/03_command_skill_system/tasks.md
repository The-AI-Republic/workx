# Track 03: Command & Skill System — Tasks

> Cross-references: `design.md` for type definitions, file:line citations, and rationale.
> Tasks tagged **EXISTS** extend infrastructure already in the repo; **NEW** creates a file.
> Within each phase, tasks are ordered for sequential pickup — earlier tasks unblock later ones.

---

## Phase 1: Typed Command Surface — Week 1

**Goal:** Add a Claudy-style `prompt | local` command hierarchy on top of the existing flat `CommandRegistryImpl` so the model surface and the typeahead surface share metadata uniformly. Per design *Key Design Decision #1*, keep `webfront/commands/CommandRegistry` as the **UI-only** surface (`local` commands) and add a new `src/core/commands/` layer for typed commands that includes both UI and prompt kinds.

**Done when:** `tsc` + `npm test` green, `/help` typeahead renders new metadata fields when present, no behavior change to existing `/new` `/help` `/settings` flows.

- [ ] **NEW** `src/core/commands/types.ts`
  - `CommandKind = 'prompt' | 'local'` (skip `local-jsx` per design — BrowserX UI is Svelte)
  - `CommandBase`: `name`, `description`, `whenToUse?`, `argumentHint?`, `isHidden?`, `isEnabled?: () => boolean`, `loadedFrom: 'builtin' | 'skill' | 'plugin'`, `userInvocable?: boolean`, `disableModelInvocation?: boolean`
  - `PromptCommand extends CommandBase`: `type: 'prompt'`, `model?`, `effort?`, `context?: 'inline' | 'fork'`, `agent?`, `allowedTools?: string[]`, `domains?: string[]`, `hooks?: HooksSettings`, `getPromptForCommand(args, ctx): Promise<string>` (returns body — no `ContentBlockParam[]` dependency to keep core/ free of provider types)
  - `LocalCommand extends CommandBase`: `type: 'local'`, `action(args?): void | Promise<void>` (matches existing `Command` shape from `src/webfront/commands/CommandRegistry.ts:2-7`)
- [ ] **NEW** `src/core/commands/precedence.ts`
  - `SOURCE_PRECEDENCE = ['builtin', 'skill', 'plugin'] as const` (lower index wins in dedupe; mirrors claudy `commands.ts:451-470` first-wins semantics)
- [ ] **NEW** `src/core/commands/loaders/BuiltinCommandLoader.ts`
  - `load(): LocalCommand[]` — adapts existing `webfront/commands/builtinCommands` registrations
- [ ] **NEW** `src/core/commands/loaders/SkillCommandLoader.ts`
  - `load(skillRegistry: SkillRegistry): PromptCommand[]` — adapts `SkillRegistry.getSkillMetas()` to `PromptCommand[]` (omits `body` until invocation)
- [ ] **NEW** `src/core/commands/CommandLoader.ts`
  - `loadAll(skillRegistry): Promise<Command[]>` — concatenates BuiltinCommandLoader + SkillCommandLoader in `SOURCE_PRECEDENCE` order
  - `dedupeByName(commands)` — first-wins by `name`
- [ ] **EXISTS** `src/webfront/commands/CommandRegistry.ts`
  - Add optional `loadedFrom?` and `whenToUse?` fields to `Command` interface — must not break existing `register()` call sites
- [ ] **EXISTS** `src/webfront/commands/builtinCommands.ts`
  - Update `/help` action to render `whenToUse` and `argumentHint` when present (currently only renders `description`)
- [ ] **NEW** `src/core/commands/__tests__/CommandLoader.test.ts`
  - Source precedence: name registered by both BuiltinCommandLoader and SkillCommandLoader resolves to the builtin (first-wins)
  - Hidden command (`isHidden: true`) excluded from `getAll()`
  - `disableModelInvocation: true` skill is loaded but flagged (assertion of behavior happens in Phase 4)

---

## Phase 2: Extended Skill Frontmatter — Week 2

**Goal:** Add Claudy-parity fields plus BrowserX `domains` to the existing schema. No parser changes — `parseSkillMd` (`src/core/skills/SkillParser.ts:17`) already passes through arbitrary YAML; the gate is the Zod schema and TS interface.

**Done when:** every new field round-trips through parse → validate → store → re-load; `context: 'fork'` without `agent` is rejected at validation; both providers return new fields in `listMeta()`.

- [ ] ~~Implement YAML frontmatter parser~~ **EXISTS** at `src/core/skills/SkillParser.ts:17`
- [ ] ~~Define base frontmatter schema with Zod~~ **EXISTS** at `src/core/skills/types.ts:85`
- [ ] **EXISTS** `src/core/skills/types.ts` — extend `SkillFrontmatter` interface with the kebab-case YAML keys:
  - `'when-to-use'?: string`
  - `'argument-hint'?: string`
  - `model?: 'haiku' | 'sonnet' | 'opus' | 'inherit' | string`
  - `effort?: 'low' | 'medium' | 'high' | 'max' | number`
  - `context?: 'inline' | 'fork'` (default `'inline'`)
  - `agent?: string` (required when `context === 'fork'`)
  - `hooks?: HooksSettings` (import from `src/core/hooks/types.ts`)
  - `domains?: string | string[]` (BrowserX-specific)
  - `'user-invocable'?: boolean | 'true' | 'false'` (default `true`)
  - `'disable-model-invocation'?: boolean | 'true' | 'false'` (default `false`)
  - `version?: string`
- [ ] **EXISTS** `src/core/skills/types.ts` — extend `Skill` with normalized camelCase versions: `whenToUse`, `argumentHint`, `model`, `effort`, `context`, `agent`, `hooks`, `domains: string[]` (always normalize to array), `userInvocable`, `disableModelInvocation`, `version`
- [ ] **EXISTS** `src/core/skills/types.ts` — extend `SkillMeta` with the subset needed without loading body: `domains?`, `context?`, `userInvocable`, `disableModelInvocation` (Phase 3 + 4 read these pre-load)
- [ ] **EXISTS** `src/core/skills/types.ts` — extend `skillFrontmatterSchema` Zod with the new fields; add `.refine((s) => s.context !== 'fork' || !!s.agent, { message: "context='fork' requires `agent`", path: ['agent'] })`
- [ ] **EXISTS** `src/core/skills/SkillParser.ts` — add `normalizeFrontmatter(fm: SkillFrontmatter): NormalizedSkillFields` helper that maps kebab → camel and applies defaults; called by `validateSkill`
- [ ] **EXISTS** `src/core/skills/FilesystemSkillProvider.ts` and `IndexedDBSkillProvider.ts` — update `listMeta()` projections to include the new `SkillMeta` fields. Use a single `projectMeta(skill: Skill): SkillMeta` helper (in `types.ts` or a sibling) so both providers stay in sync (per design *Risks* — projection drift)
- [ ] **NEW** `src/core/skills/__tests__/extendedFrontmatter.test.ts`
  - Round-trip parse + validate for every new field
  - Kebab-case → camelCase normalization (`when-to-use` → `whenToUse`)
  - Defaults applied when field omitted (`context: 'inline'`, `userInvocable: true`, `disableModelInvocation: false`)
  - `context: 'fork'` without `agent` → validation error
  - `domains: "gmail.com"` and `domains: ["gmail.com", "*.google.com"]` both accepted; both normalize to string[]
  - Boolean coercion: `'true'` / `'false'` strings → booleans

---

## Phase 3: Conditional Activation by Domain — Week 3

**Goal:** Mirror Claudy's three-map design but **bidirectional** (promote on enter, demote on leave) using website domain as the activation signal. Cross-target via a new `ActiveTabService` abstraction.

**Done when:** changing the active tab causes `SkillRegistry.buildSkillsSystemPrompt()` to add/remove domain-conditional skills accordingly; server mode (no tabs) still works (only unconditional skills available).

- [ ] **NEW** `src/core/tabs/ActiveTabService.ts`
  - `interface ActiveTabSnapshot { url: string; hostname: string; tabId?: number }`
  - `setSnapshot(snap: ActiveTabSnapshot): void` (idempotent — no-op when same hostname+url)
  - `subscribe(listener: (snap: ActiveTabSnapshot) => void): () => void`
  - `getCurrent(): ActiveTabSnapshot | null`
- [ ] **NEW** `src/core/tabs/__tests__/ActiveTabService.test.ts`
  - Idempotent `setSnapshot` (same hostname+url → listeners not fired)
  - Multiple subscribers all receive snapshot
  - Returned `unsubscribe` removes only that listener
- [ ] **NEW** `src/core/skills/SkillDomainFilter.ts`
  - State: `conditionalSkills: Map<string, SkillMeta>`, `activeSkills: Map<string, SkillMeta>` (mirrors claudy's `conditionalSkills` / `dynamicSkills`)
  - `init(metas: SkillMeta[]): void` — splits by presence of `domains`
  - `onActiveTabChange(hostname: string): { activated: string[]; deactivated: string[] }` — bidirectional promotion/demotion
  - `getAvailableSkills(): SkillMeta[]` — returns active set
  - Domain matcher: exact hostname, single-segment wildcard (`*.google.com` matches `mail.google.com` but not `google.com`), `*` (no filter — always-available)
  - **Implementation choice**: prefer `micromatch` if already in `node_modules` via vite/build deps; otherwise inline a small `globToRegExp` helper (≤15 lines). Verify before writing — `grep -l micromatch node_modules/.package-lock.json`.
- [ ] **NEW** `src/core/skills/__tests__/SkillDomainFilter.test.ts`
  - Glob matcher: `*.google.com` matches `mail.google.com`, rejects `google.com`
  - `*` treated as no-filter (always-available)
  - Bidirectional: skill activates on tab change to `gmail.com`, deactivates on tab change to `github.com`
  - Skills without `domains` are always in `activeSkills`
- [ ] **NEW** `src/core/tabs/ChromeActiveTabAdapter.ts`
  - Listens to `chrome.tabs.onActivated` (queries the activated tab → `setSnapshot`)
  - Listens to `chrome.tabs.onUpdated` (filters to `changeInfo.url || changeInfo.status === 'complete'`)
  - Returns `dispose()` that removes both listeners
- [ ] **NEW** `src/core/tabs/DesktopActiveTabAdapter.ts`
  - Pipes Tauri webview / MCP browser URL change events to `ActiveTabService.setSnapshot`
  - **v1 stub allowed**: if no event source exists yet on Tauri side, ship a stub that logs and never fires; `getAvailableSkills()` falls back to unconditional set. Track in *Out of Scope* if not wired.
- [ ] **NEW** `src/extension/background/registerActiveTabAdapter.ts`
  - Background service-worker entry point that constructs `ActiveTabService` + `ChromeActiveTabAdapter` and exposes the service via the existing extension messaging channel
- [ ] **EXISTS** `src/core/skills/SkillRegistry.ts`
  - Add constructor param (or factory injection) for `SkillDomainFilter`
  - In `discover()`, after populating `this.metas`, call `this.filter.init(this.metas)`
  - `buildSkillsSystemPrompt()` reads `this.filter.getAvailableSkills()` instead of `this.metas`
  - `getAutoInvocableSkills()` filters by available set
- [ ] **EXISTS** `src/desktop/agent/DesktopAgentBootstrap.ts` and `src/server/agent/ServerAgentBootstrap.ts`
  - Construct `ActiveTabService` + appropriate adapter (Desktop: `DesktopActiveTabAdapter`; Server: none — service stays empty)
  - Wire `activeTabService.subscribe(snap => filter.onActiveTabChange(snap.hostname))`
  - Pass `SkillDomainFilter` into `SkillRegistry`
- [ ] **Decision recorded — debounce**: per design *Risks* (prompt-cache thrash on rapid tab switches), wrap the subscriber in a 500ms `debounce()` at the bootstrap subscription site. If micromatch isn't already installed and we skip it, document the fallback choice in the test file's header comment.

---

## Phase 4: Execution & Lifecycle — Week 4

**Goal:** Replace the inline-only `use_skill` handler with a `SkillExecutor` that supports inline + forked dispatch, skill-scoped hook lifetime, allowed-tools enforcement, and approval gating.

**Done when:** inline skills behave identically to today; forked skills successfully delegate to `sub_agent` and surface the result; skill-declared `hooks:` register on entry and clear on exit (success and error); untrusted skills trigger an approval prompt via the new assessor; `disable-model-invocation: true` skills are not exposed to the model.

> BrowserX already has both halves of forked execution: `use_skill` (`DesktopAgentBootstrap.ts:418`) and `sub_agent` (`src/tools/AgentTool/SubAgentTool.ts`). This phase wires them together.

- [ ] ~~Implement SkillTool as a registered tool~~ **EXISTS** at `DesktopAgentBootstrap.ts:418` and `ServerAgentBootstrap.ts:379`
- [ ] ~~Generate skill descriptions for model system prompt~~ **EXISTS** at `SkillRegistry.buildSkillsSystemPrompt()` (`src/core/skills/SkillRegistry.ts:69`)
- [ ] **NEW** `src/core/skills/registerSkillScopedHooks.ts`
  - `registerSkillScopedHooks(store: SessionHookStore, hooks: HooksSettings, skillName: string): void` — functional helper that walks every event/matcher/hook and registers via `store.add(...)`. Per design pseudocode, no class wrapper — `SessionHookStore.clear()` is the cleanup primitive.
- [ ] **NEW** `src/core/skills/SkillExecutor.ts`
  - Constructor: `(skills: SkillRegistry, toolRegistry: ToolRegistry, hookRegistry: HookRegistry, subAgentInvoker: (params: { type: string; prompt: string; description: string }) => Promise<SubAgentResult>)`
  - `execute(skillName: string, args: string, parentCtx: ToolContext): Promise<UseSkillResult>`
  - Lookup + body load via `skills.invoke()` and `skills.getProvider().load()` (need full record for `context`/`agent`/`hooks`/`allowedTools`)
  - Per-call `const hookScope = new SessionHookStore(this.hookRegistry); if (skill.hooks) registerSkillScopedHooks(hookScope, skill.hooks, skillName)`
  - `try { ... } finally { hookScope.clear() }` — cleanup runs on success and error
  - Inline path: returns `{ success: true, status: 'inline', commandName: skillName, body, allowedTools, model }`
  - Fork path: validates `skill.agent` is set; calls `subAgentInvoker({ type: skill.agent, prompt: body, description: 'Skill: ${skillName}' })`; returns `{ success, status: 'forked', commandName, agentId: result.runId, result: result.response }`
  - Validation errors return `{ error: '...' }` shape (matches existing handler at `DesktopAgentBootstrap.ts:441`)
- [ ] **NEW** `src/core/approval/SkillRiskAssessor.ts`
  - Implements `IRiskAssessor` (verify exact contract in `src/core/approval/risk/IRiskAssessor.ts` before writing — there may be score range / shape conventions)
  - Returns score 100 for unknown skill OR `disableModelInvocation: true`
  - Returns score 50 for `trusted: false` (→ ask)
  - Returns score 0 for trusted (→ allow)
- [ ] **EXISTS** `src/desktop/agent/DesktopAgentBootstrap.ts:410-455`
  - Replace inline handler body with `await this.skillExecutor.execute(skillName, args, ctx)`
  - Replace `new StaticRiskAssessor(0)` (line 451) with `new SkillRiskAssessor(this.skillRegistry)`
  - Construct `SkillExecutor` once in `initialize()`; pass `subAgentInvoker` callback that delegates to `agent.getToolRegistry().executeTool('sub_agent', ...)` so the sub-agent shares MCP servers, channels, and approval context
- [ ] **EXISTS** `src/server/agent/ServerAgentBootstrap.ts:379` — mirror the same changes
- [ ] **`allowed-tools` enforcement (model-side, per design Decision #6 option (a))**:
  - `SkillExecutor` populates an inline-skill allow-list on the active `TurnContext` (or a `RepublicAgent` instance field cleared at turn end — investigate during impl which is cleaner)
  - Tool dispatch in `RepublicAgent` / `TurnManager` checks the per-turn allow-list and rejects calls outside it with a structured error
  - **Not a `ScopedToolRegistry` rewrite** — option (b) deferred per design rationale
- [ ] **NEW** `src/core/skills/__tests__/SkillExecutor.test.ts`
  - Inline expansion returns body + metadata
  - Forked execution invokes `sub_agent` and surfaces the result string
  - Skill-scoped hooks register at entry, clear at exit (assert via `SessionHookStore.size`)
  - Hook scope clears even when execution throws
  - `context: 'fork'` without `agent` → error result, no `sub_agent` call
  - Unknown skill → error result, no body load
  - `allowed-tools` allow-list set on parent context for inline skill, cleared at completion
- [ ] **NEW** `src/core/approval/__tests__/SkillRiskAssessor.test.ts`
  - Unknown skill → 100
  - Untrusted skill → 50 (→ approval prompt)
  - Trusted skill → 0 (→ auto-allow)
  - `disableModelInvocation: true` overrides trusted → 100
- [ ] **NEW (optional)** Protocol events — defer if scope creep risk:
  - `SkillInvoked`, `SkillCompleted`, `SkillFailed` event types in `src/core/protocol/types.ts`
  - Emit from `SkillExecutor` for UI observability

---

## Cross-cutting / Out of Scope

- **MCP-sourced skills**: deferred — no `PluginCommandLoader.ts` in v1. `src/core/commands/precedence.ts` reserves the `'plugin'` source slot. Picks up when MCP plugin work lands.
- **Path-based activation (desktop terminal)**: deferred to Track 016 wiring. `SkillDomainFilter` v1 design accommodates a parallel `pathConditional` map without restructuring.
- **Forked execution background mode**: `sub_agent` already supports `background: true`. Skills could declare `background: true` to fire-and-forget. Not in v1 — synchronous fork only.
- **Per-skill `effort` propagation to fork**: `SkillExecutor` passes `effort` through to `subAgentInvoker` if set; sub-agent inheritance semantics may shift when Track 06 (multi-agent coordination) lands. Single integration point: the `subAgentInvoker` callback.
- **`local-jsx` command kind**: BrowserX UI is Svelte, not React. Skip the discriminant entirely.
- **`ScopedToolRegistry` for `allowed-tools`**: option (b) from design Decision #6 — defer. v1 uses model-side allow-list; revisit only if model-side enforcement proves insufficient.

---

## Sequencing notes

- **Phase 1** has no dependencies — start here.
- **Phase 2** can begin in parallel with Phase 1 (different files, no overlap).
- **Phase 3** depends on Phase 2 (`SkillMeta.domains` field must exist before filter can use it).
- **Phase 4** depends on Phases 1+2 (needs `PromptCommand` shape for the executor return type and extended `Skill` for `context`/`agent`/`hooks`/`allowedTools`). Phase 3 is independent — can ship before or after.
- All four phases can ship as separate PRs against `agent-improvements` branch following the same merge cadence as Tracks 01/02/05.
