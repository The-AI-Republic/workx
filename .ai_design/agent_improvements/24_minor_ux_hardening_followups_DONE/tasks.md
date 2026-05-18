# Track 24 Tasks

> **Status (2026-05-16):** IMPLEMENTATION-READY — all 5 items, no open
> decisions. This is a **bundle of 5 independent improvements**; each item is
> its own standalone PR (target branch **`main`**, per project workflow) and can
> be picked in any order. The order below is the design's risk-ordered
> recommendation (24.5 first = highest *live* exfil risk; 24.4 = cheap footgun
> hardening; 24.1 P1 UX; 24.2/24.3 P2 UX). There is **no** cross-item
> dependency — do not serialize unnecessarily.

See [`design.md`](./design.md) for rationale, the verified `file:line` seams,
the resolved design decisions (D1–D3 for 24.2; the verbatim prompt + 14-rule
`REJECT_RULES` + UX pseudo-diff for 24.3), the per-platform applicability
matrix, the dependency-track status, Risks, and Validation Corrections.

**Branch caveat (load-bearing):** every `file:line` below was verified on
`agent-improvements` at 2026-05-16. The branch moves; line numbers drift.
Re-confirm with the Phase 0 greps before editing — the *seams* are stable, the
*line numbers* are not.

---

## Phase 0: Pre-implementation re-verification (DO FIRST per item)

Re-confirm only the item(s) you are about to implement. Record drift inline.

- [ ] **24.1** — `src/webfront/commands/CommandRegistry.ts` `filter(query)` body (was `:89-116`); single caller `src/webfront/components/MessageInput.svelte` (was `:188`, `updateFilter()`); `lastExecuted` map (was `:120`); `grep -rn "\.filter(" src | grep -i commandRegistry` confirms still **one** production caller (no Track 13 funnel); `grep -n '"fuse.js"' package.json` (dep already present, was `:89`); confirm **no** existing `filter()` test under `src/webfront/commands/__tests__/`.
- [ ] **24.2** — `src/prompts/PromptComposer.ts`: intro push (was `:65`), tools push `sections.push(agentType === 'browserx' ? browserxTools : piTools)` (was `:73-74`), `RuntimeContext` (was `:24`, add field after `:42`); `configurePromptComposer` is in `src/core/PromptLoader.ts` (was `:33`); call sites `ServerAgentBootstrap.ts` (was `:641`), `DesktopAgentBootstrap.ts` (was `:766`), `RepublicAgent.ts` (was `:269`); `IUserPreferences` in `src/config/types.ts` (~`:314`); `ServerConfigSchema.server` in `src/server/config/server-config.ts` (was `:82`); `grep -n '"yaml"' package.json` (present, **not** used — body-as-prompt, D1); confirm `import.meta.glob` already used at `src/webfront/lib/i18n/index.ts:20` (D3).
- [ ] **24.3** — `src/core/title/TitleGenerator.ts` (template: `callModelForTitle`, drain loop, `cleanTitle`); `src/core/models/ModelClient.ts` `stream(prompt)` (was `:203`); `src/core/Session.ts` `maybeGenerateTitle` (was `:2317`), `getConversationHistory` (was `:361`), `getModelClientForTitle` (was `:2392`); `src/core/TaskRunner.ts` `emitTaskComplete` (was `:545`); `src/core/platform/IPlatformAdapter.ts` `platformId` (was `:69`); `src/core/protocol/events.ts` `EventMsg` union (was `:28`), `TurnCompleteEvent` (was `:733`); `src/webfront/components/MessageInput.svelte` keydown handler (was `:218-283`, `isCommandMode` block closes `:262`, normal Enter `:264`), `value` `$bindable` (was `:21`), `handleInput` (was `:285`), `submitWithAttachments` (was `:65`); `src/webfront/pages/chat/Main.svelte` `<MessageInput>` (was `:1519`), `handleEvent` switch (was `:619`), `TaskStarted` branch (was `:602`); confirm `src/core/diagnostics/redact.ts` `RULES` exists (was `:23-42`).
- [ ] **24.4** — `src/server/tools/registerServerTools.ts`: `import { execSync } from 'node:child_process'` (was `:13`), `execSync(\`which ${candidate}\`)` (was `:333`) inside `findChromeBinary()` (was `:322-341`), hardcoded `candidates` array (was `:324-329`); `grep -rn "execSync\|execFile\|child_process\|spawn(" src/server` confirms `:333` is the **only** raw shell-exec; `src/server/tools/__tests__/registerServerTools.test.ts` mocks `node:child_process` (was `:38-42`, string assertion `:180`).
- [ ] **24.5** — `src/server/channel-connectors/connector-bridge.ts` outbound sites (were `:247` and `:160`); `src/server/channels/ServerChannel.ts` `sendEvent`/`conn.ws.send` (was `:94-108`); `src/server/agent/ServerAgentBootstrap.ts` `transcriptStore.append` (was `:213`); `src/core/diagnostics/redact.ts` `RULES` + `redactString` (was `:23-42`/`:49`); `grep -rn "telemetry\|analytics" src/core src/server | grep -i emit` confirms Track 16 has **no network sink** (future hook only); confirm **no** memory-export site exists (`grep -rn "export\|download\|share" src/core/memory` → none).

