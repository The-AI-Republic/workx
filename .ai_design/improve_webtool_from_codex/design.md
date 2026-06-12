# Improving workx Web-Operation Tools — Lessons from the OpenAI Codex Chrome Extension

**Status:** Proposed
**Date:** 2026-06-12
**Sources analyzed:**
- OpenAI Codex Chrome extension v1.1.5 (store build, deobfuscated). Line references in this doc point to the prettified bundles (`background.pretty.js` ~7,100 lines, `codex-content.pretty.js` ~1,350 lines) produced with `js-beautify` from `/Users/irichard/Downloads/1.1.5_0/`.
- workx extension source at HEAD (`37a092dd`).

---

## 1. Executive summary

Codex's extension and ours solve the same problem — letting an LLM agent operate Chrome tabs — with **opposite architectures**:

| | **Codex** | **workx** |
|---|---|---|
| Intelligence location | Local CLI process; extension is a thin bridge | Inside the extension (tools, DOM serializer, agent loop) |
| Transport | Native messaging (`com.openai.codexextension`), JSON-RPC 2.0 | In-process tool calls |
| Page operation | Raw CDP passthrough — CLI sends arbitrary `{method, params, target}` via `chrome.debugger.sendCommand` (bg:6571) | Structured tools (`browser_dom`, `page_vision`, `browser_navigate`, …) that compose CDP calls in-extension |
| Page reading | None in extension (CLI drives `DOMSnapshot`/`Page.captureScreenshot` itself over the passthrough) | `DomService` builds VirtualDOM from `DOM.getDocument` + `Accessibility.getFullAXTree` + `DOMSnapshot.captureSnapshot`, serialized for the LLM |
| Events | All `chrome.debugger.onEvent` CDP events + download state changes pushed to the CLI (bg:6984) | Pull-only; no event push into agent loop |

We should **not** copy the thin-bridge architecture — being self-contained is a workx product feature. But Codex's extension is production-hardened in exactly the layer where we are weakest: **debugger lifecycle, input dispatch correctness, viewport determinism, tab ownership/cleanup, and overlay robustness**. This doc enumerates 10 concrete improvements, each with their implementation details and a ready-to-implement plan for ours.

Priority summary (details in §4):

- **P0 (correctness bugs):** central debugger session registry (§3.1), CDP command timeouts (§3.2), keyboard dispatch key-definition table (§3.4), click option plumbing + `mouseMoved` precursor (§3.4), coordinate-space normalization (§3.3/§3.4).
- **P1 (capability gaps):** viewport emulation override + agent viewport tool (§3.3), tab lease/turn lifecycle with finalize semantics (§3.6), event-driven page-readiness (§3.8), download tracking (§3.9).
- **P2 (polish):** overlay self-healing + ping-or-inject (§3.5), OOPIF target attachment (§3.7), favicon badging / tab-group session UX (§3.6), deferred-update reload (§3.10).

---

## 2. How Codex's extension works (reference)

A condensed map, so the per-finding sections below have context.

### 2.1 Transport and command surface

- Connects with `chrome.runtime.connectNative("com.openai.codexextension")` (bg:6638; `.dev`/`.internal` channel variants bg:6964–6966). JSON-RPC 2.0 with request/response correlation; pending requests are rejected when the port closes (`rejectPendingRequests`, bg:4016).
- Reconnect: 5s timeout constant `kt = 5e3` (bg:6616), plus a redundant `chrome.alarms` ("native-transport-reconnect", bg:6615) so reconnection survives service-worker suspension.
- Handler registry (bg:5859–5990): `attach`, `attachTarget`, `detach`, `detachTarget`, `getTabs`, `getUserTabs`, `getUserHistory`, `claimUserTab`, `createTab`, `finalizeTabs`, `nameSession`, `moveMouse`, `executeCdp`, `turnEnded`, `getInfo`, plus viewport set/reset tools (bg:3935–3990). Every command carries `session_id` + `turn_id`.
- Unknown commands throw a typed error via `executeUnhandledCommand` (bg:5895) — explicit capability negotiation also exists (`getInfo` returns `capabilities` + `extensionInstanceId` UUID, bg:5947–5961).

### 2.2 Debugger lifecycle (the part worth stealing)

Global module state (not per-service):

