# Session Lifecycle RPC

Session services are correlated `ServiceRequest` calls. Per-session calls require an
explicit `sessionId`; UI input must use `session.submit`, never the generic operation
channel.

## Thread and history methods

| Method | Important input | Result / behavior |
|---|---|---|
| `session.open` | optional title/mode/origin | Reserves an ID and creates an index-only suspended thread on clients. |
| `session.get` | `sessionId`, optional `includeDeleted` | Returns one indexed row plus runtime without hydration. |
| `session.list` | query, cursor, limit ≤100 | Pinned-first deterministic page plus runtime views. Cursors are request-bound. |
| `session.getRollout` | `sessionId` | Returns durable snapshot revision/items without hydration. |
| `session.rename` | `sessionId`, title | Writes a user title; later generated titles cannot overwrite it. |
| `session.pin` | `sessionId`, `pinned` | Updates list ordering without hydration. |
| `session.setMode` | `sessionId`, mode | Persists immediately; live running graphs apply at their safe boundary. |
| `session.delete` / `session.undelete` | `sessionId` | Tombstones or restores the same durable ID. Running delete requires confirmation. |

`session.create` and `session.resume` remain compatibility aliases for external clients;
in-repository UI callers use `open`, `get`, `attach`, and `submit`.

## Attach and surface methods

1. Call `session.setViewed({surfaceId,sessionId})` and retain its `leaseId`.
2. Begin buffering live events for that session.
3. Call `session.attach({surfaceId,sessionId,after?})`.
4. Apply snapshot, replay through `throughSeq`, then buffered events beyond that boundary.
5. Heartbeat every 20 seconds while visible with `session.heartbeat`; call
   `session.releaseSurface` when hidden/unmounted. Server TTL is 60 seconds.

Attach returns `entry`, `snapshot`, `runtime`, and an optional replay batch. Replay is
bounded; `truncated:true` means the client must warn and refresh the committed snapshot at
terminal IDLE. Epoch changes invalidate unmatched sending/queued client intents, which the
UI labels delivery-unknown rather than replaying automatically.

## Submission and controls

`session.submit` requires `sessionId`, a caller-generated `clientMessageId`, and input
items. The response is one of:

- `accepted` with `submissionId`;
- `queued` with per-session position, phase, and optional capacity position;
- `rejected` with a typed reason (`queue-full`, `deleted`, `busy`, `not-found`,
  `client-id-conflict`, or `submit-failed`).

Client IDs are idempotent for the same canonical input digest and are rejected if reused
with different content. Queues are FIFO, bounded to 8 inputs per session and 32 waiting
sessions globally. Accepted and terminal markers are durable for reconnect recovery.

Interrupt, approval, attention resolution, rewind, and mode changes are control paths:
they never enter the hydration queue. `session.close` is a compatibility force-suspend on
client lifecycle mode and does not delete history or write a close marker.

Lifecycle broadcasts are `session_runtime_state`, `session_submission_state`,
`session_index_changed`, and `browser_attention_required`. Agent events additionally carry
`sessionId`, `runtimeEpoch`, and monotonically increasing `eventSeq`.
