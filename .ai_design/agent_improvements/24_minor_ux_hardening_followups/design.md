# Track 24: Minor UX & Hardening Follow-ups (Bundle)

**Priority: P1–P2 (per item)** · **Effort: S–M each** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a read of each sub-area in both codebases — see per-item "Validation Notes". A bundle of small independent improvements; each sub-item is independently pickable. Sub-items renumbered 24.x to match the README (was 23.x — a stale typo).

### Per-Platform Applicability (at a glance)

| Item | BrowserX (ext) | Apple Pi (desktop) | Apple Pi Server (headless) |
|---|---|---|---|
| 24.1 Fuse ranking | ✅ (shared `webfront`) | ✅ (shared `webfront`) | ❌ N/A — no command-autocomplete UI; commands arrive as text via WS/connector → Track 13 funnel |
| 24.2 Personas | ✅ via settings UI | ✅ via settings UI | ✅ via config file / Track 20 policy (operator-wide persona for scheduled jobs) |
| 24.3 Prompt suggestion | ✅ (interactive) | ✅ (interactive) | ❌ N/A — no user to suggest to |
| 24.4 Server-exec hardening | ❌ N/A (no exec) | already covered (`SandboxManager`) | ✅ **the whole point** — this is an Apple Pi Server hardening item |
| 24.5 Secret scanner | ✅ (telemetry/export egress) | ✅ (export/sync egress) | ✅ **highest stakes** — most egress surface (transcript WS, `logs.tail`, connector replies) |

---

## 24.1 Fuse Fuzzy Command Ranking — **P1 · S** · *ext + desktop*

**Claudy:** `utils/suggestions/commandSuggestions.ts:1` `import Fuse from 'fuse.js'`; a Fuse index **cached by commands-array identity** (`getCommandFuse`, `:30-32`); ranking blended with `getSkillUsageScore`.

**BrowserX:** `webfront/commands/CommandRegistry.ts` `filter(query)` (`:89`, body `:89-117`) is strict: `command.name.startsWith(q)` (`:100`) then `description.toLowerCase().includes(q)` (`:107`), `localeCompare` sort (`:112-113`). No fuzzy, no usage weighting.