---

## 24.5 — Fail-closed secret scanner *(P2 · S · do first — highest live exfil risk)*

**Goal:** No secret in agent-produced text reaches an outbound surface. The
scanner fails **closed** (block on uncertainty) — the only fail-closed path in
the initiative; do not "fix" it to fail-open. **One PR.** No cross-track dep
(reuses Track 17 `redact.ts`, already DONE). The "settings/memory sync"
sub-item is **explicitly deferred** (see Deferred table) — scanner only.

- [ ] **New** `src/core/security/secretScanner.ts` — reuse `src/core/diagnostics/redact.ts` `RULES`, extend with AWS `AKIA`, GitHub `ghp_`/`gho_`, generic high-entropy 32+ hex/base64. Export:
  - `interface SecretSpan { start:number; end:number; ruleId:string }`
  - `interface ScanResult { spans:SecretSpan[]; block:boolean; redacted:string }`
  - `function scanForSecrets(text:string): ScanResult`
- [ ] **Fail-closed contract:** `block === true` iff any high-confidence rule matches **OR** "uncertain" (input > `MAX_SCAN_BYTES` ≈ 256 KB so the regex pass can't complete deterministically, **or** the pass throws). On `block`, the gate replaces the outbound payload with the fixed safe string `"[blocked: outbound message withheld — possible secret detected]"` and MUST NOT send the original.
- [ ] **Gate 1a** — `src/server/channel-connectors/connector-bridge.ts:247` (`outbound.sendText(outCtx, event.msg.data.message)`): scan `message`; on `block` send the safe string.
- [ ] **Gate 1b** — `connector-bridge.ts:160` (`outbound.sendText(outboundCtx, msg.data.message)`, the broadcast path the prior draft missed): same.
- [ ] **Gate 2** — `src/server/channels/ServerChannel.ts:94-108`: scan `AgentMessage`/`AgentMessageDelta`/`AgentReasoning` `.data.message`; substitute `redacted` text into `payload` **before** `JSON.stringify`/`conn.ws.send(frame)`.
- [ ] **Gate 3** — `src/server/agent/ServerAgentBootstrap.ts:213`: store the **redacted** form in the transcript (defense-at-rest; non-blocking — do not drop the transcript entry, just redact it).
- [ ] **Do NOT add** a "memory export" gate — no such call site exists in `src/core/memory/` (verified). Do NOT add a telemetry gate — Track 16 has no network sink yet; instead leave a documented `// TODO(track-16): scanForSecrets gate is mandatory pre-emit` note where the future emitter will live.
- [ ] **Tests** `src/core/security/__tests__/secretScanner.test.ts` — inject `sk-…`, `xai-…`, `AIza…`, `Bearer …`, JWT, `AKIA…`, `ghp_…`: assert `block` + `redacted`; oversized input ⇒ `block` (uncertain); clean text ⇒ `!block`, unchanged. Plus a gate integration test: a connector reply containing a fake `sk-…` is replaced by the safe string, the original is never passed to `outbound.sendText`.
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## 24.4 — Server-exec footgun hardening *(P2 · S — downgraded; not a live CVE)*

**Goal:** Remove the interpolated-`execSync` footgun. **Not** a live injection
(`candidate` is a hardcoded literal array) — this is lint-grade hardening that
must still land because the test mock + a future dynamic array would make it
real. **One PR** for the unconditional part. The OS-sandbox boundary is
**scope-optional** (see below / Deferred).

- [ ] `src/server/tools/registerServerTools.ts:13` — `import { execSync }` → `import { execFileSync } from 'node:child_process';` (replace, **no keep-both** — `execSync` has no other use).
- [ ] `:333` — `execSync(\`which ${candidate}\`, { encoding:'utf-8' }).trim()` → `execFileSync('which', [candidate], { encoding:'utf-8' }).trim()`. Behavior identical (`which` non-zero exit → throw → existing `catch`).
- [ ] **Required test update (the swap breaks the existing mock):** `src/server/tools/__tests__/registerServerTools.test.ts` — retarget the hoisted mock from `execSync` to `execFileSync` (named + on `default`); `:179-181` → `mockImplementation((file,args)=> file==='which' && args?.[0]==='google-chrome' ? '/usr/bin/google-chrome' : (()=>{throw new Error('not found')})())`; not-found mocks throw; **add** a positive assertion that `execFileSync` is called as `('which',[candidate],{encoding:'utf-8'})` (proves no shell string).
- [ ] **Sandbox boundary — pick scope explicitly in the PR description:**
  - [ ] *(a) Minimal — recommended for this track):* the `execFileSync` swap alone closes the only server shell-exec; no OS sandbox (the server has no arbitrary-shell tool). **Default — do this unless an operator threat model demands more.**
  - [ ] *(b) Defense-in-depth (optional):* extract `src/desktop/tools/terminal/SecurityFilter.ts` (pure-TS) to a shared location and apply it in `src/server/mcp/NodeMCPBridge.ts:63` to vet user-configured MCP `command`/`args` (the real residual exec surface — arg-array, no injection, but unvalidated binary).
  - [ ] *(c) Full claudy parity:* bwrap/Seatbelt around the MCP spawn + deny-write protected config/skills dirs + bare-git scrub. **Larger than the doc's old "M" — defer (see Deferred) unless explicitly required.**