- `se: Set<tabId>` — attached tabs; `Ze: Set<targetId>` + `Fe: Map<targetId, tabId>` — attached child targets (OOPIFs/workers).
- **Per-resource async locks** `xt(tabId, fn)` / `Ea(targetId, fn)` serialize attach/detach per tab/target so concurrent commands can't race `chrome.debugger.attach`.
- Attach (`cn`, bg:6239–6252): idempotent — checks `se`, attaches with protocol `"1.3"`, **tolerates "already attached" errors** (`Ma(e)` filter), then immediately applies viewport emulation (`un`, see §2.3), then records in `se`.
- Detach paths: graceful (`ka`/`Ca`, bg:6290–6310) always clear the registry in `finally`; force-detach (`hn`, bg:6311–6320) clears registry *first* then ignores detach errors — used when a CDP command times out and the session may be wedged.
- Session-end cleanup `detachAttachedDebuggersBestEffort` (bg:6195–6198) detaches both tab attachments and any child-target attachments whose `Fe` entry maps to the session's tabs, with `Promise.allSettled`.
- `chrome.debugger.onDetach` listener (bg:5835) reconciles registries when the user cancels the debugger infobar or the tab dies.

### 2.3 CDP passthrough with timeouts

- `La(t)` (bg:6571–6577): special-cases `Target.getTargets` (returns `chrome.debugger.getTargets()`), otherwise `chrome.debugger.sendCommand(target, method, commandParams)` where target is `{targetId}` or `{tabId}`.
- `En(t)` (bg:6579–6592): wraps every command in `Promise.race` with a timer. Default timeout `an = 1e4` (10s, bg:5830); callers can pass `timeoutMs`. Timeout throws typed `CdpCommandTimeoutError` (bg:6597).
- `executeCdp` (bg:6052–6060): refuses if tab not in session or not attached ("Debugger unattached"), and **on timeout force-detaches the tab** (`$n(a) && await hn(e)`) so the next attach starts clean.

### 2.4 Viewport determinism

On every tab attach, `un(tabId)` (bg:6253–6266) runs:

```js
Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false })
```

with a default of **1280x720** (the viewport tool description, bg:3967, says: "otherwise leave it unset so the browser uses its normal 1280x720 viewport"). `deviceScaleFactor: 1` means **screenshot pixels == CSS pixels == input coordinates** — no DPR math anywhere downstream. A dedicated agent tool pair `browser_viewport_set` / `browser_viewport_reset` (bg:3935–3990) handles responsive/breakpoint testing, with explicit instructions to reset overrides before finishing.

### 2.5 Tab leases, turns, and finalize semantics

- `TabLeases` (`Be`, persistent via storage) records per-tab: owning `sessionId`, `turnId`, `origin: "agent" | "user"`. `claimUserTab` rejects `chrome://` tabs (bg:6097–6099) and tabs owned by another session (bg:6101).
- All session mutations run through `lifecycleQueue` — a per-session promise chain (`runLifecycle`/`runTurnMutation`, bg:6230–6237) so turn transitions, claims, and finalizes can't interleave.
- `finalizeTabs(turnId, keep[])` (bg:6115–6160) implements end-of-turn semantics with a `keep` map of `tabId -> "handoff" | "deliverable"`:
  1. badge favicons of deliverable/handoff tabs (`tabFavicons.markFinalized`),
  2. best-effort detach all debuggers,
  3. release deliverable tabs from the managed tab group (they stay open for the user),
  4. **close agent-origin tabs** not kept (`Pn(d)` → `chrome.tabs.remove`),
  5. untrack overlays, release leases,
  6. convert "handoff" tabs into handoff leases storing `activeTabId` + `groupId` so the **next turn can resume them** (`resumeHandoffIfPresent`, bg:6166–6193, which also garbage-collects leases whose tab no longer exists).
- Session tabs live in a named Chrome **tab group** (`ensureAgentTabGroup`; `nameSession` retitles the group, bg:6161–6164). Favicons are badged with an SVG data-URI marker (`data-codex-favicon-badge`, bg:4180–4195) with states `active | deliverable | handoff`.
- Logical "active tab" is tracked per session and reconciled against real tab state (`resolveLogicalActiveTabId`, bg:6213–6215).

### 2.6 Cursor overlay (content script)