**Design:** replace the `filter()` body with a Fuse index cached by `this.commands` identity (claudy's exact trick) + optional recency weight (`MessageInput.svelte`'s `lastExecuted` map already exists). `CommandRegistry` lives in shared `webfront` → one change fixes ext + desktop. Server has no command-autocomplete surface (commands are text through the Track 13 funnel) — out of scope there. Keep exact-prefix as a hard top-rank tier (claudy blends, doesn't replace).

---

## 24.2 Output-Style Personas — **P2 · S** · *all platforms; selection mechanism differs*

**Claudy:** `outputStyles/loadOutputStylesDir.ts` loads `.md` + frontmatter into `OutputStyleConfig {name,description,prompt,keepCodingInstructions}`; project>user; injected as a system-prompt persona.

**BrowserX:** `prompts/PromptComposer.ts` composes static `.md?raw` fragments (`:11-18`). No user-selectable persona. `configurePromptComposer(platform, ctx)` is called per platform (server: `ServerAgentBootstrap.ts:584` `'applepi-server'`; desktop/extension analogously).

**Design:** add a "style" fragment slot to `PromptComposer` loaded from a styles dir (frontmatter + project>user, claudy's pattern), reusing the existing `?raw` mechanism. **Per-platform selection:** ext/desktop set it via the settings UI; **Apple Pi Server sets it via the config file / a Track 20 managed-policy key** so an operator can pin a persona across all unattended scheduled jobs (a real headless use case with no claudy analog). Follow claudy's deprecation of `/output-style` in favor of config.

---

## 24.3 Prompt Suggestion — **P2 · M** · *ext + desktop (interactive only)*

**Claudy:** `services/PromptSuggestion/promptSuggestion.ts` — after ≥2 assistant turns, forks a **cache-piggybacked** agent predicting the user's next input; heavy regex filter. `speculation.ts` then speculatively *executes* it in a COW filesystem overlay.

**BrowserX:** nothing.

**Design:** port the **suggestion** path only, gated to interactive runtimes (ext/desktop — there is no user to suggest to headless; the fork would be pure cost on the server). **Explicitly do NOT port `speculation.ts`** — its COW overlay does not transfer to non-idempotent browser side effects (navigation/clicks/form-fills); claudy itself gates speculation to internal users. Same hazard class as Track 23's "never auto-pay on navigation."

---

## 24.4 Server-Exec Sandbox Hardening — **P2 · M** · *Apple Pi Server only*

**Claudy:** `utils/sandbox/sandbox-adapter.ts` wraps `@anthropic-ai/sandbox-runtime` (bubblewrap/Seatbelt): deny-write protected dirs, bare-git escape scrub, `autoAllowBashIfSandboxed`.

**BrowserX:** desktop **already covered** — `desktop/tools/terminal/SandboxManager.ts`. The gap is **Apple Pi Server**: `server/tools/registerServerTools.ts:13` `import { execSync }`, `:333` `execSync(\`which ${candidate}\`)` — raw, unsandboxed, string-interpolated (injection-adjacent). This is squarely a headless-server hardening item: the server runs unattended, often containerized and connector-exposed, so an unsandboxed interpolated exec is the highest-blast-radius issue in the bundle.

**Design:** (a) route server tool exec through a sandbox wrapper analogous to the desktop `SandboxManager` (or a server bwrap/container boundary); (b) **unconditionally** replace `execSync(\`which ${candidate}\`)` with arg-array `execFileSync('which',[candidate])` (lands even where OS sandboxing is unavailable); (c) import claudy's escape-hardening heuristics (deny-write protected config/skills dirs, bare-git scrub). Extension has no exec (N/A); desktop done.

---

## 24.5 Settings/Memory Sync + Secret Scanner — **Sync: P2 · L (deferred)** · **Secret scanner: P2 · S** · *all; highest stakes on server*

**Claudy:** `services/settingsSync/` (diff-only, Zod, checksum/version, fail-open); `services/teamMemorySync/secretScanner.ts` + `teamMemSecretGuard.ts` + `watcher.ts` block secrets **before** pushing shared memory.

**BrowserX:** `core/memory/` is **local-only**; no secret-scan / redact / export-share path (grep).

**Design:**
- **Sync = P2/L, deferred** — needs a backend contract browserx lacks; do not start until one exists.
- **Secret scanner = P2/S, do now** — valuable the moment memory leaves the device. Port claudy's `secretScanner` patterns; **fail-CLOSED on the share/export/egress path** (the inverse of the initiative-wide fail-open — a missed secret is worse than a blocked share). **Per-platform stakes:** the extension egress is telemetry/export; desktop adds export/sync; **Apple Pi Server has by far the most egress surface** — it streams transcripts over WS, mirrors to `logs.tail`, and (critically) the agent can emit text into **connector replies** (Slack/Telegram via `ConnectorBridge`). A secret landing in a Slack reply from an unattended job is a live exfil path, so the scanner is most critical headless and must guard the connector-reply + transcript + Track 16 paths, not only "export."

---

## Implementation Plan (file-level, ordered; items independent)

1. **24.4 (P2, highest blast radius) first, unconditional part:** in `server/tools/registerServerTools.ts`, replace `:333` interpolated `execSync(\`which ${candidate}\`)` with `execFileSync('which',[candidate])`; audit `:13` `execSync` importers. Then route server exec through a `SandboxManager`-analogous boundary (reuse `desktop/tools/terminal/SandboxManager.ts` as the reference).
2. **24.1:** swap `webfront/commands/CommandRegistry.ts` `filter()` body for a Fuse index cached by `this.commands` identity + exact-prefix top tier + `lastExecuted` recency weight. Ships ext + desktop together.
3. **24.5 secret scanner:** `core/memory/secretScanner.ts` (port claudy patterns); fail-closed gate invoked on every egress — Track 16 sink, memory export, and the server `ConnectorBridge` reply path + transcript store.
4. **24.2:** `PromptComposer` style-fragment slot from a styles dir (frontmatter, project>user); selection from settings (ext/desktop) and config/Track-20 policy (server).
5. **24.3:** `core/suggestions/promptSuggestion.ts` (cache-piggyback, suggestion only), gated to interactive platforms; **no `speculation.ts`**.
6. **24.5 sync:** deferred until a backend contract exists.

## Dependencies

- **Track 03 / 13** (Commands / Input funnel): 24.1 (`filter` called by the funnel), 24.2 (persona registry).
- **Track 05** (Memory) + **Track 16** (Telemetry): 24.5 scanner guards memory export / telemetry / connector-reply egress.
- **Track 20** (Managed Settings): 24.2 server persona pin is a policy key.
- Existing `PromptComposer` (`?raw`), desktop `SandboxManager` (24.4 reference), `ConnectorBridge` (24.5 egress surface).

## Risks

- 24.3: porting `speculation.ts` would be actively dangerous (non-idempotent browser actions) — suggestion only; the prohibition is the point.
- 24.4: server sandbox needs an OS mechanism (container/bwrap) per deployment — verify; the `execFileSync` fix is unconditional and lands regardless.
- 24.5: secret-scanner false-negatives are dangerous — conservative patterns, **fail-closed on egress** (opposite of every other fail-open in this initiative — flagged so a future reader doesn't "fix" it to fail-open). Server connector-reply path is the highest-risk egress.
- 24.1: Fuse mis-ranking vs strict prefix could surprise users — exact-prefix stays a hard top tier.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `utils/suggestions/commandSuggestions.ts:1` (`import Fuse`), `:9` (`getSkillUsageScore`), `:30` (`getCommandFuse` identity-cache), `:403` (`fuse` use); `outputStyles/loadOutputStylesDir.ts:3,5,27`; `services/PromptSuggestion/promptSuggestion.ts` + `speculation.ts` (excluded); `utils/sandbox/sandbox-adapter.ts`; `services/teamMemorySync/{secretScanner,teamMemSecretGuard,watcher}.ts`, `services/settingsSync/`.
- browserx: `webfront/commands/CommandRegistry.ts:89-117` (shared ext+desktop; strict `filter`, `startsWith:100`/`includes:107`/`localeCompare:112`); `prompts/PromptComposer.ts:11-18` + `src/server/agent/ServerAgentBootstrap.ts:584` (`configurePromptComposer('applepi-server',…)` — per-platform persona selection); `server/tools/registerServerTools.ts:13,333` (raw interpolated `execSync` — server-only gap); `desktop/tools/terminal/SandboxManager.ts` (desktop covered); `core/memory/` (local-only); `src/server/channel-connectors/connector-bridge.ts` (connector-reply egress — 24.5 highest-risk path).

Corrections vs the first-pass draft:
1. 24.1: pinned the strict-filter code + Fuse identity-cache; exact-prefix stays a hard top tier; scoped to shared `webfront` (ext+desktop, not server).
2. 24.4: pinned the precise server gap + unconditional `execFileSync` fix; framed explicitly as an Apple Pi Server hardening item (desktop already done, extension N/A).
3. 24.5: **fail-closed-on-egress** made explicit; egress surface widened to the server connector-reply + transcript paths (highest stakes), not only "export."
4. 24.2: `PromptComposer` `?raw` reuse confirmed; added the per-platform selection split (settings UI vs server config/Track-20 policy for an operator-wide persona).
5. **Multi-platform (2026-05-15):** added the per-item applicability matrix — 24.1/24.3 are interactive-only (ext+desktop), 24.4 is Apple Pi Server-only, 24.2/24.5 span all but with platform-specific mechanisms/stakes. Renumbered sub-items 23.x→24.x to match the README.
