# Track 24: Minor UX & Hardening Follow-ups (Bundle)

**Priority: P1–P2 (per item)** · **Effort: S–M each** · **Status: IMPLEMENTATION-READY — all 5 items, no open decisions (validated + gap-closed against source 2026-05-16)**

> Source: second-pass claudy↔browserx research (2026-05-14), multi-platform pass (2026-05-15), **full browserx source validation pass (2026-05-16 — every path/line/claim below re-verified against the working tree; corrections folded in, see "Validation Corrections")**. "claudy" = the external Claude Code reference codebase; it is **not** in this repo, so its described patterns are treated as the porting spec, not re-verified here. A bundle of small independent improvements; each sub-item is independently pickable.

### Per-Platform Applicability (at a glance)

| Item | BrowserX (ext) | Apple Pi (desktop) | Apple Pi Server (headless) |
|---|---|---|---|
| 24.1 Fuse ranking | ✅ (shared `webfront`) | ✅ (shared `webfront`) | ❌ N/A — no command-autocomplete UI |
| 24.2 Personas | ✅ via settings (`IUserPreferences`) | ✅ via settings (`IUserPreferences`) | ✅ via `config.json` (`server.persona`); Track 20 policy override is **future** |
| 24.3 Prompt suggestion | ✅ (interactive) | ✅ (interactive) | ❌ N/A — gated off (`platformId === 'server'`) |
| 24.4 Server-exec hardening | ❌ N/A (no exec) | covered by Rust sandbox (not portable TS) | ✅ **the whole point** — footgun hardening, not a live CVE (see 24.4) |
| 24.5 Secret scanner | ⚠️ no egress path exists today | ⚠️ no egress path exists today | ✅ **highest *live* stakes** — connector replies + transcript WS |

> **Dependency-track status (verified 2026-05-16):** Track 03 (commands) **DONE**, Track 05 (memory) **DONE**, Track 17 (`core/diagnostics/redact.ts`) **DONE & reusable for 24.5**. Track 13 (input funnel) **NOT done — and not actually a dependency**, see 24.1. Track 16 (telemetry) **design-only, no code** — 24.5 telemetry gate is a documented future hook, not a current site. Track 20 (managed policy) **design-only, no code** — 24.2 server persona must ship via `config.json` now.

---

## 24.1 Fuse Fuzzy Command Ranking — **P1 · S** · *ext + desktop*