- **Injection:** ping-or-inject. `bt(tabId)` sends `{type:"CONTENT_PING"}` (bg:4148–4155); on no reply, `kr` injects `content-scripts/codex.js` via `chrome.scripting.executeScript({files, injectImmediately: true})` (bg:4166–4178) then re-pings. In-flight injections are deduped through a `Map<tabId, Promise>` (bg:4140–4146). Manifest `content_scripts` is empty; registration metadata says `runAt: "document_start"`, `matchAboutBlank: true` (content:1199–1204).
- **Mounting:** a `<div id=...>` on `documentElement` with a **closed shadow root**; stylesheet is `.codex-agent-overlay{all:initial;z-index:2147483646;pointer-events:none;position:fixed;inset:0}@media print{...display:none}` (content:1109).
- **Self-healing:** a `MutationObserver` on `documentElement` (+ parent) `childList` re-mounts the overlay if the page removes it, and detects impostor nodes by a `dataset` marker (content:1152–1190).
- **Animation:** spring physics per axis (`dampingFraction` presets .82–.94, `response`-based stiffness, content:594–618, 960–980) plus a bezier "motion mode" that picks among 20 candidate curved paths (content:734–743), tilts the cursor (−44°) while moving, and applies a blue glow (`drop-shadow(0 0 6px rgba(51,156,255,.9))…`, content:1026).
- **Arrival handshake:** `moveMouse` (bg:5897–5930) assigns a monotonically increasing `moveSequence`, the content script reports `AGENT_CURSOR_ARRIVED {sessionId, turnId, moveSequence}` via `chrome.runtime.sendMessage` (bg:7008–7022), and the background resolves a keyed waiter — so the CLI can synchronize "cursor visually arrived" before dispatching the real click. Skipped when the tab isn't observed or `waitForArrival === false`.

### 2.7 Eventing & downloads

- Every `chrome.debugger.onEvent` is forwarded to the CLI as `sendCdpEvent({source, method, params})` (bg:6984–6989) — the CLI gets `Page.lifecycleEvent`, `Network.*`, dialogs, etc. for free.
- `chrome.downloads.onCreated/onChanged` are tracked into a small state machine and pushed as `{id, filename, url, status: started|completed|...}` change events (bg:5963–5990, 6990–6996) — only while browser control is active.
- Extension update handling: when an update is pending, reload is **deferred until browser control is inactive** (`maybeReloadForPendingUpdate`, bg:6972) so an in-flight agent turn isn't killed by an extension restart.

---

## 3. Findings: what Codex does better, and what to change in workx

### 3.1 [P0] Centralize debugger attachment — one registry, per-tab locks, refcounts

**Their implementation:** §2.2 — module-global attach sets, per-tab/per-target async mutexes, idempotent attach tolerant of "already attached", `finally`-guaranteed registry cleanup, one global `onDetach` reconciler.

**Our current state:** three uncoordinated attach paths:

- `DomService.forTab()` creates a per-tab `ChromeDebuggerClient` and attaches (`src/extension/tools/dom/DomService.ts:74-93`), cached in `DomService.instances`.
- `ScreenshotService.forTab()` probes attachment by **executing `Runtime.evaluate('1+1')`** and attaches if it throws (`src/extension/tools/screenshot/ScreenshotService.ts:124-154`). It never detaches.
- `CoordinateActionService.forTab()` duplicates the same probe/attach (`src/extension/tools/screenshot/CoordinateActionService.ts:215-253`). Also never detaches.

Problems: (a) the `1+1` probe is a race — between probe and attach another service can attach, and "Another debugger is already attached" is then swallowed with a comment saying "this is OK", leaving ambiguous ownership; (b) nobody refcounts, so `DomService.detach()` can yank the connection out from under an in-flight screenshot; (c) each `ChromeDebuggerClient.attach` adds its own `chrome.debugger.onEvent` listener (`src/extension/tools/browser/ChromeDebuggerClient.ts:83`) — N listeners filtering for their tab; (d) no per-tab serialization, so concurrent `forTab` calls can double-attach and one rejects.

**Proposed change:** new `src/extension/tools/browser/DebuggerSessionRegistry.ts`:

```ts
class DebuggerSessionRegistry {
  private attachedTabs = new Map<number, { refs: number; enabledDomains: Set<string> }>();
  private locks = new Map<number, Promise<unknown>>();      // per-tab mutex, Codex xt()
  private eventSubs = new Map<number, Set<CDPEventCallback>>();

  async withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T>;
  async acquire(tabId: number): Promise<DebuggerHandle>;    // attach if needed, refs++
  // DebuggerHandle: { sendCommand, onEvent, release() }    // release(): refs--, detach at 0
}
```

