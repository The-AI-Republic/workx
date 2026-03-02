# Feature Specification: Rollout Storage Provider Abstraction

**Feature Branch**: `033-rollout-storage-provider`
**Created**: 2026-02-24
**Status**: Draft
**Input**: User description: "Refactor Rollout Recorder to use StorageProvider abstraction instead of hardcoded IndexedDB calls"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persistent Conversation History on Desktop (Priority: P1)

As a desktop (Tauri) user, I want my conversation history to be reliably persisted so that I can resume previous conversations after restarting the application and browse my chat history.

Currently, the rollout recorder uses hardcoded IndexedDB calls that bypass the platform storage abstraction. On desktop, this means conversation data either goes into the WebView's volatile IndexedDB (unreliable across restarts) or silently fails, leaving users with no conversation history. By routing rollout storage through the existing StorageProvider interface, desktop users get SQLite-backed persistence automatically.

**Why this priority**: This is the core problem being solved. Desktop users may lose conversation history entirely because rollout storage bypasses the platform abstraction layer.

**Independent Test**: Can be fully tested by starting a conversation on the desktop app, closing the app, reopening it, and verifying the conversation appears in history and can be resumed.

**Acceptance Scenarios**:

1. **Given** a desktop user starts a new conversation, **When** they send messages and close the app, **Then** the conversation is persisted in SQLite and available after restart.
2. **Given** a desktop user has prior conversations, **When** they open the conversation history, **Then** all previous conversations are listed with correct titles and timestamps.
3. **Given** a desktop user selects a previous conversation, **When** they choose to resume it, **Then** the full conversation history is loaded in chronological order.

---

### User Story 2 - Consistent Extension Behavior (Priority: P2)

As a browser extension user, I want the same conversation persistence behavior I have today, with no regressions in functionality or performance.

The refactoring must preserve the existing IndexedDB-based storage for the extension mode. The extension's rollout recording, conversation listing, history loading, and cleanup must continue to work identically.

**Why this priority**: The extension is the existing, working product. Any regression here affects current users immediately.

**Independent Test**: Can be fully tested by running the existing rollout test suite and manually verifying conversation create, resume, list, and cleanup flows in the extension.

**Acceptance Scenarios**:

1. **Given** an extension user records a conversation, **When** they list conversations, **Then** the conversation appears with correct metadata and item count.
2. **Given** an extension user has expired conversations, **When** TTL cleanup runs, **Then** expired conversations and their items are removed while permanent ones remain.
3. **Given** an extension user resumes a conversation, **When** the history is loaded, **Then** all items are returned in correct sequence order.

---

### User Story 3 - Conversation Cleanup and Storage Management (Priority: P3)

As a user on any platform, I want expired conversations to be automatically cleaned up so that storage usage remains manageable over time.

TTL-based expiration and cleanup must work consistently across both platforms. Conversations marked as permanent should never be cleaned up, while time-limited conversations should be removed after their configured TTL.

**Why this priority**: Storage management prevents unbounded growth, but is secondary to basic persistence working correctly.

**Independent Test**: Can be tested by creating conversations with short TTLs, advancing time, triggering cleanup, and verifying only expired conversations are removed.

**Acceptance Scenarios**:

1. **Given** conversations with a 1-day TTL exist and are older than 1 day, **When** cleanup runs, **Then** those conversations and all their items are deleted.
2. **Given** a conversation is marked as permanent, **When** cleanup runs, **Then** the permanent conversation is not affected.
3. **Given** cleanup removes a conversation, **When** its items are queried, **Then** no orphaned items remain.

---

### Edge Cases

