# Feature Specification: Visual Effect Clearing Communication Debug

**Feature Branch**: `009-debug-visual-effect-clear`
**Created**: 2025-11-12
**Status**: Draft
**Input**: User description: "investigate and debug why we cannot send a signal to src/content/ui_effect/VisualEffectController.svelte to clear the effect. Currently, we want to let the visual effect to be cleared when BrowserAgent finish task running (complete, or abort). We want to send a message to the tab content js from service worker, however current the message sending system has a bug causing it never succeed to receive the singal to clear the visual effect. This is to debug the root cause"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Background-to-Content Message Delivery (Priority: P1)

When a BrowserAgent task completes (TaskComplete, TaskFailed, or TurnAborted), the service worker needs to notify VisualEffectController running in content scripts to clear visual effects (overlay, water ripple animations, cursor animations).

**Why this priority**: This is the core messaging issue preventing visual effects from clearing automatically. Without this, visual effects remain visible after tasks end, creating poor user experience and confusion.

**Independent Test**: Can be fully tested by triggering a task completion event in service worker and verifying that the VisualEffectController receives the message and clears visual effects. Delivers immediate value by fixing the stuck visual effects bug.

**Acceptance Scenarios**:

1. **Given** a BrowserAgent task is running with visible visual effects (overlay + water ripple), **When** the task completes successfully (TaskComplete event), **Then** VisualEffectController receives the EVENT message and calls handleAgentStop() to clear all visual effects
2. **Given** a BrowserAgent task is running with visible visual effects, **When** the task fails (TaskFailed event), **Then** VisualEffectController receives the EVENT message and calls handleAgentStop() to clear all visual effects
3. **Given** a BrowserAgent task is running with visible visual effects, **When** the user aborts the task (TurnAborted event), **Then** VisualEffectController receives the EVENT message and calls handleAgentStop() to clear all visual effects

---

### User Story 2 - Diagnostic Logging and Root Cause Identification (Priority: P1)

Developers need comprehensive logging throughout the messaging chain to identify where messages are being lost or not delivered correctly.

**Why this priority**: Without diagnostic logging, it's impossible to identify the exact point of failure in the message delivery chain. This is critical for debugging and fixing the root cause.

**Independent Test**: Can be fully tested by triggering a task completion event and examining console logs at each stage: BrowserxAgent event emission → service worker EVENT broadcast → chrome.tabs.sendMessage → VisualEffectController message listener. Delivers value by pinpointing the exact failure point.

**Acceptance Scenarios**:

1. **Given** a task completion event is emitted from BrowserxAgent, **When** examining console logs, **Then** logs show: (1) BrowserxAgent emitEvent() called with TaskComplete, (2) service worker receives EVENT message, (3) service worker broadcasts to all tabs, (4) chrome.tabs.sendMessage succeeds/fails for each tab
2. **Given** a message is sent via chrome.tabs.sendMessage, **When** VisualEffectController content script is loaded on a tab, **Then** logs show: (1) VisualEffectController listener registered, (2) message received by listener, (3) taskLifecycleHandler called with correct message structure
3. **Given** messages are being lost or not delivered, **When** examining logs, **Then** error messages clearly indicate the failure point (e.g., "tab not ready", "content script not loaded", "message listener not registered", "handler not called")

---

### User Story 3 - Content Script Lifecycle Verification (Priority: P2)

The system needs to verify that VisualEffectController content scripts are properly loaded and message listeners are registered before attempting message delivery.

**Why this priority**: Content scripts may not be loaded on all tabs (e.g., chrome:// pages, extension pages), causing message delivery failures. This verification helps prevent silent failures and provides clear error reporting.

**Independent Test**: Can be fully tested by checking tab URLs and content script injection status before sending messages. Delivers value by preventing message delivery attempts to tabs where content scripts cannot run.

**Acceptance Scenarios**:

1. **Given** a tab has a chrome:// URL or extension URL, **When** attempting to send EVENT message, **Then** service worker skips that tab and logs "Content script not injectable on chrome:// or extension pages"
2. **Given** a tab has a regular web page URL but content script failed to load, **When** attempting to send EVENT message, **Then** chrome.tabs.sendMessage fails with "Could not establish connection" error
3. **Given** multiple tabs are open with mixed URL types, **When** broadcasting EVENT message, **Then** only tabs with injectable content scripts receive messages, and errors are logged for skipped/failed tabs

---

### Edge Cases

- What happens when no tabs are open (extension just started)? → Broadcast completes successfully with zero recipients, no errors logged
- What happens when content script is loaded after task completion? → Visual effects remain visible until next task lifecycle event (acceptable limitation, document in spec)
- What happens when service worker restarts mid-task? → Task state is lost, visual effects may remain visible (edge case, requires separate persistence feature)
- What happens when message is sent to inactive/background tab? → Message is delivered normally, content script processes it, visual effects cleared (even if tab not visible)
- What happens when VisualEffectController unmounts/remounts during message delivery? → Message may be lost if listener is being re-registered, retry logic needed (enhancement, not in MVP)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST emit TaskComplete, TaskFailed, and TurnAborted events from BrowserxAgent when tasks end
- **FR-002**: System MUST broadcast these lifecycle events to all tabs via chrome.tabs.sendMessage when received by service worker
- **FR-003**: System MUST register chrome.runtime.onMessage listener in VisualEffectController content script to receive lifecycle events
- **FR-004**: System MUST call handleAgentStop() in VisualEffectController when TaskComplete, TaskFailed, or TurnAborted events are received
- **FR-005**: System MUST log all stages of message delivery: (1) BrowserxAgent event emission, (2) service worker EVENT receipt, (3) broadcast attempt to each tab, (4) chrome.tabs.sendMessage success/failure, (5) VisualEffectController message receipt
- **FR-006**: System MUST identify and report tabs where content scripts cannot be injected (chrome://, extension pages)
- **FR-007**: System MUST handle chrome.tabs.sendMessage errors gracefully without blocking other tab broadcasts
- **FR-008**: System MUST verify that the EVENT message structure matches what VisualEffectController expects: `{ type: 'EVENT', payload: { msg: { type: 'TaskComplete' | 'TaskFailed' | 'TurnAborted' } } }`

### Key Entities *(feature involves messaging data)*

- **TaskLifecycleEvent**: Event emitted when task completes, fails, or aborts
  - Attributes: type ('TaskComplete' | 'TaskFailed' | 'TurnAborted'), timestamp, optional metadata
  - Relationships: Emitted by BrowserxAgent, wrapped in EVENT message by service worker, received by VisualEffectController

- **EVENT Message**: Chrome extension message wrapping task lifecycle events
  - Attributes: type ('EVENT'), payload (contains original event), timestamp, optional tabId
  - Relationships: Sent from service worker to content scripts via chrome.tabs.sendMessage

- **MessageDeliveryLog**: Diagnostic log entry tracking message delivery
  - Attributes: stage (emission, receipt, broadcast, delivery, handler), success (boolean), error (string if failed), timestamp, tabId (if applicable)
  - Relationships: Generated at each stage of message delivery chain

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Visual effects clear automatically within 500ms of task completion in 100% of test scenarios
- **SC-002**: Diagnostic logs capture all message delivery stages, enabling root cause identification within 2 minutes of examining console output
- **SC-003**: System handles at least 10 simultaneous tabs without message delivery failures or performance degradation
- **SC-004**: Error reporting clearly indicates the failure point (e.g., "content script not loaded", "tab not ready") in 100% of message delivery failures
- **SC-005**: No false positives: System does not log errors for expected scenarios (e.g., chrome:// pages where content scripts cannot be injected)