**Claudy:** `utils/suggestions/commandSuggestions.ts` — a Fuse index cached by commands-array identity (`getCommandFuse`), ranking blended with `getSkillUsageScore`; exact-prefix is a hard top tier (claudy blends, doesn't replace).

**BrowserX (verified):** `src/webfront/commands/CommandRegistry.ts`, `filter(query: string): FilteredCommand[]` at **lines 89–116** (doc previously said 89–117). Strict: `command.name.startsWith(q)` (`:100`), then `command.description.toLowerCase().includes(q)` (`:107`), `localeCompare` sort (`:112-113`). Returns `FilteredCommand = { command: Command; matchType: 'name' | 'description' }`. Exported singleton `commandRegistry`. Other public methods: `register/get/getAll/has/unregister/reset`. `Command` also has `whenToUse?` + `loadedFrom?` (extra Fuse keys).

- `fuse.js@^7.1.0` is **already a dependency** (`package.json:89`), already imported (default import) in `JobHistoryModule.svelte` and `SettingsSearch.svelte`. No new dep.
- **Single caller:** `src/webfront/components/MessageInput.svelte:188` (`updateFilter()` → `commandRegistry.filter(query)`). There is **no Track 03/13 "funnel" intermediary** — the earlier "called by the input funnel" dependency claim is wrong. `MessageInput.svelte` is the shared `webfront` component both ext + desktop consume, so one change ships both.
- `lastExecuted` exists at `MessageInput.svelte:120` (`Map<string, number>`, name→epochMs) **but** it is component-local and is a 500 ms exec **debounce**, not a ranking store, and never reaches `CommandRegistry`. It is structurally reusable as a recency signal only if threaded in explicitly.
- **No `filter()` tests exist** (only `__tests__/builtinCommands.doctor.test.ts`, which never touches `filter`). This is net-new test creation; nothing breaks.

**Design / change spec:**
1. `src/webfront/commands/CommandRegistry.ts` — replace `filter()`. New signature: `filter(query: string, recency?: ReadonlyMap<string, number>): FilteredCommand[]`. Keep return type and the `'name' | 'description'` union (do **not** add a `'fuzzy'` value — preserves the type contract and existing consumers). Tier 1 = exact-prefix (`startsWith(q)`), verbatim current logic, hard top rank; within tier, sort by `recency` desc when provided, else `localeCompare` (preserves today's behavior when `recency` absent). Tier 2 = `new Fuse(remaining, { keys:[{name:'name',weight:.6},{name:'description',weight:.3},{name:'whenToUse',weight:.1}], threshold:~0.4, ignoreLocation:true })`; map hits, `matchType` = `'name'` if strongest matched key is name else `'description'`; optional small recency blend. Per-call Fuse construction is fine (tiny command set) or memoize on a registry-version counter.
2. `src/webfront/components/MessageInput.svelte:188` — `commandRegistry.filter(query)` → `commandRegistry.filter(query, lastExecuted)`. `lastExecuted` already in scope (`:120`); registry stays stateless.
3. **New** `src/webfront/commands/__tests__/CommandRegistry.filter.test.ts` — assert: exact-prefix always outranks fuzzy/desc; typo (`dctr`) surfaces `/doctor` (old `startsWith` would not); `matchType ∈ {'name','description'}`; empty query returns all, recency reorders when map passed; absent `recency` reproduces legacy ordering (regression guard). Use `commandRegistry.reset()` + `register()` in `beforeEach` (mirror the doctor test).

---

## 24.2 Output-Style Personas — **P2 · S** · *all platforms; selection mechanism differs*

**Claudy:** `outputStyles/loadOutputStylesDir.ts` loads `.md` + frontmatter into `{name,description,prompt,keepCodingInstructions}`; project>user; injected as a system-prompt persona; `/output-style` deprecated in favor of config.

**BrowserX (verified):**
- `src/prompts/PromptComposer.ts` — fragments are Vite `?raw` static imports at **lines 11–20** (doc said 11–18; there are 10 imports). Class `PromptComposer` (`:45`): `composeMainInstruction(agentType, context?)` (`:56`), `composeCompactPrompt()` (`:88`), `composeSummaryPrefix()` (`:95`). Exports `AgentType = 'browserx'|'applepi'|'applepi-server'` (`:22`), `RuntimeContext` (`:24`). Assembly order in `composeMainInstruction` (`\n\n`-joined, falsy-filtered): (1) intro → (2) runtime metadata → (3) safety → (4) tools → (5) task policies → (6) approval policies.
- **`configurePromptComposer` is NOT in `PromptComposer.ts`** — it lives in `src/core/PromptLoader.ts:33`, real signature `configurePromptComposer(agentType: AgentType, context: Partial<RuntimeContext> = {})`. `context` is a typed `Partial<RuntimeContext>` (os/arch/shell/homeDir/browserConnection/cwd…), **not** an arbitrary object.
- Call sites (doc's `:584` was wrong): server `src/server/agent/ServerAgentBootstrap.ts:641` (`'applepi-server'`); desktop `src/desktop/agent/DesktopAgentBootstrap.ts:766` (`'applepi'`); extension `src/core/RepublicAgent.ts:269` (`'browserx'`, skipped if `isComposerConfigured()`).
- Settings plumbing (ext/desktop): `AgentConfig` singleton (`src/config/AgentConfig.ts:36`, `getInstance()`), `IAgentConfig.preferences: IUserPreferences` (`src/config/types.ts:282`), backed by `getConfigStorage()` → `ChromeConfigStorage`/`TauriConfigStorage`.
- Server config: `loadServerConfig()` (`src/server/config/server-config.ts:133`, env > `config.json` > Zod defaults), `ServerConfigSchema` (`:82`).
- `src/prompts/fragments/` = 11 flat snake_case `.md`, **no frontmatter, no dynamic dir scanner** (no `import.meta.glob` anywhere) — a glob loader must be introduced. Existing `__tests__/PromptComposer.test.ts` asserts substring/ordering per agent type.

**Resolved design decisions (were the open gaps; now closed — verified 2026-05-16):**

- **D1 — Frontmatter parser: hand-roll, no new dep.** `yaml@^2.8.2` *is* a direct dependency (`package.json:97`) but is **not used** here: the persona file's `prompt` is the **markdown body after the closing `---`**, so frontmatter only carries scalar `name`, `description`, `keepCodingInstructions` and no multi-line/quoted YAML ever needs parsing. (`js-yaml` exists only transitively under `@eslint/eslintrc` — unsafe to import directly; rejected.) `parsePersona(raw)` rule: if the file doesn't start with `---\n`/`---\r\n`, the whole file is the body with empty frontmatter; else split on the next line that is exactly `---` — text between delimiters is frontmatter, everything after the closing `---\n` (minus one leading newline) is `prompt`. Frontmatter lines: `/^([A-Za-z_]+)\s*:\s*(.*)$/`, accept only the 3 known keys, ignore unknown/blank/`#`, strip matching surrounding quotes. `keepCodingInstructions = String(v).trim().toLowerCase() === 'true'`; **absent ⇒ default `true`** (so a persona is a pure-additive no-op unless it explicitly opts out).
- **D2 — `keepCodingInstructions` gates exactly one push: the agent-tools push at `PromptComposer.ts:74`** (`sections.push(agentType === 'browserx' ? browserxTools : piTools)`). There is no separable "coding-style" sub-fragment — the tool/coding guidance is entirely that one fragment, so suppression is whole-section. Default output is **byte-identical** to today (no `personaName` ⇒ `resolvePersona` returns `null` ⇒ tools push runs unchanged ⇒ same `sections.filter(Boolean).join('\n\n')`).
- **D3 — `import.meta.glob` works on ALL targets incl. server; no fallback needed.** The server target is a Vite SSR build (`vite build --config vite.config.server.mts` → `dist/server/index.mjs`, run by `start:server`), and `src/prompts/` already relies on Vite `?raw` imports reached from `ServerAgentBootstrap.ts` — if server didn't go through Vite it'd already be broken. The `dev:server` ts-node path has no `?raw` loader shim so it already can't prompt-compose — the glob regresses nothing. `import.meta.glob` is already used at `src/webfront/lib/i18n/index.ts:20`; `tsconfig*.json` include `vite/client` types + `src/prompts/**`.

**Change spec:**
1. **New** `src/prompts/PersonaLoader.ts` — `parsePersona(raw)` per D1; built-ins via `import.meta.glob('./styles/*.md', {query:'?raw', eager:true, import:'default'})`; `resolvePersona(name): {prompt:string, keepCodingInstructions:boolean} | null`. Precedence: project `<cwd>/.browserx/styles/*.md` > user `<homeDir>/.browserx/styles/*.md` > bundled glob. The disk-override layer uses Node `fs` and is naturally a no-op in the extension (no fs) — intended, no build-config branching. Unknown name → `null` → prompt unchanged.
2. **New** `src/prompts/styles/<persona>.md` (≥1 built-in) + `src/prompts/__tests__/PersonaLoader.test.ts` (cover: no-frontmatter file = all-body; the 3-key parse; quote-strip; absent `keepCodingInstructions` = true).
3. `src/prompts/PromptComposer.ts` — add `personaName?: string` to `RuntimeContext` (after `:42`); import `resolvePersona`. Two hunks in `composeMainInstruction`:
   - after `:65` (`sections.push(intro);`): `const persona = resolvePersona(context?.personaName); if (persona) sections.push(persona.prompt);`
   - replace `:73-74` tools push with: `if (!persona || persona.keepCodingInstructions) { sections.push(agentType === 'browserx' ? browserxTools : piTools); }`
   Extend `PromptComposer.test.ts`: (a) no `personaName` ⇒ output unchanged (regression guard); (b) `keepCodingInstructions:false` ⇒ tools fragment absent, persona prompt present; (c) `true`/omitted ⇒ tools present.
4. `src/config/types.ts` (~`:314`) — add `personaName?: string` to `IUserPreferences` (+ defaults passthrough).
5. `src/server/config/server-config.ts:82` — add `persona: z.string().optional()` to the `server` object.
6. Wiring (read selected name, pass into `staticContext`): extension `RepublicAgent.ts:269`; desktop `DesktopAgentBootstrap.ts:766` (config already fetched at `:94`); server `ServerAgentBootstrap.ts:641` from `getServerConfig().server.persona` with `// TODO(track-20): managed-policy override once Track 20 lands`.

---

## 24.3 Prompt Suggestion — **P2 · M** · *ext + desktop (interactive only)*

**Claudy:** `services/PromptSuggestion/promptSuggestion.ts` — after ≥2 assistant turns, forks a cache-piggybacked agent predicting next input; heavy regex filter. `speculation.ts` then speculatively *executes* it in a COW overlay.

**BrowserX (verified):** nothing exists (grep hits for "suggestion" are all unrelated tab-select hints). **Doc's "cache-piggybacked agent fork" does not map to browserx:** there is no Anthropic `cache_control`/ephemeral support and no fork-prefix mechanism; the `anthropic` provider is routed through `OpenAIResponsesClient`. Cache reuse is only passive OpenAI-style `prompt_cache_key` (= session id, `OpenAIResponsesClient.ts:392`). **Realistic port = one extra cheap background model call**, not a fork. The cost rationale for gating off the server still holds.

The existing, near-identical template the doc omitted: **`src/core/title/TitleGenerator.ts:31` `generateTitle()`**, fired from `Session.maybeGenerateTitle()` (`Session.ts:2316`) after N user messages — same async non-blocking + `withModelRetry({source:'background'})` shape. Build the suggestion generator as its sibling.

- Turn-complete seam: `src/core/TaskRunner.ts:545` `emitTaskComplete()` (has `outcome.turnCount`). ">=2 assistant turns" = count `role:'assistant'` items in `session.getConversationHistory().items` (`Session.ts:361`).
- LLM call: `TurnContext.getModelClient()` → `ModelClient.stream(prompt)` (`src/core/models/ModelClient.ts:203`), wrapped in `withModelRetry` (`source:'background'`).
- Runtime gate: `IPlatformAdapter.platformId` (`src/core/platform/IPlatformAdapter.ts:69`, `'extension'|'desktop'|'server'`), reachable via `RepublicAgent.platformAdapter.platformId`. Run only when `!== 'server'`.
- UI seam: `MessageInput.svelte:21` `value = $bindable('')`, bound in `Main.svelte:1520` (`bind:value={inputText}`, `$state`). Surface as ghost text / dismissible chip; accept-on-Tab sets `value`.

**Resolved design (claudy's prompt/filter could not be ported — claudy is not in-repo — so both were designed from scratch here and are now concrete):**

**Module:** **new** `src/core/suggestions/promptSuggestion.ts` (class `PromptSuggestionGenerator`) + `src/core/suggestions/constants.ts`, built as a sibling of `src/core/title/TitleGenerator.ts`: build one `user` `ResponseItem`, call `modelClient.stream({ input, tools: [] })`, drain deltas accumulating `isOutputTextDelta`, break on `isCompleted`, all inside `withModelRetry({ source:'background', maxRetries:2 })` — copy `TitleGenerator`'s exact pattern (`callModelForTitle:132`, drain loop `:155-171`, `cleanTitle:177`).

**Context packing:** walk `session.getConversationHistory().items` from the end, take the last **6** `message` turns (roles `user`/`assistant` only — skip tool/reasoning, same extraction as `extractUserMessages:88-115`), tail-truncate each to **400 chars** (`…`), hard-cap the block ~3000 chars, format chronologically as `User:` / `Assistant:` lines (the final assistant turn is the strongest predictor — never drop it).

**Verbatim prompt (`constants.ts`):**
```
You predict the user's single most likely NEXT message in this chat. The user is talking to a browser-automation agent.

Conversation so far (oldest first):
<<<
{packedContext}
>>>

Output ONLY the predicted next user message, as if the user typed it. Rules:
- One short line. No preamble, no quotes, no labels, no markdown, no code fences.
- Maximum 160 characters.
- Plain natural request, phrased as the user (imperative or question).
- Do NOT propose destructive or irreversible actions (delete, pay, purchase, checkout, submit, or navigating to an external site).
- If you cannot confidently predict a useful follow-up, output exactly: NONE

Next message:
```
**N = 160 chars** (one comfortable line in the 3-line textarea `MessageInput.svelte:565`; 120 truncates real follow-ups, 200 invites model-narration runs). `NONE` sentinel → reject rule #2 → show nothing. Clean like `cleanTitle`: trim, strip leading `Next message:`/`Suggestion:` labels, strip wrapping quotes, then `REJECT_RULES`. Over-length is **discarded, never truncated** (a truncated one-tap suggestion misleads).

**`REJECT_RULES` (ordered; first match ⇒ `{suggestion: undefined}`, no event):** 1 empty/whitespace · 2 `/^NONE$/i` · 3 `len<6` · 4 `len>160` · 5 contains `\n` · 6 code fence/inline-code · 7 refusal/meta (`^(I (cannot|can't|am unable)|I'm (sorry|unable)|As an AI|As a language model|I do not|I don't have)`) · 8 preamble (`^(Here(\s|')s|Here is|Sure[,!]|Certainly[,!]|Of course[,!]|Below is|The (next|following))`) · 9 echoes last assistant msg — normalized word-set **Jaccard > 0.6** (lowercase, strip punctuation, split `/\s+/`) · 10 any `src/core/diagnostics/redact.ts` `RULES` regex matches (secret leak — reuse 24.5's `secretScanner` if landed, else `redact.ts` RULES) · 11 destructive `\b(delete|remove|drop|erase|wipe|purge|uninstall|format)\b` · 12 financial `\b(pay|payment|purchase|buy|checkout|order now|place (the|an) order|subscribe|confirm payment)\b` · 13 form-submit (`\b(submit|send|confirm|sign in|log ?in|authori[sz]e)\b.*\b(form|payment|order|application|request)\b` or `\bsubmit (the|this) form\b`) · 14 external-URL nav (`https?:\/\/\S+`). Rules 11–14 are the same hazard class as Track 23 "never auto-pay/auto-navigate" — never one-tap-accept an irreversible action.

**UX — dismissable chip below the input (NOT inline ghost text):** the current markup is a single bound `<textarea>` (`MessageInput.svelte:479-493`) with no overlay layer; a true ghost overlay needs a caret/scroll-synced mirror. Render `"Tab ↹  {suggestion}"` + `×` as a chip after the `pendingAttachments` indicator (`:471`), reusing the established "affordance under the input" pattern; never collides with `CommandDropdown`.

**Wiring:**
1. New `$bindable` prop `suggestion: string | null = null` on `MessageInput.svelte`; `Main.svelte:1519` adds `bind:suggestion={nextSuggestion}` with `let nextSuggestion = $state<string|null>(null)`.
2. New event: add `| { type:'PromptSuggestion'; data:{ suggestion:string } }` to the `EventMsg` union (`protocol/events.ts:28`, parallel to `TurnCompleteEvent:733`).
3. `TaskRunner.emitTaskComplete` (`TaskRunner.ts:545`) — **after** the existing `TaskComplete` emit: `this.session.maybeGenerateSuggestion().catch(() => {});` (fire-and-forget, never blocks).
4. New `Session.maybeGenerateSuggestion()` (parallel to `maybeGenerateTitle:2317`): guard `platformId === 'server'` → return; `assistantTurnCount < 2` → return; reuse `getModelClientForTitle:2392`; on a surviving suggestion `emitEvent({type:'PromptSuggestion',data:{suggestion}})`.
5. `Main.svelte` `handleEvent` switch (`:619`): `case 'PromptSuggestion'` → `nextSuggestion = msg.data.suggestion`; in the `TaskStarted` branch (`:602`) add `nextSuggestion = null`.
6. **Keydown precedence (load-bearing):** insert the Tab branch **after** the `isCommandMode` block closes (`MessageInput.svelte:262`) and **before** normal-mode `Enter` (`:264`):
   ```
   if (event.key === 'Tab' && !event.shiftKey && suggestion && !isCommandMode) {
     const isPrefix = value.length > 0 && suggestion.toLowerCase().startsWith(value.toLowerCase());
     if (value.trim() === '' || isPrefix) { event.preventDefault(); value = suggestion; suggestion = null; return; }
   }
   if (event.key === 'Escape' && suggestion && !isCommandMode) { event.preventDefault(); suggestion = null; return; }
   ```
   Tab is otherwise inert (default focus traversal preserved); palette keeps its Tab-free behavior because it's handled in the earlier `isCommandMode` block.
7. **Clear suggestion on:** divergence — in `handleInput()` (`:285`) `if (suggestion && !suggestion.toLowerCase().startsWith(value.toLowerCase())) suggestion = null;`; submit (`submitWithAttachments():65`); new turn (`TaskStarted`); Escape; chip `×`. The `lastExecuted` 500 ms command debounce (`:120/:194`) is untouched (Tab/Escape never enter `executeCommand`).

**Explicitly DO NOT port `speculation.ts`.** browserx tool exec drives non-idempotent browser side effects (navigation/clicks/form-fills/payments — same hazard class as Track 23 "never auto-pay on navigation"); there is no COW-overlay analog for live DOM/network state. Hard scope exclusion — the prohibition is the point. (Reject rules 11–14 are the suggestion-path expression of the same principle.)

---

## 24.4 Server-Exec Sandbox Hardening — **P2 · S (downgraded from M)** · *Apple Pi Server only*

**Claudy:** `utils/sandbox/sandbox-adapter.ts` wraps bubblewrap/Seatbelt: deny-write protected dirs, bare-git escape scrub, `autoAllowBashIfSandboxed`.

**BrowserX (verified — doc framing corrected):**
- `src/server/tools/registerServerTools.ts:13` `import { execSync } from 'node:child_process';` and `:333` `execSync(\`which ${candidate}\`, { encoding:'utf-8' })` inside `findChromeBinary()` (`:322-341`). **Line numbers exact.**
- **NOT a live injection vuln:** `candidate` iterates a hardcoded literal array (`'chromium'`, `'chromium-browser'`, `'google-chrome'`, `'google-chrome-stable'`, `:324-329`) — no agent/network/env data flows into the interpolated string. This is **footgun / lint-grade hardening** (interpolated `execSync` is dangerous *if the array ever becomes dynamic*), **not the "highest blast radius / injection-adjacent" item the prior draft claimed.** Effort downgraded S; priority stays P2 but it is no longer the lead item.
- `:333` is the **sole** raw shell-exec in all of `src/server/**` (doc's count is correct, not an undercount). No server-side terminal/bash/run tool is registered — the server agent cannot run arbitrary shell.
- **`SandboxManager` is NOT reusable server-side** (prior "desktop already covered" is misleading): `src/desktop/tools/terminal/SandboxManager.ts` is a Tauri-IPC **config/status broker** (`invoke('sandbox_*')`); the actual bwrap/Seatbelt enforcement is in the Rust backend. It hard-imports `@tauri-apps/api` and cannot run in a Node server process. The companion `src/desktop/tools/terminal/SecurityFilter.ts` (pure-TS regex blocklist `check()`) **is** portable.
- Residual surface the doc missed: `src/server/mcp/NodeMCPBridge.ts:63` `new StdioClientTransport({command,args,…})` spawns user-configured MCP servers — arg-array (no string injection) but **arbitrary unvalidated binary/args**. Existing `src/server/exec/approval-manager.ts` (`ApprovalManager`, tool-name allowlist) is an interactive approval gate, **not** an OS sandbox.
- `src/server/tools/__tests__/registerServerTools.test.ts` **mocks `node:child_process`** (`:38-42`) and asserts on a single string command (`cmd.includes('google-chrome')`, `:180`) — **the swap WILL break this test**; updating it is mandatory, not optional.

**Design / change spec:**
1. **Unconditional (always lands):** `:13` → `import { execFileSync } from 'node:child_process';` (replace, no keep-both — `execSync` has no other use). `:333` → `execFileSync('which', [candidate], { encoding:'utf-8' }).trim()`. Behavior identical (`which` non-zero exit → throw → existing `catch`).
2. **Required test update:** `registerServerTools.test.ts` — retarget the hoisted mock to `execFileSync` (named + on `default`); `:179-181` → `mockImplementation((file,args)=> file==='which'&&args?.[0]==='google-chrome' ? '/usr/bin/google-chrome' : (()=>{throw new Error('not found')})())`; not-found mocks throw; add a positive assertion that `execFileSync` is called as `('which',[candidate],{encoding:'utf-8'})` (proves no shell string).
3. **Sandbox boundary — pick scope explicitly:**
   - (a) *Minimal, recommended for this track:* the `execFileSync` swap alone closes the only server shell-exec; no OS sandbox needed since the server has no arbitrary-shell tool.
   - (b) *Defense-in-depth:* extract `SecurityFilter` to a shared location and apply it in `NodeMCPBridge.connect()` to vet user-configured MCP `command`/`args` (the real residual exec surface).
   - (c) *Full claudy parity (bwrap/Seatbelt around the MCP spawn + deny-write protected config/skills dirs + bare-git scrub):* genuinely new infra — **larger than the doc's old "M"**; defer unless an operator threat model demands it.

---

## 24.5 Settings/Memory Sync + Secret Scanner — **Sync: P2 · L (deferred)** · **Secret scanner: P2 · S — now the highest *live*-risk item in the bundle** · *server stakes dominate*

**Claudy:** `services/teamMemorySync/secretScanner.ts` + `teamMemSecretGuard.ts` block secrets before pushing shared memory; `services/settingsSync/` (diff-only, Zod, fail-open).

**BrowserX (verified):**
- `src/core/memory/` is local-only (write `MemoryService.saveFact:73`, read `getGlobalContextText:107`, FS under `~/.airepublic-pi/memory`). **No serialize-out/export/share/download of memory exists anywhere** (ext, desktop, tauri all grep-empty). The prior draft's "memory export path" gate **does not exist — drop it.** Memory only egresses indirectly: injected into the prompt, the model may echo it into an egress surface (caught at the gates below).
- **Connector replies — TWO outbound sites, not one** (`src/server/channel-connectors/connector-bridge.ts`): `:247` `outbound.sendText(outCtx, event.msg.data.message)` (inbound reply callback — primary) **and** `:160` `outbound.sendText(outboundCtx, msg.data.message)` (AgentMessage broadcast — the prior draft missed this). Both are #1-tier exfil paths (Slack/Telegram from unattended jobs).
- WS transcript egress: `src/server/channels/ServerChannel.ts:108` `conn.ws.send(frame)` in `sendEvent()` (frame carries `AgentMessage.data.message`, built `:94-95`).
- Transcript at-rest: `src/server/agent/ServerAgentBootstrap.ts:213` `transcriptStore.append('__active__', {data: event.msg})` — local JSONL, re-readable over WS via `transcript.*` handlers.
- `logs.tail`: `src/server/handlers/logs.ts:51` `sub.sendEvent('log', entry)` ← `health/log-streamer.ts` wraps `console.*` (secondary — only if agent text is `console.log`'d).
- Track 16 telemetry: **not implemented** (`core/diagnostics/redact.ts:4` explicitly says so; existing `emitTelemetry` is in-memory, no network sink). Scanner there is a **documented future hook, no current site.**
- **Reuse existing redaction:** `src/core/diagnostics/redact.ts` (Track 17, DONE) already has `redactString()` (`:49`) + `RULES` (`:23-42`: `sk-`, `xai-`, `AIza`, `Bearer`, JWT, `key=value`, URL userinfo). The scanner should reuse/extend this rule set, not reinvent it.

**Design / change spec:**
- **Sync = P2/L, deferred** — needs a backend contract browserx lacks. Do not start.
- **Secret scanner = P2/S, do now.** **New** `src/core/security/secretScanner.ts` reusing `redact.ts` `RULES` extended with AWS `AKIA`, GitHub `ghp_`/`gho_`, generic high-entropy 32+ hex/base64. API:
  ```ts
  export interface SecretSpan { start:number; end:number; ruleId:string }
  export interface ScanResult { spans:SecretSpan[]; block:boolean; redacted:string }
  export function scanForSecrets(text:string): ScanResult;
  ```
  **Fail-closed contract (inverse of the initiative-wide fail-open — flagged so a future reader does not "fix" it):** `block === true` iff any high-confidence rule matches **OR** "uncertain" (input > `MAX_SCAN_BYTES` ≈256 KB so the regex pass can't complete deterministically, **or** the pass throws). On `block` the gate MUST replace the outbound payload with a fixed safe string (`"[blocked: outbound message withheld — possible secret detected]"`) and MUST NOT send the original. A missed secret is worse than a blocked share.
- **Enumerated fail-closed gate sites (stakes-ordered):**

  | # | Site | Action |
  |---|---|---|
  | 1a | `connector-bridge.ts:247` | scan `event.msg.data.message`; on block send safe string |
  | 1b | `connector-bridge.ts:160` | same (broadcast path) |
  | 2 | `ServerChannel.ts:94-108` | scan `AgentMessage/Delta/Reasoning .data.message`; substitute redacted text into `payload` before `JSON.stringify`/`ws.send` |
  | 3 | `ServerAgentBootstrap.ts:213` | store **redacted** form in transcript (defense-at-rest; non-blocking) |
  | 4 | *(future)* Track 16 emitter | NOT IMPLEMENTED — document scanner as a mandatory pre-emit hook for whoever builds Track 16 |

---

## Implementation Plan (file-level, ordered; items independent)

Re-ordered after validation — **24.5 connector-reply gate is the highest *live*-risk change** (real external data flow into Slack/Telegram from unattended jobs); 24.4 is cheap footgun hardening, no longer the lead.

1. **24.5 secret scanner:** `src/core/security/secretScanner.ts` (reuse `core/diagnostics/redact.ts` RULES); fail-closed gates at `connector-bridge.ts:247` & `:160`, `ServerChannel.ts:94-108`, redacted transcript at `ServerAgentBootstrap.ts:213`. Track 16 = documented future hook only.
2. **24.4 (unconditional part):** `registerServerTools.ts:13` import → `execFileSync`, `:333` → `execFileSync('which',[candidate],…)`; **mandatorily** update `__tests__/registerServerTools.test.ts` mock + assertions. Sandbox boundary scope = (a) minimal unless an operator threat model demands (b)/(c).
3. **24.1:** rewrite `CommandRegistry.ts` `filter()` (`:89-116`) — exact-prefix hard tier + Fuse (dep already present) + optional `recency` param; thread `lastExecuted` from `MessageInput.svelte:188`; **add** net-new `CommandRegistry.filter.test.ts`. Ships ext + desktop.
4. **24.2:** new `PersonaLoader.ts` (+ `styles/` glob, project>user), `personaName` on `RuntimeContext` (`PromptComposer.ts`) + `IUserPreferences` (`config/types.ts`) + `ServerConfigSchema` (`server-config.ts:82`); wire the three call sites (`RepublicAgent.ts:269`, `DesktopAgentBootstrap.ts:766`, `ServerAgentBootstrap.ts:641`).
5. **24.3:** new `src/core/suggestions/promptSuggestion.ts` modeled on `TitleGenerator`; hook `TaskRunner.ts:545`; gate `platformId !== 'server'`; UI via new event → `Main.svelte:575` → `MessageInput`. **No `speculation.ts`.**
6. **24.5 sync:** deferred until a backend contract exists.

## Dependencies

- **Track 03** (Commands): 24.1 modifies the Track 03 `CommandRegistry`. Note: 24.1 has **no** Track 13 funnel dependency (single direct caller — the prior draft's claim was wrong).
- **Track 17** (`core/diagnostics/redact.ts`, DONE): 24.5 reuses its `RULES`.
- **Track 05** (Memory, DONE): 24.5 — but no memory *export* site exists; scanner guards connector/WS/transcript egress only.
- **Track 16** (Telemetry, design-only): 24.5 telemetry gate is a future hook, no current site.
- **Track 20** (Managed policy, design-only): 24.2 server persona ships via `config.json`; policy override is a future TODO.
- Existing: `PromptComposer` `?raw`/`import.meta.glob` (24.2), `TitleGenerator` template (24.3), desktop `SecurityFilter` (24.4 optional reuse — `SandboxManager` is **not** reusable), `connector-bridge`/`ServerChannel` (24.5 egress).

## Risks

- 24.3: porting `speculation.ts` would be actively dangerous (non-idempotent browser actions) — suggestion only; the prohibition is the point. Also: no Anthropic cache-fork in browserx — it is a plain extra background model call (TitleGenerator pattern); frame cost accordingly.
- 24.4: reframed — **not a live injection** (`candidate` is a literal array); the `execFileSync` swap is unconditional footgun hardening and **breaks the existing test mock** (must update). Full OS-sandbox parity is larger than "M" — keep scope minimal unless threat model demands more.
- 24.5: secret-scanner false-negatives are dangerous — conservative patterns, **fail-closed on egress** (the *only* fail-closed path in this initiative — do not "fix" it to fail-open). Two connector sites + WS, not one export path (which doesn't exist).
- 24.1: Fuse mis-ranking vs strict prefix could surprise users — exact-prefix stays a hard top tier; the regression-guard test (absent `recency` = legacy order) pins this.
- 24.2: ~~`import.meta.glob` is new for `src/prompts/`~~ **resolved (D3)** — server is a Vite SSR build and `src/prompts/` already relies on Vite `?raw`; glob is already used at `i18n/index.ts:20`. Residual minor risk: a malformed user persona file — `parsePersona` must fail soft (treat unparseable as no-frontmatter / return `null`), never throw into prompt composition.
- 24.3: the suggestion prompt + `REJECT_RULES` were authored in-repo (claudy unavailable to port) — they are heuristic by nature; rules 11–14 (destructive/financial/form/URL) are the safety-critical ones and must not be loosened. Jaccard echo-threshold (0.6) and N=160 are tunable but pre-chosen so a dev needn't decide.

## Validation Corrections (vs the 2026-05-15 draft, verified against source 2026-05-16)

1. **24.1:** `filter()` is `:89-116` not `:89-117`; `fuse.js` already a dep; `lastExecuted` is a private exec-debounce (must be threaded as a new param, not "already usable"); single caller `MessageInput.svelte:188` — **no Track 03/13 funnel dependency**; **no existing `filter()` tests** (net-new, nothing "to update").
2. **24.2:** `configurePromptComposer` is in `PromptLoader.ts:33`, not `PromptComposer.ts`; server call site is `:641` not `:584`; PromptComposer imports are `:11-20`; **no dynamic fragment scanner exists** (`import.meta.glob` must be added); Track 20 is design-only → ship via `config.json`.
3. **24.3:** "cache-piggybacked fork" does **not** map to browserx (no Anthropic `cache_control`; `anthropic`→`OpenAIResponsesClient`; only passive `prompt_cache_key`) — realistic port is one cheap background call modeled on the existing `TitleGenerator` (which the draft omitted entirely).
4. **24.4:** line numbers correct, but `candidate` is a **hardcoded literal array → no live injection**; reframed to footgun/lint hardening (P2·S, not the lead item); `SandboxManager` is a Tauri-IPC broker **not reusable server-side**; missed surfaces: `NodeMCPBridge.ts:63` (arbitrary user MCP spawn) + existing `ApprovalManager`; the swap **breaks** `registerServerTools.test.ts` (mock update mandatory).
5. **24.5:** no memory-export site exists (drop that gate); **two** connector outbound sites (`:247` + `:160`, draft missed `:160`); pin WS egress at `ServerChannel.ts:108`; Track 16 not implemented (future hook); **reuse** `core/diagnostics/redact.ts` RULES rather than reinvent.
6. **Gap-closure pass (2026-05-16):** the two non-uniform items were resolved to remove all open decisions — **24.2:** hand-roll parser (body-as-prompt, no YAML dep), `keepCodingInstructions` gates the single tools push at `PromptComposer.ts:74`, `import.meta.glob` confirmed safe on every target incl. the Vite-SSR server build. **24.3:** the suggestion prompt, the 14-rule `REJECT_RULES`, and the chip + Tab-precedence UX were designed in-repo (claudy not portable) and pinned with verbatim text / regexes / pseudo-diffs. All 5 items are now uniformly implementation-ready.