- What happens when the storage provider fails to initialize during session startup? The system should degrade gracefully (set rollout to null) and log the failure, matching current behavior.
- What happens when a write operation fails mid-conversation? The system logs the error and disables rollout persistence for the remainder of the session (graceful degradation). No retry logic is needed.
- What happens when resuming a conversation that was partially written (e.g., app crashed mid-write)? The system should load whatever items were successfully persisted and resume from that point.
- What happens when listing conversations returns a mix of valid and corrupted records? Corrupted records should be skipped with a warning, not crash the listing operation.
- What happens when the storage provider is closed while writes are still pending? The flush operation should complete pending writes before the provider is closed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST define a RolloutStorageProvider interface that abstracts all rollout persistence operations (create, record, read history, list, cleanup, stats).
- **FR-002**: System MUST provide an IndexedDB-backed implementation of RolloutStorageProvider for extension mode, preserving the existing database schema (`PiRollouts`, stores: `rollouts`, `rollout_items`).
- **FR-003**: System MUST provide a StorageProvider-backed implementation of RolloutStorageProvider for desktop mode, using the existing StorageProvider interface (which routes to SQLite on desktop).
- **FR-004**: System MUST select the appropriate RolloutStorageProvider implementation at initialization time based on the platform build mode.
- **FR-005**: System MUST preserve the existing RolloutRecorder public API so that all consumers (Session, SessionServices, listing, cleanup) require no changes.
- **FR-006**: System MUST support write batching with sequence numbering to maintain item ordering within a conversation.
- **FR-007**: System MUST support cursor-based pagination for conversation listing across both implementations.
- **FR-008**: System MUST support TTL-based expiration for conversations, including permanent (never-expire) conversations.
- **FR-009**: System MUST support the persistence filtering policy (which item types to persist) independent of the storage backend.
- **FR-010**: System MUST handle storage initialization failures gracefully by setting rollout to null and logging the error, without crashing the session.
- **FR-011**: System MUST flush all pending writes before closing the storage provider during shutdown.
- **FR-012**: System MUST provide storage statistics (conversation count, total item count, storage size estimates) across both implementations.

### Key Entities

- **RolloutStorageProvider**: The abstraction interface that defines all storage operations needed by the rollout system (create metadata, write items, read history, list conversations, cleanup expired, get stats).
- **Rollout Metadata**: Per-conversation record containing ID, creation/update timestamps, expiration timestamp, session metadata, item count, and status.
- **Rollout Item**: Individual conversation record containing rollout ID, timestamp, sequence number, type discriminator, and payload. Types include: session_meta, response_item, compacted, turn_context, event_msg, turn_completion.
- **Conversations Page**: Paginated result set of conversation summaries with cursor-based navigation.

## Clarifications

### Session 2026-02-24

- Q: How should the system handle write failures mid-conversation — retry with backoff, graceful degradation, or surface to user? → A: Log error and disable rollout for the session (graceful degradation), matching the existing codebase pattern. No retry logic needed.

## Assumptions

- The existing StorageProvider interface (with CRUD, bulk, query, and transaction operations) is sufficient to implement rollout storage for the desktop backend without needing interface changes.
- The existing IndexedDB schema for rollouts (`PiRollouts` database, v2) does not need migration — the IndexedDB implementation wraps the current direct calls.
- Write batching and sequence management remain the responsibility of RolloutRecorder/RolloutWriter, not the storage provider.
- The persistence filtering policy (which items to persist) is applied before data reaches the storage provider.
- Desktop mode uses the collections `rollout_metadata` and `rollout_items` within the existing StorageProvider/SQLite infrastructure.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Desktop users can create, resume, and list conversations with the same reliability as extension users — zero data loss across app restarts.
- **SC-002**: All existing rollout-related tests pass without modification (extension behavior preserved).
- **SC-003**: Conversation listing returns results within 500ms for up to 1,000 stored conversations on both platforms.
- **SC-004**: TTL cleanup correctly removes 100% of expired conversations and 0% of permanent conversations.
- **SC-005**: Storage statistics accurately report conversation count and item count to within 1% of actual values.
- **SC-006**: No direct `indexedDB.open()` calls remain in shared/core rollout code — all storage access goes through the RolloutStorageProvider abstraction.