- [ ] **Do NOT** attempt to reuse `desktop/tools/terminal/SandboxManager.ts` — it is a Tauri-IPC config broker (`@tauri-apps/api`), not portable to a Node server process; real enforcement is in the Rust backend.
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## 24.1 — Fuse fuzzy command ranking *(P1 · S — highest-priority UX)*

**Goal:** Typo-tolerant slash-command autocomplete with an exact-prefix hard
top tier + optional recency weight. Ships extension + desktop together (shared
`webfront`). **One PR.** `fuse.js@^7.1.0` already a dep. No Track 13 funnel
dependency (single direct caller).

- [ ] `src/webfront/commands/CommandRegistry.ts` — replace `filter()`. New signature `filter(query: string, recency?: ReadonlyMap<string, number>): FilteredCommand[]`. Keep return type and the `'name' | 'description'` union (**do NOT** add a `'fuzzy'` value — preserves the consumer contract).
  - [ ] Tier 1 (hard top): exact-prefix `command.name.startsWith(q)`, verbatim current logic; within tier sort by `recency` desc when provided, else `localeCompare` (preserves legacy order when `recency` absent).
  - [ ] Tier 2: `new Fuse(remaining, { keys:[{name:'name',weight:.6},{name:'description',weight:.3},{name:'whenToUse',weight:.1}], threshold:~0.4, ignoreLocation:true })`; map hits, `matchType` = `'name'` if strongest matched key is name else `'description'`; optional small recency blend. Per-call construction is fine (tiny set) or memoize on a registry-version counter. `import Fuse from 'fuse.js';` (match existing usage style in `JobHistoryModule.svelte`/`SettingsSearch.svelte`).
- [ ] `src/webfront/components/MessageInput.svelte:188` — `commandRegistry.filter(query)` → `commandRegistry.filter(query, lastExecuted)` (`lastExecuted` already in scope at `:120`; registry stays stateless).
- [ ] **New** `src/webfront/commands/__tests__/CommandRegistry.filter.test.ts` (none exists today — net-new, nothing breaks). Assert: exact-prefix always outranks fuzzy/desc; typo `dctr` surfaces `/doctor` (old `startsWith` would not); `matchType ∈ {'name','description'}`; empty query returns all, recency reorders when map passed; **absent `recency` reproduces legacy ordering** (regression guard). Use `commandRegistry.reset()` + `register()` in `beforeEach` (mirror `builtinCommands.doctor.test.ts`).
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## 24.2 — Output-style personas *(P2 · S)*

**Goal:** User-selectable persona injected as a system-prompt section;
project>user precedence; per-platform selection (ext/desktop via
`IUserPreferences`, server via `config.json`). Track 20 policy override is a
future TODO (Track 20 is design-only). **One PR.** Design decisions D1–D3 are
resolved in `design.md` — no decisions left.

