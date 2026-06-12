# Tasks — Improve web-operation tools from Codex extension learnings

See `design.md` for full technical detail. Section references (§) point there.

## PR-1: Debugger + input correctness (P0)

- [ ] **T01** Create `src/extension/tools/browser/DebuggerSessionRegistry.ts` (§3.1)
  - [ ] Per-tab async mutex (`withTabLock`) serializing attach/detach
  - [ ] Refcounted `acquire(tabId) → DebuggerHandle` / `handle.release()`; detach at refcount 0
  - [ ] Single global `chrome.debugger.onEvent` / `onDetach` listeners; dispatch by `source.tabId`
  - [ ] Idempotent attach; tolerate "already attached" only for registry-owned tabs; keep `ALREADY_ATTACHED` DevTools-conflict error
  - [ ] Per-tab `enabledDomains` set; `ensureDomain(tabId, domain)`
  - [ ] Force-detach path (clear registry first, ignore detach errors)
  - [ ] Unit tests: concurrent acquire, release-while-in-flight, onDetach reconciliation
- [ ] **T02** Add per-command timeout to `ChromeDebuggerClient.sendCommand` (§3.2)
  - [ ] `timeoutMs` param, default 10s; typed `CdpCommandTimeoutError`
  - [ ] On timeout: mark tab wedged in registry → force-detach → next acquire re-attaches
  - [ ] Longer budgets for `Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`
- [ ] **T03** Port `DomService`, `ScreenshotService`, `CoordinateActionService`, `ExtensionBrowserController` onto the registry; delete both `Runtime.evaluate('1+1')` attach probes (§3.1)
- [ ] **T04** Create `src/extension/tools/input/keyDefinitions.ts` — US-layout key table (`key → {code, keyCode, text?, location?}`) (§3.4)
- [ ] **T05** Create `src/extension/tools/input/InputDispatcher.ts` (§3.4)
  - [ ] `dispatchKey` with correct `code`, `windowsVirtualKeyCode`, `text` for printables
  - [ ] `click` sequence: `mouseMoved` → `mousePressed` → `mouseReleased`, `buttons` bitmask, clickCount, button param
  - [ ] Replace bespoke dispatch in `DomService.click/keypress`, `CoordinateActionService.*`
- [ ] **T06** Plumb `ClickOptions` from `DOMTool.executeClick` into `DomService.click` (button, clickCount) (§3.4)
- [ ] **T07** Replace `DOM.getBoxModel` targeting with `DOM.getContentQuads` + viewport-intersection visibility check; config-flag fallback to old path; removes `SVG_CLICK_NOT_SUPPORTED` carve-out (§3.4)

## PR-2: Viewport, leases, readiness (P1)

- [ ] **T08** `ViewportOverrideService`: `Emulation.setDeviceMetricsOverride({deviceScaleFactor:1, mobile:false})` at acquire (defaulting to current CSS viewport size), `clearDeviceMetricsOverride` at release (§3.3)
- [ ] **T09** Simplify DPR handling in `DomService.buildLayoutMap` and `ScreenshotService` once DPR=1 is guaranteed; keep fallback path (§3.3)
- [ ] **T10** New `browser_viewport` agent tool (`set WxH` / `reset`) with reset-before-finishing prompt guidance (§3.3)
- [ ] **T11** `TabLeaseStore` on `chrome.storage.session`: claim/release with `origin: agent|user`; reject cross-session claims and `chrome://` (§3.6)
- [ ] **T12** Per-session `lifecycleQueue` serializing claim/finalize/cleanup (§3.6)
- [ ] **T13** `finalizeSession(keep?)` turn-end hook: detach all leased-tab debuggers, close unkept agent-origin tabs, release user leases; stale-lease GC at session start (§3.6)
- [ ] **T14** `PageReadiness` helper on `Page.setLifecycleEventsEnabled`; `waitFor(until: load|DOMContentLoaded|networkAlmostIdle|networkIdle)` (§3.8)
- [ ] **T15** `NavigationTool`: `chrome.tabs.update`+poll → `Page.navigate` + `waitFor`; keep poll as no-debugger fallback (§3.8)
- [ ] **T16** `DomService.waitForPageLoad`: lifecycle-event wait + single content check; heuristic loop only as fallback (§3.8)
- [ ] **T17** Handle `Page.javascriptDialogOpening` (auto-dismiss or surface to agent) (§3.8)

## PR-3: Downloads + overlay (P1/P2)

- [ ] **T18** `DownloadWatcher` background module; `downloads` permission in `manifest.json`; emit started/completed/interrupted to session event bus; surface in tool results (§3.9)
- [ ] **T19** `ensureContentScript(tabId)`: ping (`WORKX_PING`) → `chrome.scripting.executeScript({injectImmediately:true})` → re-ping; dedupe in-flight injections; call from `triggerVisualEffect`; delete dead `ensureVisualEffectsInitialized` (§3.5)
- [ ] **T20** Overlay self-heal: `MutationObserver` on `documentElement` remounts shadow host; dataset marker to detect impostors (§3.5)
- [ ] **T21** (Optional) Cursor arrival handshake: sequence-numbered move → `AGENT_CURSOR_ARRIVED` ack with ~1.5s cap before dispatching click (§3.5)

## PR-4: OOPIF (P2)

- [ ] **T22** Registry target attachment: enumerate iframe targets, attach `{targetId}`, maintain `targetId → tabId` cleanup map (§3.7)
- [ ] **T23** Snapshot grafting: run DOM/a11y/DOMSnapshot per OOPIF target; graft under owner `<iframe>` VirtualNode; `FrameRegistry` gains `targetId` (§3.7)
- [ ] **T24** Route actions per-target; translate OOPIF-relative input coordinates via parent-frame iframe quad (§3.7)
- [ ] **T25** Replace `MAX_IFRAMES=5` count cap with serializer byte budget (§3.7)

## Ride-along hardening (§3.10)

- [ ] **T26** Defer `chrome.runtime.reload()` on pending update until no active session
- [ ] **T27** Persist `extensionInstanceId` UUID at install; attach to session metadata
- [ ] **T28** Typed error codes at throw sites; remove string-sniffing mapper in `DOMTool.handleError`
- [ ] **T29** Shared `withTimeout(promise, ms, fallback?)` utility; replace ad-hoc `setTimeout` races
