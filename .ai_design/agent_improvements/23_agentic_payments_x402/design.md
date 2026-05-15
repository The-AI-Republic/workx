# Track 23: Agentic Payments (x402)

**Priority: P2 (strategic / forward-looking)** · **Effort: M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's x402 service and browserx's HTTP/tool surfaces — see "Validation Notes". Speculative + security-sensitive: prototype behind a Track 22 flag; do not rush to production.

## Problem

BrowserX is a web-browsing agent that navigates and could **transact** (paywalled APIs/content, pay-per-call data, agent-to-agent paid services) but has **zero** payment/wallet/402 handling (grep: nothing). HTTP 402 micropayments are a clean, transparent capability and a differentiator.

## What Claudy Does

`services/x402/` (1021 LOC, USDC on Base, `@see coinbase/x402`):

- `paymentFetch.ts` `wrapFetchWithX402(fetch)` / `addX402AxiosInterceptor`: on a `402` with the `X-Payment-Required` header (`:43-65`), if `isX402Enabled()`, parse `PaymentRequirement`, **validate against per-request + per-session USD limits** (`getX402SessionSpentUSD`), sign an EIP-3009 `transferWithAuthorization` (EIP-712, local secp256k1 key), base64 into the `x-payment` header, retry. If not 402 or not enabled → pass through untouched.
- Config (`config.ts`): `getX402PrivateKey`/`saveX402PrivateKey`/`removeX402PrivateKey` (600-perm key custody), `setX402MaxPayment`, `setX402MaxSessionSpend`, `setX402Network`, `isX402Enabled` (**disabled by default**). `tracker.ts` per-session spend; folds into `cost-tracker.formatTotalCost()`.
- **Two clean chokepoints**: wired at `services/api/client.ts:367` (`wrapFetchWithX402(inner)`) and the WebFetch axios interceptor.

## BrowserX Mapping

### The real seam — NO central fetch chokepoint (the key divergence)

| Concern | BrowserX location | State |
|---|---|---|
| HTTP-ish tool surfaces | `tools/WebScrapingTool.ts`, `tools/DataExtractionTool.ts`, `tools/WebSearchTool.ts` (+ extension variants) | Agent-initiated resource fetches — the **right** x402 surface |
| Browser navigation | `tools/NavigationTool.ts`, `core/tools/browser/BrowserController.ts`, CDP `core/tools/browser/DebuggerClient.ts` | A navigated page can return 402 — but auto-paying here is **dangerous** |
| Network observation | `tools/NetworkInterceptTool.ts` (CDP network) | Where a 402 on navigation is *observed*, not where it should be auto-paid |
| Central HTTP client | none (no `services/api/client.ts` equivalent, no global `fetch`/axios wrap) | **Claudy's integration model does not transfer** |
| Payment/wallet | none | Greenfield |
| Cost surface | Track 18 `CostTracker` | x402 spend folds in (mirrors claudy) |

### Key design decisions (and divergences from claudy)

1. **No global fetch interceptor — a capability the resource tools opt into.** Claudy wraps one `fetch` + one axios (two chokepoints). BrowserX has many tool-level HTTP surfaces and a live CDP browser; there is nothing global to wrap. Build `core/payments/x402/` as an explicit capability that **`WebScrapingTool` / `DataExtractionTool` / MCP resource fetches** call when they hit a 402 — not a transparent global interceptor. This is the central divergence from claudy.

2. **Explicitly do NOT auto-pay on browser navigation.** A 402 from a page the agent (or a plan/speculation) navigated to is non-idempotent and high-risk — the same hazard Track 24 flags for speculative browser actions. `NavigationTool`/`BrowserController` 402s are **observed** (via `NetworkInterceptTool`/CDP) and surfaced, never auto-settled. Payment is only for **explicit agent-initiated resource fetches**.