- [ ] **New** `src/prompts/PersonaLoader.ts`:
  - [ ] `parsePersona(raw)` per **D1**: no `---\n` prefix ⇒ whole file is body, empty frontmatter; else split on the next exact `---` line, body after closing `---\n` (minus one leading newline) is `prompt`; frontmatter lines `/^([A-Za-z_]+)\s*:\s*(.*)$/`, accept only `name`/`description`/`keepCodingInstructions`, ignore unknown/blank/`#`, strip surrounding quotes; `keepCodingInstructions = String(v).trim().toLowerCase()==='true'`, **absent ⇒ default `true`**. Hand-rolled — **do NOT** add a YAML dep.
  - [ ] Built-ins via `import.meta.glob('./styles/*.md', {query:'?raw', eager:true, import:'default'})` (D3 — safe on all targets incl. Vite-SSR server).
  - [ ] `resolvePersona(name): {prompt:string, keepCodingInstructions:boolean} | null`. Precedence: project `<cwd>/.browserx/styles/*.md` > user `<homeDir>/.browserx/styles/*.md` > bundled glob (disk layer uses Node `fs`, naturally a no-op in the extension — no build-config branching). Unknown name ⇒ `null`. **Fail soft:** an unparseable file ⇒ treat as no-frontmatter / return `null`, never throw into prompt composition.
- [ ] **New** `src/prompts/styles/<persona>.md` (≥1 built-in) + `src/prompts/__tests__/PersonaLoader.test.ts` (no-frontmatter = all-body; 3-key parse; quote-strip; absent `keepCodingInstructions` = true; malformed = null).
- [ ] `src/prompts/PromptComposer.ts` — add `personaName?: string` to `RuntimeContext` (after `:42`); import `resolvePersona`. Per **D2**, two hunks in `composeMainInstruction`:
  - [ ] after `:65` (`sections.push(intro);`): `const persona = resolvePersona(context?.personaName); if (persona) sections.push(persona.prompt);`
  - [ ] replace `:73-74` tools push: `if (!persona || persona.keepCodingInstructions) { sections.push(agentType === 'browserx' ? browserxTools : piTools); }`
  - [ ] Extend `src/prompts/__tests__/PromptComposer.test.ts`: (a) no `personaName` ⇒ output **byte-identical** (regression guard); (b) `keepCodingInstructions:false` ⇒ tools fragment absent, persona prompt present; (c) `true`/omitted ⇒ tools present.
- [ ] `src/config/types.ts` (~`:314`) — add `personaName?: string` to `IUserPreferences` (+ defaults passthrough).
- [ ] `src/server/config/server-config.ts:82` — add `persona: z.string().optional()` to the `server` object.
- [ ] Wiring (read selected name → `staticContext`): extension `RepublicAgent.ts:269`; desktop `DesktopAgentBootstrap.ts:766` (config already fetched `:94`); server `ServerAgentBootstrap.ts:641` from `getServerConfig().server.persona` + `// TODO(track-20): managed-policy override once Track 20 lands`.
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## 24.3 — Next-prompt suggestion *(P2 · M — interactive only; NO speculation)*

**Goal:** After ≥2 assistant turns, a cheap background model call predicts the
user's likely next message; shown as a dismissable chip; Tab-accept. Gated to
ext+desktop (`platformId !== 'server'`). **One PR.** Built as a sibling of
`TitleGenerator`. Prompt + `REJECT_RULES` + UX are fully specified in
`design.md` (authored in-repo — claudy not portable).

- [ ] **New** `src/core/suggestions/constants.ts` — the verbatim suggestion prompt (see design.md 24.3) with the `NONE` sentinel; **N = 160 chars**.
- [ ] **New** `src/core/suggestions/promptSuggestion.ts` — class `PromptSuggestionGenerator`, sibling of `src/core/title/TitleGenerator.ts`: build one `user` `ResponseItem`, `modelClient.stream({ input, tools: [] })`, drain accumulating `isOutputTextDelta`, break on `isCompleted`, inside `withModelRetry({ source:'background', maxRetries:2 })` (copy `callModelForTitle`/drain loop/`cleanTitle`).
  - [ ] Context packing: last **6** `message` turns (user/assistant only, skip tool/reasoning), tail-truncate each to **400 chars**, block cap ≈ 3000 chars, chronological `User:`/`Assistant:` lines (never drop the final assistant turn).
  - [ ] Clean like `cleanTitle` (trim, strip `Next message:`/`Suggestion:` labels, strip wrapping quotes) then `REJECT_RULES`. Over-length is **discarded, never truncated**.
  - [ ] `REJECT_RULES` (ordered, first match ⇒ `{suggestion: undefined}`, no event) — implement all 14 rules from design.md 24.3 verbatim. Rule 10 reuses `src/core/security/secretScanner.ts` if 24.5 landed, else `src/core/diagnostics/redact.ts` `RULES`. Rules 11–14 (destructive/financial/form/URL) are safety-critical — must not be loosened.
