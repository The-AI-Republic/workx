# Track 23: Agentic Payments (x402)

**Priority: P2 (strategic / forward-looking)** · **Effort: M** · **Status: READY TO IMPLEMENT** (prototype-gated)

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's x402 service and browserx's HTTP/tool/credential surfaces across all three deploy targets — see "Validation Notes". Speculative + security-sensitive: prototype behind a Track 22 flag; do not rush to production.

## Problem

BrowserX is a web-browsing agent that navigates and could **transact** (paywalled APIs/content, pay-per-call data, agent-to-agent paid services) but has **zero** payment/wallet/402 handling (grep: nothing). HTTP 402 micropayments are a clean, transparent capability and a differentiator.

## What Claudy Does

`services/x402/` (1021 LOC, USDC on Base, `@see coinbase/x402`):

- `paymentFetch.ts` `wrapFetchWithX402(fetch)` / `addX402AxiosInterceptor`: on a `402` with `X-Payment-Required` (`:43-65`), if `isX402Enabled()`, parse `PaymentRequirement`, **validate against per-request + per-session USD limits** (`getX402SessionSpentUSD`), sign an EIP-3009 `transferWithAuthorization` (EIP-712, local secp256k1 key), base64 into `x-payment`, retry. Not 402 / not enabled → pass through.
- Config (`config.ts`): `getX402PrivateKey`/`saveX402PrivateKey`/`removeX402PrivateKey` (600-perm key custody), `setX402MaxPayment`, `setX402MaxSessionSpend`, `setX402Network`, `isX402Enabled` (**disabled by default**). `tracker.ts` per-session spend; folds into `cost-tracker.formatTotalCost()`.
- **Two clean chokepoints**: `services/api/client.ts:367` (`wrapFetchWithX402(inner)`) + the WebFetch axios interceptor.

## BrowserX Mapping

### The real seam — NO central fetch chokepoint (the key divergence)

| Concern | BrowserX location | State |
|---|---|---|
| HTTP-ish tool surfaces | `tools/WebScrapingTool.ts`, `tools/DataExtractionTool.ts`, `tools/WebSearchTool.ts` (+ extension variants) | Agent-initiated resource fetches — the **right** x402 surface |
| Browser navigation | `tools/NavigationTool.ts`, `core/tools/browser/BrowserController.ts`, CDP `DebuggerClient.ts` | A navigated page can return 402 — auto-paying here is **dangerous** |
| Network observation | `tools/NetworkInterceptTool.ts` (CDP) | Where a navigation 402 is *observed*, not auto-paid |
| Central HTTP client | none (no `services/api/client.ts` equivalent) | **Claudy's integration model does not transfer** |
| Key custody (ext) | `extension/storage/ChromeCredentialStore.ts` → `chrome.storage.local` | **Not a secure enclave; worst custody environment** |
| Key custody (server) | `server/storage/FileCredentialStore.ts` (file, restricted perms) | Tolerable with a secrets manager; no human at spend time |
| Key custody (desktop) | Tauri credential store / OS keychain plugin | Least-bad: OS-backed, interactive user |
| Cost surface | Track 18 `CostTracker` | x402 spend folds in (mirrors claudy) |

### Per-Platform Behavior

A capability that *spends money* must behave very differently per platform — driven by **key-custody safety** and **whether a human can approve at spend time**.

- **BrowserX (extension, Chrome MV3).** The **worst** key-custody environment: `ChromeCredentialStore` is `chrome.storage.local` (not an enclave), an extension is a high-value malware/exfil target, and MV3 SW eviction makes a multi-step sign→retry fragile. **Decision: the extension does NOT custody a hot signing key or auto-sign by default.** It *detects* the 402, parses the `PaymentRequirement`, and **surfaces it for explicit human approval** (and may optionally delegate signing to a paired, more-trusted desktop/server host). Never an autonomous payer.
- **Apple Pi (desktop, Tauri).** The **least-bad** custody home: OS keychain via a Tauri plugin, an interactive user who explicitly opts in, and the Track 14 approval surface is live (human present, no timeout pressure). This is the natural home for the wallet/signer for an attended user.
- **Apple Pi Server (headless).** Strategically the most interesting (an agent that autonomously pays for an API mid-scheduled-job) and the most dangerous (no human at spend time; a compromised unattended agent that can pay). **Hard rule (composing Track 14 + 18 + 20): payments fail CLOSED.** Track 14 established the server `ApprovalManager` *times out* with no connected operator (`approval-manager.ts:114,121`); a payment that cannot get real-time approval must **deny on timeout, never settle**. The only way a headless payment proceeds is a **Track 20 managed-policy pre-authorization allowlist** (specific payee domains + amount ceilings) plus Track 18's per-session/per-day USD budget cap; the key is custodied via `FileCredentialStore` backed by a real secrets manager (K8s Secret), never env, never logged. This composes with Track 12's unattended loop (a 402 mid-unattended-run is denied-unless-allowlisted, surfaced via `logs.tail`).

### Key design decisions (and divergences from claudy)