3. **Hard spend limits + approval, default-deny.** Per-request and per-session USD caps enforced *before* signing (port claudy's `setX402MaxPayment`/`setX402MaxSessionSpend`/`tracker`). Any payment above a trivial threshold routes through the **Track 14 / approval pipeline** as a destructive action (browserx already treats destructive tools that way — reuse `ApprovalGate`, don't invent).

4. **Vetted crypto library — do NOT port claudy's hand-rolled EIP-712.** Key custody is the dominant risk; use a hardened signing lib + secure storage (never log, env/secure-store custody). This is an explicit instruction, not a preference.

5. **Disabled by default, behind a Track 22 feature flag**, opt-in `/x402` setup (Track 03). Ships dark; not in the default extension bundle.

6. **Spend folds into Track 18 cost** exactly as claudy appends its x402 section in `formatTotalCost()` — one cost total including payments.

### Phase plan

- **Phase 1 (prototype, flag-gated, no funds):** 402 detection + `PaymentRequirement` parse + spend-limit gate in `core/payments/x402/`, called by `WebScrapingTool`/`DataExtractionTool`; **dry-run/log only, no signing**.
- **Phase 2:** wallet signer via a vetted lib + per-session spend tracking → fold into Track 18 `CostTracker`.
- **Phase 3:** approval-pipeline integration for payments above threshold (Track 14); `/x402` setup command; `NetworkInterceptTool` *observes* navigation 402s and surfaces (never auto-pays).
- **Phase 4 (only if validated):** production hardening, key-custody + regulatory/legal review before any real funds.

## Dependencies

- **Track 22** (Feature Flags): ships dark, opt-in — hard prerequisite
- **Track 14** (Plan/Approval): payment = destructive action through `ApprovalGate`
- **Track 18** (USD Cost): spend folds into the total (mirrors claudy `formatTotalCost`)
- **Track 03** (Commands): `/x402` setup
- `WebScrapingTool`/`DataExtractionTool`/`NetworkInterceptTool` (existing) — the integration surfaces

## Risks

- **Crypto-key custody is the dominant risk** — vetted lib only, secure storage, never logged. Non-negotiable.
- Auto-pay on navigation would be catastrophic (non-idempotent, agent/plan-driven) — the design forbids it; enforce that the capability is unreachable from `NavigationTool`/`BrowserController`.
- Pre-production protocol — isolate behind the capability boundary + flag; expect x402 to change.
- Regulatory/financial surface — Phase 4 gated on explicit product + legal review; no real funds before then.
- A compromised agent that can pay is high-impact — hard caps + approval + default-deny are mandatory.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `services/x402/paymentFetch.ts:33-65` (`wrapFetchWithX402`, 402 + `X-Payment-Required` gate, pass-through when disabled), `services/x402/index.ts:12-43` (config/key/limits/`isX402Enabled`/tracker API), `services/api/client.ts:367-370` (`wrapFetchWithX402(inner)` chokepoint), `tracker.ts` (per-session spend → `cost-tracker.formatTotalCost`).
- browserx: `tools/{WebScrapingTool,DataExtractionTool,WebSearchTool,NavigationTool,NetworkInterceptTool}.ts`, `core/tools/browser/{BrowserController,DebuggerClient}.ts` (multiple tool/CDP HTTP surfaces; **no** central fetch/axios client — grep confirms no `services/api/client.ts` equivalent); no payment/wallet/402 anywhere (grep empty).

Corrections vs the first-pass draft:
1. **Reversed the integration model:** the draft proposed a "fetch-layer interceptor, transparent" mirroring claudy. browserx has **no global fetch chokepoint** — it's a browser agent with many tool-level HTTP surfaces. The design is now an opt-in capability the resource tools call, explicitly **not** a global interceptor.
2. Added a hard prohibition: **never auto-pay on browser navigation** (`NavigationTool`/`BrowserController`) — non-idempotent, agent/plan-driven; only explicit resource fetches. The draft didn't distinguish navigation from resource fetch.
3. `NetworkInterceptTool`/CDP is the place navigation 402s are *observed and surfaced*, not paid — a browserx-specific structural point with no claudy analog.