- [ ] Event: add `| { type:'PromptSuggestion'; data:{ suggestion:string } }` to `EventMsg` (`src/core/protocol/events.ts:28`, parallel to `TurnCompleteEvent:733`).
- [ ] `src/core/TaskRunner.ts:545` (`emitTaskComplete`) — **after** the existing `TaskComplete` emit: `this.session.maybeGenerateSuggestion().catch(() => {});` (fire-and-forget, never blocks).
- [ ] **New** `Session.maybeGenerateSuggestion()` (`src/core/Session.ts`, parallel to `maybeGenerateTitle:2317`): guard `platformId === 'server'` ⇒ return; assistant-turn count `< 2` ⇒ return; reuse `getModelClientForTitle:2392`; on a surviving suggestion `emitEvent({type:'PromptSuggestion',data:{suggestion}})`.
- [ ] `src/webfront/components/MessageInput.svelte`:
  - [ ] New `$bindable` prop `suggestion: string | null = null`.
  - [ ] Render the chip `"Tab ↹  {suggestion}"` + `×` (calling `dismissSuggestion()`) **after** the `pendingAttachments` indicator (`:471`), guarded `{#if suggestion && !value.trim() && !isCommandMode}`. **Not** inline ghost text (no overlay layer in the textarea markup).
  - [ ] Keydown: insert the Tab + Escape branches **after** the `isCommandMode` block closes (`:262`) and **before** normal-mode `Enter` (`:264`) — exact code in design.md 24.3 (Tab accepts only when palette closed AND input empty OR a live prefix of the suggestion; Escape dismisses).
  - [ ] Clear `suggestion` on: divergence in `handleInput()` (`:285`), submit (`submitWithAttachments():65`), new turn (`TaskStarted`), Escape, chip `×`. Leave the `lastExecuted` 500 ms debounce (`:120/:194`) untouched.
- [ ] `src/webfront/pages/chat/Main.svelte`: `:1519` add `bind:suggestion={nextSuggestion}` + `let nextSuggestion = $state<string|null>(null)`; `handleEvent` switch (`:619`) `case 'PromptSuggestion'` → set it; `TaskStarted` branch (`:602`) → `nextSuggestion = null`.
- [ ] **Explicitly DO NOT port/implement `speculation.ts`.** browserx tool exec drives non-idempotent browser side effects (navigation/clicks/form-fills/payments — Track 23 hazard class); no COW-overlay analog for live DOM/network state. Hard scope exclusion.
- [ ] Manual UI check (ext + desktop): suggestion appears after ≥2 turns, Tab accepts, Escape/typing/submit clears, never hijacks the command palette or normal typing. State explicitly if a surface can't be exercised.
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## Cross-cutting

- [ ] **Update the README row** (`.ai_design/agent_improvements/README.md:48`) to match the validated design: 24.4 is **P2/S footgun hardening, not a P2/M "injection fix"**; note 24.5 sync deferred / scanner P2/S fail-closed; line 129 dependency-graph mentions of 24.1/24.2 remain valid.
- [ ] After each item's PR merges, tick its section here and update `design.md` **Status**. Re-run that item's Phase 0 greps if the branch moved materially.
- [X] Rename the dir to `24_minor_ux_hardening_followups_DONE` only after **all 5** items merge; until then note in the README which items shipped (the `_DONE` suffix is all-or-nothing and unreliable for a bundle — be explicit per item).
- [ ] All PRs target **`main`** (project workflow), not `agent-improvements`.

---

## Deferred (NOT in this track — see design.md)

| Item | Why |
|------|-----|
| 24.5 Settings/Memory **sync** (P2/L) | Needs a backend contract browserx lacks. Do not start until one exists. Scanner ships without it. |
| 24.4 full OS-sandbox parity — option (c) | bwrap/Seatbelt + deny-write dirs + bare-git scrub is genuinely new infra, larger than "M", and the server has no arbitrary-shell tool. Revisit only on an operator threat model. |
| 24.3 `speculation.ts` | Speculatively executing a predicted prompt is unsafe — browser side effects are non-idempotent (nav/clicks/payments). Prohibition is the point; never port. |
| 24.2 Track 20 policy override of `server.persona` | Track 20 is design-only. Ship via `config.json` now; wire the policy key when Track 20 lands (TODO already placed). |
| 24.5 Track 16 telemetry gate | Track 16 has no network sink yet. Documented TODO placed at the future emitter site; activate when Track 16 lands. |
