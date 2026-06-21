# Tasks — Improve web-operation tools from Codex extension learnings

See `design.md` (v2, reviewed) for full technical detail. Section references (§) point there; interface contracts in §7 are authoritative.

## PR-1: Debugger + input correctness (P0)

- [ ] **T01** Create `DebuggerSessionRegistry` per §7.1 — interface in `src/core/tools/browser/`, singleton impl `ChromeDebuggerSessionRegistry` in `src/extension/tools/browser/` (§3.1)
  - [ ] Per-tab async mutex serializing attach/detach; promise-chain with `.catch`/`.finally` so a rejected op can't poison the lock (§1.6 #2)
  - [ ] Refcounted `acquire(tabId) → DebuggerHandle` / `handle.release()`; detach at refcount 0; `release()` never throws
  - [ ] ONE global `chrome.debugger.onEvent`/`onDetach` listener pair; dispatch by `source.tabId` (also fixes the per-instance `onDetach` listener leak)
  - [ ] Idempotent attach; `ALREADY_ATTACHED` thrown only for foreign (DevTools) attachment
  - [ ] Per-tab `enabledDomains` set; `ensureDomain` sends `.enable` once; **cleared on every detach path** (release-at-0, forceDetach, onDetach)
  - [ ] `forceDetach` runs **inside `withTabLock`**; clears state first (refs→0, enabledDomains cleared), ignores detach errors; concurrent `acquire` re-attaches clean (§1.6 #2)
  - [ ] Unit tests: concurrent acquire, release-at-zero only, onDetach reconciliation, single-listener assertion, forceDetach-then-acquire re-attach
- [ ] **T02** Per-command timeout in `sendCommand` (default 10s, typed `CdpCommandTimeoutError`); timeout → `forceDetach` → clean re-attach on next acquire; longer budgets for `Accessibility.getFullAXTree` / `DOMSnapshot.captureSnapshot`; document the force-detach blast radius / consider a wedged-check gate (§3.2, §1.6 #2)
- [ ] **T03** Migrate callers to the registry (§3.1, §1.5):
  - [ ] `DomService` (`ChromeDebuggerClient` becomes thin adapter over `DebuggerHandle`)
  - [ ] `ScreenshotService` + `CoordinateActionService` — **both** trees (`src/extension/tools/screenshot/` AND `src/tools/screenshot/`); delete both `Runtime.evaluate('1+1')` probes; both trees import the **same** singleton registry module
  - [ ] `PageVisionTool` acquires ONE handle per vision action and releases after the whole screenshot→click sequence — not per service call (§1.6 #3)
  - [ ] Mark `ExtensionBrowserController` `@deprecated` (dormant — do not rewire)
- [ ] **T04** `src/extension/tools/input/keyDefinitions.ts` — US-layout table per §7.2 (`key → {code, keyCode, text?, shiftKey?, shiftKeyCode?, location?}`) + unit tests (Enter/Tab/Arrow/letters/digits/modifiers/**shifted chars**/**keypad**) (§1.6 #4)
- [ ] **T05** `src/extension/tools/input/InputDispatcher.ts` per §7.2 (§3.4)
  - [ ] `dispatchKey`: correct `code`, `windowsVirtualKeyCode`, `text` for printables; `rawKeyDown` rule; Shift modifier bit + `shiftKey`/`shiftKeyCode` for capitals/shifted; forward `location` for keypad (§1.6 #4)
  - [ ] `click`: `mouseMoved` (`button:'none'`,`buttons:0`) → `mousePressed` (button bit set) → `mouseReleased` (button **cleared** from `buttons`); double-click = two press/release pairs; right-click `button:'right'`+`buttons:2` (§1.6 #5)
  - [ ] Replace bespoke dispatch in `DomService.click/keypress` and `CoordinateActionService.*`
- [ ] **T06** Plumb `ClickOptions` from `DOMTool.executeClick` → `DomService.click` — note the type is `clickType:'single'|'double'` (not `clickCount`); map at the boundary (§3.4, §1.6 #5)
- [ ] **T07** `DOM.getContentQuads` targeting + viewport-intersection visibility (no scroll offsets); **dispatch at the quad∩viewport intersection center, not the whole-quad center** (§1.6 #6); `useContentQuads` ServiceConfig flag with `getBoxModel` fallback; removes `SVG_CLICK_NOT_SUPPORTED` carve-out and the spurious-scroll path (§3.4, §1.5)
- [ ] **T08** **Vision DPR hotfix**: downscale the captured PNG to `innerWidth × innerHeight` CSS pixels (read `devicePixelRatio` at capture time — **not** `clip.scale`, §1.6 #1), both ScreenshotService trees (§3.3, §1.5)

**Acceptance (§5.1):** no tool-surface changes; DPR-2 vision click lands correctly; keypress Enter submits a real form; concurrent `browser_dom`+`page_vision` don't race attach; one debugger event listener process-wide.

## PR-2: Viewport, leases, readiness (P1)

- [ ] **T09** `ViewportOverrideService`: `Emulation.setDeviceMetricsOverride({deviceScaleFactor:1, mobile:false})`, default size = tab's current CSS viewport; `clearDeviceMetricsOverride` on release. Applied ONLY in `page_vision` flows + explicit tool use — never on user-bound tabs otherwise (§3.3, §1.5)
- [ ] **T10** Simplify DPR division in `DomService.buildLayoutMap` when override active; keep fallback (§3.3)
- [ ] **T11** `browser_viewport` tool (`set WxH` / `reset`) registered in `registerExtensionTools.ts`; reset-before-finishing prompt guidance (§3.3)
- [ ] **T12** `TabLeaseStore` per §7.4 on `chrome.storage.session`; claim/release wired into **`RepublicAgent.handleTabBinding` (CASES 1/2/3) — not `Session.setTabId`** (§1.6 #7); release at cleanup (Session.ts:995) + `abortTasksForTab` (Session.ts:2310); reject cross-session claims + `chrome://` via an **extracted/shared** blocked-scheme helper; close agent tabs on release **only if unfocused/inactive** (§3.6)
- [ ] **T13** Per-session `lifecycleQueue` serializing claim/release/cleanup **and the startup GC** (§3.6)
- [ ] **T14** Stale-lease GC at service-worker start + session start, run through the `lifecycleQueue` to avoid the GC-vs-claim race (§3.6)
- [ ] **T15** `PageReadiness` per §7.3 (`Page.enable` **then** `Page.setLifecycleEventsEnabled`, loaderId-correlated waits) (§3.8, §1.6 #8)
- [ ] **T16** `NavigationTool`: `chrome.tabs.update`+poll → `Page.navigate` + `waitFor`; keep poll as no-debugger fallback. Note: this newly attaches a debugger (infobar) to a previously un-debugged tab — weigh the cost (§3.8, §1.6 #8)
- [ ] **T17** `DomService.waitForPageLoad`: `waitFor('networkAlmostIdle', {timeoutMs: 8000, failOpen: true})` + single content check; heuristic loop only as fallback (`useLifecycleReadiness` config) (§3.8)
- [ ] **T18** Handle `Page.javascriptDialogOpening` via `Page.handleJavaScriptDialog` (requires `Page.enable`); default auto-dismiss (`accept:false`) unless a tool opts in — fixes `confirm()` deadlock (§3.8, §1.6 #8)

**Acceptance (§5.1):** viewport set/reset round-trips; lease invariants (rebind releases+detaches, SW restart leaves no orphans, cross-session bind rejected); navigation completes on `load` event; dialog no longer hangs the turn.

## PR-3: Downloads + overlay (P1/P2)

- [ ] **T19** `DownloadWatcher` background module; emit started/completed/interrupted via **`Session.emitEvent`** (not `onProgress`, §1.6 #9); surface in tool results. (`downloads` permission already present — no manifest change.) (§3.9)
- [ ] **T20** `ensureContentScript(tabId)`: ping (`WORKX_PING`) → `chrome.scripting.executeScript({injectImmediately:true})` → re-ping; dedupe in-flight injections; idempotent re-inject already guarded by `window.__workx_content_script_loaded__`; call from `triggerVisualEffect`; delete dead `ensureVisualEffectsInitialized` (DomService.ts:913-956) (§3.5)
- [ ] **T21** Overlay self-heal: `MutationObserver` on **`document.body`** (host's actual parent — content-script.ts:126) remounts shadow host when `!host.isConnected`; **guard re-entrancy** (check `isConnected` / disconnect around re-append); dataset marker detects impostors (§3.5)
- [ ] ~~Cursor arrival handshake~~ — deferred indefinitely (§1.5: no pre-click cursor animation exists to synchronize)

**Acceptance (§5.1):** agent-clicked download reports filename+status; overlay survives `documentElement.replaceChildren()`; effects work on pre-install tabs.

## PR-4: OOPIF (P2) — substantial rewrite, not a "natural extension" (§1.6 #10)

- [ ] **T22** Add a target-addressed send path to `ChromeDebuggerClient.sendCommand` (currently hard-rejects non-`tabId` targets — prerequisite). Then registry target attachment via `Target.setAutoAttach({flatten:true})` + `attachedToTarget` events (not one-shot `getTargets()`, which races late OOPIFs); `targetId → tabId` cleanup map (§3.7)
- [ ] **T23** Read-only first: per-target DOM/a11y/DOMSnapshot grafted under owner `<iframe>` VirtualNode; `FrameRegistry` (in **`DomSnapshot.ts`**, not `DOMTool.ts`) gains a real `targetId` column; resolve cross-target `backendNodeId` collisions (ids unique only per target); make every `getBoxModel`/`scrollIntoViewIfNeeded`/`Input.*` site target-aware (§3.7, §1.5)
- [ ] **T24** (After T23 proves stable in dogfood) input routing: dispatch to the **page session** with translated coordinates = parent iframe content-quad offset + element offset (account for nested scroll / iframe transform / pinch-zoom) — **not** `Input.*` to `{targetId}` (§3.7, §1.6 #10)
- [ ] **T25** Replace `MAX_IFRAMES=5` count cap with serializer byte budget (§3.7)
- [ ] **T26** Delete `ExtensionBrowserController` if still unused (§1.5)

**Acceptance (§5.1):** cross-origin iframe elements appear in snapshots with frame-scoped node ids; no orphaned debugger state after detach.

## Ride-along hardening (§3.10)

- [ ] **T27** Defer `chrome.runtime.reload()` on pending update until no active session
- [ ] **T28** Persist `extensionInstanceId` UUID at install; attach to session metadata
- [ ] **T29** Typed error codes at throw sites; remove string-sniffing mapper in `DOMTool.handleError` (DOMTool.ts:514-541)
- [ ] **T30** Shared `withTimeout(promise, ms, fallback?)` utility; replace ad-hoc `setTimeout` races