- Single `chrome.debugger.onEvent` + `onDetach` listener pair registered once; dispatch by `source.tabId`.
- Attach is idempotent and tolerates "already attached" only when *we* hold the registry entry; otherwise surface the DevTools-conflict error (keep the existing `ALREADY_ATTACHED: DevTools is open` UX from `DomService.forTab`).
- `onDetach` clears registry state and notifies subscribers (replaces `DomService.handleDebuggerDetach`, `DomService.ts:742-755`).
- Port `DomService`, `ScreenshotService`, `CoordinateActionService`, and `ExtensionBrowserController` onto `acquire()/release()`; delete both `1+1` probes.
- Domain enabling moves into the registry (`enabledDomains` per tab) so `Page.enable`/`DOM.enable` aren't re-sent per service.

### 3.2 [P0] Per-command CDP timeouts with force-detach recovery

**Their implementation:** §2.3 — every command raced against 10s default, typed `CdpCommandTimeoutError`, force-detach on timeout so the next command re-attaches cleanly.

**Our current state:** `ChromeDebuggerClient.sendCommand` (`ChromeDebuggerClient.ts:121-140`) has **no timeout**. Only the whole snapshot has one (`config.snapshotTimeout`, `DomService.ts:378-380`). A single wedged command — `Page.captureScreenshot` on a crashed renderer, `Runtime.evaluate` on a hung page, `DOM.getBoxModel` during navigation — hangs the tool call (and the agent turn) indefinitely. `DomService.sendCommandWithRetry` exists (`DomService.ts:719`) but retries can't fire if the first call never resolves.

**Proposed change:**

- In `ChromeDebuggerClient.sendCommand`, wrap in `Promise.race` with `timeoutMs` (new optional param; default 10_000; export `CdpCommandTimeoutError`). Mirror Codex's `Mn()` validation: only positive finite numbers override the default.
- Per-call overrides where warranted: `Accessibility.getFullAXTree` and `DOMSnapshot.captureSnapshot` get `snapshotTimeout`-derived budgets; `Input.*` keeps a short 5s.
- On timeout, the `DebuggerSessionRegistry` (§3.1) marks the tab wedged and force-detaches (Codex `hn`): clear registry first, `chrome.debugger.detach` wrapped in try/ignore. Next `acquire()` re-attaches.

### 3.3 [P1] Viewport emulation: `deviceScaleFactor: 1` + agent-facing viewport tool

**Their implementation:** §2.4 — `Emulation.setDeviceMetricsOverride({..., deviceScaleFactor: 1, mobile: false})` applied at attach; 1280x720 default; dedicated `browser_viewport_set/reset` tools for breakpoint testing.

**Our current state:** we fight DPR everywhere instead of normalizing it:

- `DomService.buildSnapshot` reads `window.devicePixelRatio` via `Runtime.evaluate` and divides every DOMSnapshot rect (`DomService.ts:445-461`, `buildLayoutMap` at :765).
- `Page.captureScreenshot` output is in device pixels (`ScreenshotService.ts:37-41`), so on a 2x display the vision model sees a 2x image while `CoordinateActionService.clickAt` dispatches in CSS pixels — a model that reads coordinates off the screenshot will click at 2x the intended position unless something downstream halves them. There is a `ViewportDetector` (`src/extension/tools/screenshot/ViewportDetector.ts`) but no normalization at capture time.
- No way for the agent to test responsive layouts.

**Proposed change:**

- New `ViewportOverrideService` invoked from registry attach (opt-in per tool, default on for `page_vision` flows): `Emulation.setDeviceMetricsOverride({ width: <current CSS viewport w>, height: <h>, deviceScaleFactor: 1, mobile: false })`. Restore with `Emulation.clearDeviceMetricsOverride` on release/turn end. Note: unlike Codex we should default width/height to the tab's real CSS viewport (not 1280x720) to avoid visibly resizing the user's page — Codex can afford a fixed size because its tabs live in a dedicated agent group.
- With DPR forced to 1, delete the `devicePixelRatio` division path in `buildLayoutMap` (keep it as fallback when override fails, e.g. `chrome://` or PDF viewers).
- Add a `browser_viewport` tool (`set {width}x{height}` / `reset`), copying Codex's prompt language about resetting overrides before finishing (bg:3967).

### 3.4 [P0] Input dispatch correctness (keyboard table, click options, mouseMoved, coordinate space)

**Their implementation:** input synthesis lives CLI-side, but the extension contributes: visual `moveMouse` with arrival handshake *before* the CLI dispatches `Input.*` (§2.6), and DPR-free coordinates (§2.4). The CLI follows the standard CDP automation recipe (same as Playwright/Puppeteer): `mouseMoved` → `mousePressed` → `mouseReleased` with full key definitions.

