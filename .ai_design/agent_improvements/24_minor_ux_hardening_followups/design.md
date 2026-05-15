# Track 24: Minor UX & Hardening Follow-ups (Bundle)

**Priority: P1–P2 (per item)** · **Effort: S–M each** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a read of each sub-area in both codebases — see per-item "Validation Notes". A bundle of small independent improvements (mirrors how 08a/b/c/d were collapsed); each sub-item is independently pickable.

---

## 23.1 Fuse Fuzzy Command Ranking — **P1 · S**

**Claudy:** `utils/suggestions/commandSuggestions.ts:1` `import Fuse from 'fuse.js'`; a Fuse index **cached by commands-array identity** (`getCommandFuse`, `:30-32`); ranking blended with `getSkillUsageScore` (`skillUsageTracking.ts`). Siblings: `directoryCompletion`, `shellHistoryCompletion`.

**BrowserX:** `webfront/commands/CommandRegistry.ts` `filter()` (~`:95-117`) is strict: `command.name.startsWith(q)` then `description.toLowerCase().includes(q)`, sorted by `localeCompare`. No fuzzy, no usage weighting.

**Design:** replace the `filter()` body with a Fuse index cached by `this.commands` identity (claudy's exact caching trick) + optional recency/usage weight (the `lastExecuted` map in `MessageInput.svelte` already exists). Near drop-in; rides Track 03 / Track 13 (the funnel calls `filter`).

---

## 23.2 Output-Style Personas — **P2 · S**

**Claudy:** `outputStyles/loadOutputStylesDir.ts` loads `.md` files, parses frontmatter (`utils/frontmatterParser`), into `OutputStyleConfig {name, description, prompt, keepCodingInstructions}` (`constants/outputStyles.ts`); project+user, project wins; selected style injected as a system-prompt persona.

**BrowserX:** `prompts/PromptComposer.ts` composes static `.md?raw` fragments (`:11-18` — `browserx_intro`, `safety`, `browserx_tools`, `task_execution_policies`, `approval_policies`, …). No user-selectable persona/style.

**Design:** add a "style" fragment slot to `PromptComposer` loaded from a styles dir (frontmatter + project>user precedence, claudy's pattern), reusing the existing `?raw` fragment mechanism. Set via settings (claudy deprecated its `/output-style` command in favor of config — follow that). Small, low-risk.

---

## 23.3 Prompt Suggestion — **P2 · M**

**Claudy:** `services/PromptSuggestion/promptSuggestion.ts` — after ≥2 assistant turns, forks a **cache-piggybacked** agent (identical `cacheSafeParams`; any drift busts the prompt cache) predicting the user's next input (2–12 words); heavy regex filter strips Claude-voice/multi-sentence. `speculation.ts` then speculatively *executes* it in a COW filesystem overlay.

**BrowserX:** nothing.

**Design:** port the **suggestion** path only. **Explicitly do NOT port `speculation.ts`** — its COW filesystem overlay does not transfer to non-idempotent browser side effects (navigation/clicks/form-fills); claudy itself gates speculation to internal users. Suggestion is a contained latent-UX win; speculation is the same hazard class as Track 23's "never auto-pay on navigation."

---

## 23.4 Server-Exec Sandbox Hardening — **P2 · M**

**Claudy:** `utils/sandbox/sandbox-adapter.ts` wraps `@anthropic-ai/sandbox-runtime` (bubblewrap/Seatbelt): deny-write protected dirs, bare-git-repo escape scrub, `autoAllowBashIfSandboxed`.

**BrowserX:** desktop is **already covered** — `desktop/tools/terminal/SandboxManager.ts` exists. The real gap is **server**: `server/tools/registerServerTools.ts:13` `import { execSync } from 'node:child_process'`, `:333` `execSync(\`which ${candidate}\`, …)` — raw, unsandboxed, *and* a string-interpolated shell call (injection-adjacent even if `candidate` is currently controlled).

**Design:** (a) close the unsandboxed server `execSync` path — route server tool exec through a sandbox wrapper analogous to the desktop `SandboxManager` (or a server bwrap/container boundary); (b) replace string-interpolated `execSync(\`which ${candidate}\`)` with an arg-array `execFileSync('which',[candidate])`; (c) import claudy's escape-hardening heuristics (deny-write protected config/skills dirs, bare-git scrub). Narrower than greenfield — desktop is done.

---

## 23.5 Settings/Memory Sync + Secret Scanner — **Sync: P2 · L (deferred)** · **Secret scanner: P2 · S**

**Claudy:** `services/settingsSync/` (diff-only upload, Zod, checksum/version, fail-open); `services/teamMemorySync/secretScanner.ts` + `teamMemSecretGuard.ts` + `watcher.ts` block secrets **before** pushing shared memory.

**BrowserX:** `core/memory/` (`CoreMemoryManager`, `DailyMemoryStore`, `MemoryService`, `MemoryFileSystem`, `MemorySearcher`, `createMemoryService`) is **local-only**; grep finds no secret-scan / redact / export-share path.

**Design:**
- **Sync = P2/L, deferred** — needs a backend contract browserx lacks; do not start until one exists.
- **Secret scanner = P2/S, do independently** — a pre-share secret scanner is valuable *now* the moment memory leaves the device (Track 16 telemetry redaction, future export/share). Port claudy's `secretScanner` patterns; **fail-CLOSED on the share/export path** (the inverse of the usual fail-open — a missed secret is worse than a blocked share). Guards Track 05 memory + Track 16 egress.

---

## Dependencies

- **Track 03 / 12** (Commands/Input funnel): 23.1 (`filter` is called by the funnel), 23.2 (persona registry)
- **Track 05** (Memory) + **Track 16** (Telemetry): 23.5 secret scanner guards memory export / telemetry egress
- Existing `PromptComposer` (`?raw` fragments) — 23.2; desktop `SandboxManager` — 23.4 reference

## Risks

- 23.3: porting `speculation.ts` would be actively dangerous (non-idempotent browser actions) — suggestion only; this prohibition is the point.
- 23.4: server sandbox needs an OS mechanism (container/bwrap) available in the server deployment — verify per deployment; the `execFileSync` fix is unconditional and should land regardless.
- 23.5: secret-scanner false-negatives are dangerous — conservative patterns, **fail-closed on egress** (opposite of every other fail-open in this initiative — call it out so a future reader doesn't "fix" it to fail-open).
- 23.1: Fuse mis-ranking vs strict prefix could surprise users — keep exact-prefix as a hard top-rank tier, fuzzy below (claudy blends, doesn't replace).

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `utils/suggestions/commandSuggestions.ts:1,9,22-32` (Fuse + identity-cached index + skill-usage score); `outputStyles/loadOutputStylesDir.ts:3-35` (`OutputStyleConfig`, frontmatter, project>user); `services/PromptSuggestion/promptSuggestion.ts` (cache-piggyback) + `speculation.ts` (COW — excluded); `utils/sandbox/sandbox-adapter.ts`; `services/teamMemorySync/{secretScanner,teamMemSecretGuard,watcher}.ts`, `services/settingsSync/`.
- browserx: `webfront/commands/CommandRegistry.ts:~95-117` (strict `startsWith`/`includes` + `localeCompare` sort — no fuzzy); `prompts/PromptComposer.ts:11-18` (static `?raw` fragment composition, no persona); `server/tools/registerServerTools.ts:13,333` (raw interpolated `execSync` — unsandboxed); `desktop/tools/terminal/SandboxManager.ts` (desktop already covered); `core/memory/` (local-only, no secret-scan/export — grep).

Corrections vs the first-pass draft:
1. 23.1: pinned the exact strict-filter code (`CommandRegistry.ts:~95-117`) and that claudy caches Fuse by array identity — the fix is a body replacement, and exact-prefix must stay a hard top tier (not naive fuzzy).
2. 23.4: pinned the precise server gap (`registerServerTools.ts:333` interpolated `execSync`) and added an unconditional `execFileSync` injection fix that should land even where OS sandboxing is unavailable — the draft only said "close the path."
3. 23.5: made the **fail-closed-on-egress** contract explicit (inverse of the initiative-wide fail-open) so it is not "corrected" later; tied it to Track 16 egress, not only future sync.
4. 23.2: confirmed `PromptComposer` already uses `?raw` fragments — the persona slot reuses that mechanism (not a new prompt system).
