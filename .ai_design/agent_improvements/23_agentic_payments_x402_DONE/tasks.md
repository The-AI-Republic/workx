# Track 23 Tasks

> **Status (2026-05-18):** DONE — merged into `agent-improvements` via PR #238. Effort **L**.
> Phases match `design.md` numbering exactly (Phase 0–4) so the two stay
> consistent. **Phase 0–1 are zero-funds and ship the gate + dry-run** — do
> these first; nothing signs or spends until Phase 2, and the track goal is
> only met at end of Phase 3. **No real funds before Phase 4.**

See [`design.md`](./design.md) for rationale, the resolved ⚠️ fail-open error,
verified `file:line` seams, and Validation Notes. This track is **self-contained**:
Tracks 18/20/22 were verified absent in `src/`, so their minimal slices ship
here (Phase 0).

---

## Pre-implementation verification (DO FIRST — gates the estimate)

The design was line-level verified on `feat/track-17-operational-diagnostics`
(2026-05-16). The branch moves and every item below is load-bearing — re-confirm
and record findings inline before editing. If any "absent" fact has since
changed, the corresponding Phase-0 slice may be dropped in favour of the real track.

- [ ] **Re-confirm greenfield.** `grep -rniE "x402|x-payment|EIP-?712|EIP-?3009|USDC|micropayment" src/` → only the unrelated `src/core/models/ModelClientError.ts` 402-as-usage-limit collision. If any payment code now exists, stop and re-scope.
- [ ] **Re-confirm Track 22 absent.** `grep -rn "isFeatureEnabled\|feature(" src/ | grep -vi test` → none gating behavior; only the test-only `FeatureFlagRecorder` (`src/core/session/state/SessionServices.ts:23-26`). ⇒ in-track config gate (Phase 0.1). If Track 22 landed, wire its gate instead and note here.
- [ ] **Re-confirm Track 18 absent.** `grep -rn "CostTracker\|formatTotalCost\|totalCostUsd" src/` → none. Only token counting (`src/core/AgentTask.ts` `TokenBudget`). ⇒ in-track tracker (Phase 0.2).
- [ ] **Re-confirm Track 20 absent.** `grep -rn "ManagedSettings\|ManagedPolicy\|chrome.storage.managed" src/` → none. Server policy surface is the Zod config only. Confirm `ExecConfigSchema` (`src/server/config/server-config.ts:36-39`), `ServerConfigSchema` (`:75`), `getServerConfig()`/`loadServerConfig()`/`onConfigReload()` unchanged. ⇒ in-track `server.x402` schema (Phase 0.3).
- [ ] **Re-confirm the gate is server-absent (the resolved error).** `grep -rn "setApprovalGate\|new ApprovalGate" src/` → only `src/extension/background/service-worker.ts:118` and `src/desktop/agent/DesktopAgentBootstrap.ts:258`; **zero in `src/server`**. Confirm `src/tools/ToolRegistry.ts:426` still guards the gate block on `if (this.approvalGate)` and `preExecuteCheck` (`:407-423`) still runs unconditionally before it. Confirm `ApprovalGate.ts:23` still imports the **core** `../ApprovalManager` and `ApprovalManager.ts:183-184` (balanced hang) / `:145-176` (high_speed auto-approve) unchanged.
- [ ] **Re-confirm the injection seam.** `ToolContext` (`src/tools/BaseTool.ts:166-173`) still has no services handle; `ToolRegistry.execute` still builds it at `:497-506`. `ToolHandler` sig still `(parameters, context) => Promise<any>` (`:178-180`).
- [ ] **Re-confirm custody.** `src/core/storage/CredentialStore.ts` interface (`get/set/delete/listAccounts(service,account)`, `getCredentialStore()`/`setCredentialStore()`) unchanged; impls present: `ChromeCredentialStore`, `KeytarCredentialStore`, `FileCredentialStore(dataDir)` (still `0o600`, AES-256-GCM, throws without `VITE_VAULT_SECRET`, **fails open to `{}` on decrypt error** — record the exact lines).
- [ ] **Re-confirm command + platform.** `src/webfront/commands/CommandRegistry.ts` `commandRegistry.register` is still webfront-only (server has no slash registry). `IPlatformAdapter.platformId` still `'extension'|'desktop'|'server'` (`src/core/platform/IPlatformAdapter.ts:69`), read via `RepublicAgent.platformAdapter.platformId`.
- [ ] **Decide the vetted crypto lib.** `viem` vs `ethers` vs `coinbase/x402` SDK for EIP-3009/EIP-712. Confirm it bundles under MV3/Tauri/node (extension only needs detect, not signer — pick a lib whose signer is tree-shakeable out of the extension build). Record the choice + version here. (Do NOT port claudy's `client.ts` crypto — verified broken: `sha3-256`≠keccak256, hardcoded `v=27`.)
- [ ] **Decide the trivial-amount threshold + default caps.** Per-request / per-session / server per-day USD. Claudy defaults are `$0.10` / `$5.00`; pick browserx values with the product owner and record here.

---

## Phase 0: In-track foundations (replaces absent Track 22/18/20 deps)

**Goal:** All plumbing present, behavior unchanged, gate OFF everywhere. No
payment logic yet — fully unit-testable in isolation.
**Estimated size:** ~250 LOC + tests. **Single PR.**

### 0.1 Config gate (Track 22 stand-in)

- [ ] `src/core/payments/x402/config.ts` — typed `X402Config` (enabled, network, `maxPaymentPerRequestUSD`, `maxSessionSpendUSD`, address?) over the existing config storage; `isX402Enabled(platformId)` returning **false unless explicitly enabled** (extension default especially conservative). Port claudy's `config.ts` shape but custody goes through `CredentialStore` (Phase 2), not `config.json`. Module JSDoc header per house convention (`@module core/payments/x402/config`).

### 0.2 Self-contained spend tracker (Track 18 stand-in)

- [ ] `src/core/payments/x402/tracker.ts` — port claudy `tracker.ts` verbatim in behavior: in-memory session ledger, `addX402Payment`, `getX402SessionSpentUSD`, `getX402PaymentCount`, `resetX402SessionPayments`, `formatX402Cost()` (domain-grouped summary). Add a one-line documented fold-in hook (`onPaymentRecorded?`) so a future Track 18 `CostTracker` can absorb it without signature churn.
- [ ] Wire `resetX402SessionPayments()` into the existing session-switch path (find where session state resets; mirror how other session-scoped state is cleared).

### 0.3 Server policy schema (Track 20 stand-in)

- [ ] `src/server/config/server-config.ts` — add `X402ConfigSchema` mirroring `ExecConfigSchema` (`:36-39`): `{ enabled: z.boolean().default(false), allowlist: z.array(z.object({ domain: z.string(), maxPerRequestUSD: z.number() })).default([]), maxPerDayUSD: z.number().default(0), network: z.enum([...]).default('base') }`. Add as `server.x402` inside `ServerConfigSchema` (`:75`, default `{}`). Confirm `redactConfig()` does not leak it (no secrets in this schema by design — the key is in `FileCredentialStore`, not config).

### 0.4 Injection plumbing

- [ ] `src/tools/BaseTool.ts` — extend `ToolContext` (`:166-173`) with `payments?: PaymentCapability` (new interface in `core/payments/x402/types.ts`).
- [ ] `src/tools/ToolRegistry.ts` — populate `context.payments` in the `execute()` context build (`:497-506`) from a registry-held capability (settable like `preExecuteCheck`/`approvalGate`; default `undefined` ⇒ no payment ability). Add `setPaymentCapability()` mirroring `setApprovalGate()` (`:107-109`).

### 0.5 Types

- [ ] `src/core/payments/x402/types.ts` — port claudy `types.ts` (`PaymentRequirement`, `PaymentPayload`, `X402PaymentRecord`, `X402_HEADERS` lowercase, `USDC_ADDRESSES`, defaults) + the new `PaymentCapability` interface (`tryPay(req, ctx) → outcome`).

### 0.6 Do NOT (this phase)

- [ ] No `fetch`, no signing, no tool, no command, no bootstrap wiring of a real capability. Phase 0 is inert plumbing only.

### 0.7 Tests

- [ ] `src/core/payments/x402/__tests__/{config,tracker,types}.test.ts` — gate default-OFF per platform; tracker accumulation/reset/summary; `X402ConfigSchema` parse + defaults; `redactConfig` over a populated `server.x402`.
- [ ] `npm run type-check && npm run lint && npm test` green; `ToolContext` change compiles repo-wide.

---

## Phase 1: detect + limits + ResourceFetchTool (dry-run, NO signing, NO funds)

**Goal:** With the gate ON, the agent can issue an explicit resource fetch,
hit a 402, and see a "would have paid $X (allowed/denied: reason)" decision.
Nothing is signed or spent.
**Estimated size:** ~300 LOC + tests. **Single PR.** Depends on Phase 0.

### 1.1 Detect + limits (claudy ports)

- [ ] `src/core/payments/x402/detect.ts` — port `parsePaymentRequirement`: parse `402` + lowercase `x-payment-required` JSON → `PaymentRequirement`; reject missing fields.
- [ ] `src/core/payments/x402/limits.ts` — port `validatePaymentRequirement`: per-request cap, session cap (`getX402SessionSpentUSD`), network match, USDC-asset match. Returns `{valid, reason}`.

### 1.2 The only payable surface

- [ ] `src/tools/ResourceFetchTool.ts` — new agent-initiated tool doing a real Node `fetch` (pattern proven by the dead `NavigationTool.checkUrlAccessibility:680-693`; `response.status`/`response.headers` are accessible). On `402` + header: `detect` → `limits` → **log the intended payment only (dry-run)**, return the 402 to the agent. Reads its payment ability **only** from `context.payments` (Phase 0.4) — never imports the capability directly.
- [ ] Register it in `ToolRegistry` like other tools (definition + handler + riskAssessor). It is the **only** tool wired to `context.payments`; scraping/extraction/navigation tools are NOT.

### 1.3 Observe-and-surface (navigation 402s, never pay)

- [ ] `src/tools/NetworkInterceptTool.ts` — extend `logResponse` (`:556-570`, already records `statusCode`/`responseHeaders`) to surface a detected `402` + `x-payment-required` as an informational signal (existing log/event surface). **No payment path here** — observation only. Add a code comment stating navigation 402s are never auto-paid (design decision 2).

### 1.4 Do NOT (this phase)

- [ ] No signer, no `CredentialStore` access, no `ApprovalGate`/server policy enforcement yet (capability returns `dry-run` outcomes only). No `/x402` command yet.

### 1.5 Tests

- [ ] `__tests__/detect.test.ts` / `limits.test.ts` — malformed header rejected; each cap/network/asset rejection reason; under-cap passes.
- [ ] `ResourceFetchTool.test.ts` — mocked `fetch`: non-402 passes through; 402 with gate OFF passes through untouched; 402 with gate ON + within caps ⇒ dry-run "would pay" outcome, **no signing call invoked**; 402 over cap ⇒ denied with reason.
- [ ] `NetworkInterceptTool` test — a 402 navigation response emits the surface signal and triggers **no** payment.
- [ ] type-check / lint / test green.

---

## Phase 2: vetted signer + per-platform custody (desktop-first)

**Goal:** Desktop can sign + settle a real x402 payment within caps (testnet
first). Extension never signs. Server still denied until Phase 3 policy.
**Estimated size:** ~350 LOC + tests. **1–2 PRs.** Depends on Phase 1.

### 2.1 Signer (vetted lib only)

- [ ] `src/core/payments/x402/signer.ts` — EIP-3009 `transferWithAuthorization` over EIP-712 using the lib chosen in Pre-impl. `createPayment` + `encodePaymentHeader` (base64). **Do NOT** reimplement claudy's `client.ts` crypto.

### 2.2 Key custody over the real CredentialStore

- [ ] `src/core/payments/x402/PaymentKeyStore.ts` — abstraction over `CredentialStore` (`get/set/delete` by service `'x402'`, account = wallet label). Per-platform binding via `platformId`:
  - desktop ⇒ `KeytarCredentialStore` (OS keychain).
  - server ⇒ `FileCredentialStore` — **treat decrypt-fail/empty (`{}`) and missing `VITE_VAULT_SECRET` as "no key ⇒ deny"**, never "skip checks".
  - extension ⇒ **no signer**; `tryPay` returns `surface-for-approval` / `delegate`, never signs.
- [ ] Wire signed payments into `tracker.addX402Payment` (Phase 0.2).

### 2.3 Capability wiring

- [ ] Construct the real `PaymentCapability` in the desktop bootstrap (`DesktopAgentBootstrap`) and call `toolRegistry.setPaymentCapability(...)` next to where `setApprovalGate` is called (`:258`). Extension `service-worker.ts` wires a **detect/surface-only** capability (no key). Server bootstrap wiring deferred to Phase 3 (policy-gated).

### 2.4 Tests

- [ ] `signer.test.ts` — signature shape valid against the vetted lib's verifier (testnet vectors); never emits a hardcoded `v`.
- [ ] `PaymentKeyStore.test.ts` — desktop get/set/delete via mocked keytar; server `FileCredentialStore` missing key / decrypt-fail ⇒ deny; extension ⇒ no signer path reachable.
- [ ] Desktop manual/integration: testnet (`base-sepolia`) end-to-end one payment within caps; assert tracker + summary updated. Report explicitly if testnet can't be exercised.
- [ ] type-check / lint / test green.

---

## Phase 3: approval per platform — the corrected safety core (TRACK GOAL)

**Goal:** End state met. An agent-initiated resource fetch hitting a 402 pays
& returns the resource when enabled+funded+within caps+platform-permitted;
extension surfaces for human approval; **server default-denies unless explicitly
allowlisted**; navigation 402s observed, never paid.
**Estimated size:** ~300 LOC + tests. **1–2 PRs.** Depends on Phase 2.

### 3.1 ext/desktop — ApprovalGate (where it actually exists)

- [ ] Above the trivial threshold, `PaymentCapability.tryPay` routes through `ApprovalGate.check()` (`ToolRegistry.ts:447`) as a destructive action — gate is constructed on ext/desktop (`service-worker.ts:118`, `DesktopAgentBootstrap.ts:258`). Extension with no key ⇒ surface/delegate only.

### 3.2 server — explicit default-deny (NOT the gate, NOT a timeout)

- [ ] Server `PaymentCapability`: read `server.x402` via `getServerConfig()`. **Default deny.** Proceed only if payee domain ∈ allowlist AND amount ≤ `maxPerRequestUSD` AND running-day total + amount ≤ `maxPerDayUSD`.
- [ ] Register a `preExecuteCheck` guard (`ToolRegistry.ts:407-423`, the only platform-uniform choke present on the server) that denies the resource-fetch tool's pay path unless the server policy resolved it — so a mis-wired path still fails closed (`PRE_EXECUTE_DENIED`).
- [ ] Wire the server capability in `ServerAgentBootstrap` (policy-gated; never `setApprovalGate`). Maintain a per-day spend accumulator (reset at UTC midnight) alongside the session tracker.
- [ ] Audit: every server **deny and allow** emits a log entry via the existing log surface (composes with the unattended loop / `logs.tail`).

### 3.3 `/x402` command (webfront → ext/desktop only)

- [ ] `src/webfront/commands/builtinCommands.ts` (+ callbacks) — register `x402` via `commandRegistry.register` with subcommands `setup|status|enable|disable|set-limit|set-session|network|remove`. The chat command must never accept or persist a private key; `setup` only gives agent-side provisioning guidance. Reserve the name if a skill-name collision guard exists (cf. Track 17's `RESERVED_COMMAND_NAMES`).
- [ ] Document in the command help + design that **server has no `/x402`** — it is config-driven (`server.x402`).

### 3.4 Do NOT

- [ ] No `setApprovalGate` call in `src/server`. No reliance on any approval timeout for safety anywhere.

### 3.5 Tests

- [ ] ext/desktop: above-threshold ⇒ `ApprovalGate.check` invoked; deny ⇒ no signing; approve ⇒ pay + tracker updated. Extension no-key ⇒ surface only.
- [ ] server: no policy ⇒ deny (default); allowlisted domain within caps ⇒ allow; over per-request or per-day cap ⇒ deny; non-allowlisted domain ⇒ deny; `preExecuteCheck` denies a direct mis-wired call. Each deny/allow emits an audit log.
- [ ] Manual UI: `/x402 setup/status/enable` on extension popup + desktop window; confirm key lands in the right `CredentialStore` and never in config. Report if a surface can't be exercised.
- [ ] type-check / lint / test green; full regression (tool dispatch, approval, server config) stays green.

---

## Phase 4: production hardening (ONLY if Phases 0–3 validated — gates real funds)

**Goal:** Mainnet enablement readiness. **No real funds before this phase.**
**Estimated size:** review-bound, not LOC-bound. **Separate PR + sign-offs.**

- [ ] Key-custody security review (extension exfil surface, server `VITE_VAULT_SECRET` provisioning via a real secrets manager, desktop keychain prompts).
- [ ] Regulatory / legal review of autonomous spend (per-platform, jurisdictions).
- [ ] Mainnet enablement behind explicit product sign-off; tighten default caps; document the operator runbook for `server.x402` allowlist provisioning.
- [ ] Threat-model doc: `FileCredentialStore` fail-open-to-empty handled (Phase 2.2), navigation-402 never-pay invariant (Phase 1.3) re-audited, no key material logged anywhere.

---

## Cross-cutting

- [ ] `.ai_design/agent_improvements/README.md` — add/refresh the Track 23 row (effort **L**, prototype-gated) and Dependency Graph: in-track slices for 22/18/20 (note the `_DONE`-unreliable lesson — these are *verified absent*, not assumed); Track 14 used ext/desktop only.
- [x] After each phase merges: tick the section here and update `design.md` Status.
- [x] Rename dir to `23_agentic_payments_x402_DONE` only after **all** phases merge; note in README which phases shipped (suffix-is-unreliable convention).

---

## Deferred (NOT in this track — see design.md)

| Item | Why |
|------|-----|
| Global fetch interceptor | browserx has no chokepoint and web tools can't see HTTP status; the explicit `ResourceFetchTool` is the deliberate design (decision 1). |
| Auto-pay on navigation / CDP | Forbidden by design (decision 2). `NetworkInterceptTool` observes-and-surfaces only. |
| Track 18 `CostTracker` fold-in | When Track 18 lands, route `tracker.ts` records through its API via the documented `onPaymentRecorded` hook (no signature change). |
| Track 20 managed-policy layer | When it lands, migrate `server.x402` reads behind it; keep the Zod schema as the fallback. |
| Track 22 feature-flag gate | When it lands, replace `isX402Enabled` internals with `feature('X402')`; keep the function signature. |
| Extension hot-key signing | Custody too weak (decision/risks). Revisit only if a hardware-backed extension keystore exists. |
| Non-USDC assets / non-`exact` scheme | claudy supports only `scheme:'exact'` + USDC; match that until the protocol stabilises (Phase 4 risk). |
| **`/x402` webfront↔agent cross-context** (PR #238 review MED-5) | The command mutates config in the renderer; the capability reads it agent-side (different JS contexts on the extension). Route `/x402` mutations through the UI→agent service channel — Phase-3 follow-up. Today it fails into a clear message, never silently. |
| **SSRF DNS-rebinding hardening** (PR #238 review HIGH-2) | The literal-host egress guard does not resolve DNS; a hostname resolving to a private IP is not caught. Resolve-then-check / pinned egress — Phase-4 follow-up. |