**Our current state — four concrete defects:**

1. **Wrong `code` for non-letter keys.** Both `DomService.keypress` (`DomService.ts:2680-2691`) and `CoordinateActionService.keypressAt` (`CoordinateActionService.ts:154-167`) compute `code: \`Key${key.toUpperCase()}\`` — producing `KeyENTER`, `KeyTAB`, `KeyARROWDOWN`. Correct values are `Enter`, `Tab`, `ArrowDown`, `KeyA`, `Digit1`, etc. We also never send `windowsVirtualKeyCode`/`nativeVirtualKeyCode`, which many sites (and all `keyCode`-based handlers) need, nor `text` for printable keys, so `keypress` frequently does nothing on real pages.
2. **Click options silently dropped.** `DOMTool` advertises `options: { button: "left"|"right"|"middle", scrollIntoView }` (`DOMTool.ts:190`), but `executeClick` ignores `options` (`DOMTool.ts:366-375`) and `DomService.click(nodeId)` hardcodes `button: 'left', clickCount: 1` (`DomService.ts:1128-1141`). Right-click/double-click don't exist despite being documented to the model.
3. **No `mouseMoved` precursor.** We dispatch `mousePressed` directly (`DomService.ts:1128`). Hover-revealed controls (menus, tooltips, row actions) never see `mouseenter`, and some frameworks gate `click` on a prior `mousemove`. Sequence should be `mouseMoved` → `mousePressed` → `mouseReleased`, optionally with the visual cursor animation synchronized (§3.5).
4. **Coordinate-space ambiguity.** `DomService.click` derives coordinates from `DOM.getBoxModel` content quads and then compares them against `scrollX/scrollY + innerWidth/Height` as if they were *document* coordinates (`DomService.ts:1084-1117`), while `Input.dispatchMouseEvent` expects **viewport CSS coordinates**. `DOM.getBoxModel` returns main-frame viewport-relative quads, so the in-viewport check is wrong on scrolled pages (it compares viewport coords against document bounds — usually accidentally true near the top, wrong after scrolling). Prefer `DOM.getContentQuads` (handles inline/transformed/SVG elements — also fixes the `SVG_CLICK_NOT_SUPPORTED` carve-out at `DomService.ts:1063-1069`) and validate visibility by intersecting quads with `{0,0,innerWidth,innerHeight}`.

**Proposed change:** new shared module `src/extension/tools/input/InputDispatcher.ts`:

- `keyDefinitions.ts`: US-layout table mapping `key` → `{ code, keyCode, key, text?, location? }` (port Puppeteer's `USKeyboardLayout` shape; ~250 entries, MIT-licensed reference). `dispatchKey(handle, key, modifiers)` emits `keyDown` (with `windowsVirtualKeyCode`, `code`, `text` when printable) + `keyUp`. `rawKeyDown` for modifier-only presses.
- `click(handle, {x, y, button = 'left', clickCount = 1, modifiers})`: `mouseMoved` → `mousePressed` → `mouseReleased`, with `buttons` bitmask set during press.
- `insertText` fast-path retained for bulk typing (current `typePaste`/`Input.insertText` logic in `DomService.ts:1682` stays).
- `DomService.click/keypress`, `CoordinateActionService.*`, and `FormAutomationTool` all route through it; `DOMTool.executeClick` forwards `options`.
- Element targeting switches `DOM.getBoxModel` → `DOM.getContentQuads` with quad-area selection (largest visible quad), viewport intersection check, and `DOM.scrollIntoViewIfNeeded` fallback (existing call at `DomService.ts:1106` kept).

### 3.5 [P2] Overlay robustness: ping-or-inject, self-healing, arrival sync

**Their implementation:** §2.6.

**Our current state:**

- Visual effects are triggered by `Runtime.evaluate` dispatching a `workx:show-visual-effect` CustomEvent (`DomService.ts:971-1008`), which **silently no-ops if the content script never loaded** (CSP-blocked at document_start, pre-existing tabs from before install, `file://` etc.). `ensureVisualEffectsInitialized` is a stub whose entire body is commented out (`DomService.ts:913-956`) — dead code.
- The Svelte overlay mounts a closed shadow root at z-index 2147483647 (`src/extension/content/content-script.ts:111-122`) — good — but there is **no MutationObserver re-mount**: any page that prunes unknown DOM nodes (several SPAs do on hydration) permanently removes our overlay.
- Effects are fire-and-forget; the ripple may render after the click already navigated.

**Proposed change:**

- Add `ensureContentScript(tabId)` to the extension platform layer implementing Codex's ping-or-inject: `chrome.tabs.sendMessage(tabId, {type:'WORKX_PING'})` with a short race-timeout (Codex `Oe`, bg:4156-4165) → on failure `chrome.scripting.executeScript({files:[contentScript], injectImmediately:true, target:{tabId}})` → re-ping; dedupe concurrent injections with a `Map<tabId, Promise<boolean>>`. Call it from `DomService.triggerVisualEffect` and delete the dead `ensureVisualEffectsInitialized`.
- In `content-script.ts`, watch `documentElement` with `MutationObserver({childList:true})` and re-mount the shadow host if disconnected; tag the host with a `dataset` marker to detect/replace impostor nodes (Codex content:1152-1190).
- Optional (pairs with §3.4): animate cursor to target and await an arrival ack (sequence-numbered `chrome.runtime.sendMessage`, Codex's `AGENT_CURSOR_ARRIVED` protocol, bg:7008-7022) before dispatching `mousePressed`, capped by a ~1.5s timeout so a broken overlay never blocks the action.

### 3.6 [P1] Tab ownership: leases, turn finalization, and user-visible state

**Their implementation:** §2.5 — persistent leases with `agent|user` origin, per-session mutation queue, `finalizeTabs(keep)` with `deliverable`/`handoff` semantics, handoff resume with stale-lease GC, named tab groups, favicon badging.

**Our current state:** `TabManager` (`src/core/TabManager.ts:28-67`) maintains one global "workx" tab group and closure callbacks; there is no ownership record distinguishing agent-created tabs from user tabs the agent borrowed, no turn-end contract (tools just leave tabs open and debuggers attached — `ScreenshotService`/`CoordinateActionService` never detach), and no persistence, so a service-worker restart forgets which tabs were ours.

**Proposed change (incremental, not a full port):**

1. `TabLeaseStore` (chrome.storage.session): `{ tabId, sessionId, turnId, origin: 'agent'|'user', claimedAt }`. Claim on first tool use against a tab; reject claiming tabs leased to another session; reject `chrome://`/`chrome-extension://` (we already validate URLs for navigation at `NavigationTool.ts:560+` — extend to claiming).
2. Per-session `lifecycleQueue` promise chain in the session object so claim/finalize/cleanup don't interleave (Codex `runLifecycle`, bg:6230-6237).
3. `finalizeSession(keep?: Record<tabId, 'keep'>)` hook in the agent loop's turn-end: best-effort detach all debuggers for leased tabs (fixes the §3.1 leak even before refcounting lands), close agent-origin tabs not kept, release user-origin leases. Deliverable/handoff distinction can come later; "detach + close agent tabs + release" is the 80%.
4. Stale-lease GC at session start: drop leases whose `chrome.tabs.get` throws (Codex `resumeHandoffIfPresent`, bg:6166-6193).
5. UX polish (P2): badge favicons of agent-controlled tabs (SVG data-URI overlay, Codex bg:4180-4195) and name the session tab group from the task title (`nameSession`).

### 3.7 [P2] Cross-origin iframe (OOPIF) support via target attachment

**Their implementation:** `attachTarget`/`detachTarget` attach the debugger to child targets by `{targetId}` (bg:6253-6264), track `targetId → tabId` (`Fe`) for cleanup, and the passthrough addresses commands at `{targetId}` (bg:6574-6576). The CLI can therefore read and operate cross-process iframes.

**Our current state:** `DOM.getDocument({pierce: true})` only pierces same-process iframes; OOPIFs (cross-origin ads, embedded checkout/payment frames, auth widgets) are invisible to snapshots and unreachable by actions. We also cap per-frame a11y fetches at `MAX_IFRAMES = 5` (`DomService.ts:420-443`) and skip iframe depth > 1 entirely (`DomService.ts:479-482`).

**Proposed change:**

- Extend `DebuggerSessionRegistry` with target attachment: enumerate `chrome.debugger.getTargets()`, attach to `type === 'iframe'` targets belonging to the tab, maintain `targetId → tabId` for cleanup (Codex `Fe`).
- `DomService.buildSnapshot`: for each attached OOPIF target, run the same `DOM.getDocument`/`getFullAXTree`/`DOMSnapshot.captureSnapshot` triple against the target and graft the subtree under the owning `<iframe>` VirtualNode. The existing `frameId:backendNodeId` node-id scheme (`DOMTool.ts:452-478`, `FrameRegistry`) extends naturally: frame index already disambiguates; the frame registry gains a `targetId` column so actions route commands to the right debuggee.
- Actions: `DomService.click/type` look up the node's frame's `targetId` and send `Input.*`/`DOM.*` to `{targetId}` instead of `{tabId}`. Note `Input.dispatchMouseEvent` coordinates for OOPIFs are relative to the OOPIF's viewport — translate via the iframe element's content quad in the parent frame.
- Raise/remove `MAX_IFRAMES` with a byte-budget instead of a count cap (serializer already tracks metrics via `CompactionMetrics`).

### 3.8 [P1] Event-driven page readiness (replace polling heuristics)

**Their implementation:** the extension forwards all CDP events to the CLI (§2.7); the CLI uses standard `Page.lifecycleEvent` waiting. Nothing in the extension sleeps or polls.

**Our current state:** two layered heuristics:

- `NavigationTool.waitForTabToLoad` polls `chrome.tabs.get(tabId).status` every 100ms (`NavigationTool.ts:536-552`).
- `DomService.waitForPageLoad` (`DomService.ts:227-326`) evaluates `document.readyState`, then runs an SPA heuristic loop — counting buttons/links/inputs and `innerText.length`, sniffing `[class*="loading"]` spinners — polling every 1s up to 15s, fail-open. It costs up to 15s on legitimately sparse pages and is fooled by skeleton screens without "loading" class names.

**Proposed change:**

- On attach (registry, §3.1), `Page.setLifecycleEventsEnabled({enabled: true})`. New `PageReadiness` helper subscribes to forwarded events and exposes `waitFor(tabId, {until: 'load'|'DOMContentLoaded'|'networkAlmostIdle'|'networkIdle', timeoutMs})` — `networkAlmostIdle`/`networkIdle` come free with lifecycle events (no `Network.enable` needed).
- `NavigationTool.navigateToUrl` switches `chrome.tabs.update` + status polling → `Page.navigate` via the registry handle (returns `frameId`/`loaderId` for correlation) + `waitFor('load' | 'networkAlmostIdle')`.
- `DomService.waitForPageLoad` becomes: `waitFor('networkAlmostIdle', {timeoutMs: 8000})` fail-open, keeping a *single* cheap content check before returning (one `Runtime.evaluate`) instead of the 1s polling loop. Keep the heuristic loop only as fallback when lifecycle events are unavailable.
- Forward `Page.javascriptDialogOpening` to the agent loop and auto-respond or surface it as a tool result — today a `confirm()` dialog deadlocks any pending CDP evaluate.

### 3.9 [P1] Download tracking

**Their implementation:** §2.7 — `chrome.downloads.onCreated/onChanged` → `{id, filename, url, status}` events pushed to the agent, gated on browser-control-active.

**Our current state:** no download awareness. An agent that clicks "Export CSV" cannot learn whether/where the file landed.

**Proposed change:** `DownloadWatcher` in the background service worker mirroring Codex's state machine (`handleDownloadCreated`/`handleDownloadChanged`, bg:5963-5990): track `id → {filename, url}`, emit `started/completed/interrupted` into the session event bus, expose last-N downloads via a small `browser_downloads` tool action or fold into navigation tool results ("download started: report.csv"). Requires adding the `downloads` permission to `manifest.json`.

### 3.10 [P2] Operational hardening grab-bag

Smaller Codex behaviors worth copying:

- **Deferred update reload** (bg:6972): if `chrome.runtime.onUpdateAvailable` fires mid-session, defer `chrome.runtime.reload()` until no agent session is active. Today an extension update can kill a turn.
- **Instance identity** (bg:6979-6983): persist an `extensionInstanceId` UUID at install; include it in telemetry/session metadata to disambiguate multiple Chrome profiles.
- **Typed unsupported-command errors** (bg:5895, `executeUnhandledCommand`): our `DOMTool.validateRequest` returns strings; standardize on typed error codes end-to-end (the `DOMToolErrorCode` enum exists, `DOMTool.ts:60-69`, but `handleError`'s string-sniffing mapper at `DOMTool.ts:514-541` is fragile — set codes at throw sites instead).
- **Race-timeout helper** (`Oe`, bg:4156-4165): a shared `withTimeout(promise, ms, fallback)` utility instead of ad-hoc `setTimeout` races scattered across services.

---

## 4. What we already do better (keep, don't regress)

For fairness and to scope the doc: Codex's extension contains **no page-reading intelligence** — no DOM serializer, no a11y-tree fusion, no token-budgeted compaction; all of that lives in their CLI where we can't see it. Things workx should keep:

- The `DomService` snapshot fusion (DOM tree + per-frame a11y tree + DOMSnapshot paint-order/layout) and the serialization pipeline with filters/simplifiers/compaction metrics — this is the core IP of `browser_dom` v3 and has no counterpart in the Codex extension.
- The rich `type()` engine (text-anchored `insertAfter/insertBefore/replace/replaceAll`, rich-text editor detection for Quill/Slate/ProseMirror/Lexical, paste-vs-char-by-char strategies, formatting shortcuts) — far beyond `Input.insertText`.
- Structured per-tool LLM affordances (observe-act loop guidance, scrollability annotation, viewport filtering) baked into tool descriptions.
- Self-contained operation: no native host installation, works on any Chrome with just the extension.

---

## 5. Implementation plan

Ordered by dependency; see `tasks.md` for the checklist form.

| # | Work item | Sections | Size | Key files |
|---|---|---|---|---|
| 1 | `DebuggerSessionRegistry` (locks, refcounts, single event dispatch, force-detach) | §3.1, §3.2 | M | new `browser/DebuggerSessionRegistry.ts`; rewire `DomService.ts`, `ScreenshotService.ts`, `CoordinateActionService.ts`, `ChromeDebuggerClient.ts` |
| 2 | CDP command timeouts + `CdpCommandTimeoutError` | §3.2 | S | `ChromeDebuggerClient.ts`, registry |
| 3 | `InputDispatcher` + key definitions table + click option plumbing + `getContentQuads` targeting | §3.4 | M | new `input/InputDispatcher.ts`, `input/keyDefinitions.ts`; `DomService.ts` click/keypress, `CoordinateActionService.ts`, `DOMTool.ts` |
| 4 | Viewport override service + `browser_viewport` tool + DPR simplification | §3.3 | M | new `browser/ViewportOverrideService.ts`, new tool, `DomService.buildLayoutMap`, `ScreenshotService.ts` |
| 5 | Tab leases + turn finalization + stale GC | §3.6 | M | new `core/TabLeaseStore.ts`, `TabManager.ts`, agent session lifecycle |
| 6 | Lifecycle-event page readiness; rewire navigation + snapshot waiting; dialog handling | §3.8 | M | new `browser/PageReadiness.ts`, `NavigationTool.ts`, `DomService.waitForPageLoad` |
| 7 | Download watcher + permission | §3.9 | S | new `background/DownloadWatcher.ts`, `manifest.json` |
| 8 | Overlay ping-or-inject + MutationObserver self-heal (+ optional arrival sync) | §3.5 | S–M | `content-script.ts`, platform adapter, `DomService.triggerVisualEffect` |
| 9 | OOPIF target attachment + snapshot grafting + per-target input routing | §3.7 | L | registry, `DomService.ts`, `DomSnapshot.ts`, `FrameRegistry` |
| 10 | Hardening grab-bag (deferred reload, instance id, typed errors, `withTimeout`) | §3.10 | S | service worker, `DOMTool.ts`, utils |

Suggested phasing: **PR-1** = items 1–3 (pure correctness, no tool-surface changes, existing tests must pass; add unit tests for lock/refcount semantics and key table). **PR-2** = items 4–6. **PR-3** = 7–8. **PR-4** = 9 (largest, riskiest). Item 10 can ride along any PR.

## 6. Risks

- **Emulation overrides are user-visible** if the agent operates a tab the user is watching; mitigation in §3.3 (match current CSS viewport, always clear on release; never apply to user-claimed tabs unless a vision flow needs it).
- **Refcounted detach changes timing** of the Chrome debugger infobar ("workx is debugging this browser") — it will now disappear at turn end rather than lingering; verify the UX and that re-attach latency (~50ms) per turn is acceptable.
- **`getContentQuads` migration** changes click coordinates on transformed/inline elements; gate behind a config flag for one release with fallback to `getBoxModel`.
- **OOPIF attachment** raises the number of debugger targets; Chrome shows one infobar regardless, but cleanup paths must include targets (registry handles via `targetId → tabId` map, mirroring Codex `Fe`).