1. **No global fetch interceptor — a capability the resource tools opt into.** Claudy wraps one `fetch` + one axios. BrowserX has many tool-level HTTP surfaces + a live CDP browser; nothing global to wrap. Build `core/payments/x402/` as an explicit capability that `WebScrapingTool`/`DataExtractionTool`/MCP resource fetches call on a 402 — not a transparent global interceptor. The central divergence from claudy.
2. **Explicitly do NOT auto-pay on browser navigation.** A 402 from a navigated page (agent/plan/speculation-driven) is non-idempotent and high-risk. `NavigationTool`/`BrowserController` 402s are **observed** via `NetworkInterceptTool`/CDP and surfaced, never auto-settled. Payment is only for **explicit agent-initiated resource fetches**.
3. **Hard spend limits + approval, default-deny — per platform.** Per-request/per-session USD caps enforced *before* signing (port `setX402MaxPayment`/`setX402MaxSessionSpend`/`tracker`). Above a trivial threshold: route through Track 14 `ApprovalGate` as a destructive action on ext/desktop; **fail closed on server unless Track 20 policy-allowlisted** (the server-timeout consequence from Track 14 makes this mandatory, not optional).
4. **Vetted crypto library — do NOT port claudy's hand-rolled EIP-712.** Key custody is the dominant risk; hardened signing lib + platform-appropriate secure storage (OS keychain on desktop, secrets manager on server, **no hot key on the extension**). Explicit instruction.
5. **Disabled by default, behind a Track 22 feature flag** (default OFF all platforms; the extension flag default is *especially* conservative — Track 22 notes the extension has no runtime override), opt-in `/x402` setup (Track 03, ext/desktop only — server uses managed policy).
6. **Spend folds into Track 18 cost** exactly as claudy appends its x402 section in `formatTotalCost()`; on server it also flows into the per-job cost record + budget cap.

## Implementation Plan (file-level, ordered)

**Phase 1 (prototype, flag-gated, no funds).**
- `core/payments/x402/detect.ts`: 402 + `X-Payment-Required` parse → `PaymentRequirement`; `core/payments/x402/limits.ts`: per-request/session caps. Called by `WebScrapingTool`/`DataExtractionTool`. **Dry-run/log only, no signing.** Behind `feature('X402')` (Track 22), default OFF everywhere.

**Phase 2 — signer + tracking (desktop-first).**
- `core/payments/x402/signer.ts` using a **vetted** EIP-3009/EIP-712 lib; key custody via a `PaymentKeyStore` abstraction with per-platform impls: desktop = Tauri OS-keychain; server = `FileCredentialStore`/secrets-manager; **extension = no signer (detect+surface only / delegate)**. Per-session spend tracker → Track 18 `CostTracker`.

**Phase 3 — approval integration, per platform.**
- ext/desktop: payment above threshold → Track 14 `ApprovalGate` (human present).
- server: **fail-closed gate** — proceed only if Track 20 policy allowlists payee+amount AND within Track 18 budget cap; otherwise deny + `emitLog` audit. `NetworkInterceptTool` observes navigation 402s and surfaces (never pays). `/x402` setup command (ext/desktop).

**Phase 4 (only if validated).**
- Production hardening; key-custody + regulatory/legal review before any real funds.

## Dependencies

- **Track 22** (Feature Flags): ships dark, opt-in — hard prerequisite (extension default especially conservative).
- **Track 14** (Plan/Approval): payment = destructive action; the server approval-timeout finding makes server fail-closed mandatory.
- **Track 18** (USD Cost): spend folds into the total + the server per-job budget cap.
- **Track 20** (Managed Settings): the server payee/amount pre-authorization allowlist.
- **Track 03** (Commands): `/x402` setup (ext/desktop).
- `WebScrapingTool`/`DataExtractionTool`/`NetworkInterceptTool` + the per-platform credential stores.

## Risks

- **Crypto-key custody is the dominant risk** — vetted lib only, platform-appropriate secure storage, never logged; **no hot key in the extension**. Non-negotiable.
- Auto-pay on navigation would be catastrophic — forbidden by design; the capability must be unreachable from `NavigationTool`/`BrowserController`.
- **Headless over-spend:** without the server fail-closed + Track 20 allowlist + Track 18 cap, an unattended/compromised agent could drain funds — the deny-on-approval-timeout rule is mandatory.
- Pre-production protocol — isolate behind the capability boundary + flag; expect x402 to change.
- Regulatory/financial surface — Phase 4 gated on explicit product + legal review; no real funds before then.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `services/x402/paymentFetch.ts:33-65`; `services/x402/index.ts:12-43`; `services/api/client.ts:367-370`; `tracker.ts`.
- browserx core: `tools/{WebScrapingTool,DataExtractionTool,WebSearchTool,NavigationTool,NetworkInterceptTool}.ts`, `core/tools/browser/{BrowserController,DebuggerClient}.ts`; no central fetch/axios client, no payment/wallet/402 anywhere (grep).
- browserx platforms: `extension/storage/ChromeCredentialStore.ts` (`chrome.storage.local` — worst custody, no enclave); `server/storage/FileCredentialStore.ts` (file, no human at spend time); desktop Tauri OS-keychain (least-bad); Track 14 `src/server/exec/approval-manager.ts:114,121` (server approval timeout → payments must fail closed); Track 22 extension "no runtime override" constraint.

Corrections vs the first-pass draft:
1. **Reversed the integration model:** opt-in capability the resource tools call, **not** a global fetch interceptor (browserx has no chokepoint).
2. Hard prohibition: **never auto-pay on browser navigation** — only explicit resource fetches; `NetworkInterceptTool`/CDP observes-and-surfaces.
3. No browserx payment surface anywhere (grep) — greenfield, behind the capability boundary.
4. **Multi-platform (2026-05-15):** key-custody risk gradient — extension (worst: `chrome.storage.local`, malware target, MV3 fragility → detect+surface only, no hot key), desktop (least-bad: OS keychain + interactive approval), server (autonomous spender → **fail-closed**: deny on the Track-14 approval-timeout, proceed only via Track-20 allowlist + Track-18 cap, key in a secrets manager). The headless fail-closed rule is a direct composition of the Track 14 server-approval-timeout finding and is mandatory, not advisory.
