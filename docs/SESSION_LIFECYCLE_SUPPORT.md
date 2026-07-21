# Session Lifecycle Support Guide

Use `diagnostics.report` (or the product's `/doctor` surface) when conversations appear
stuck, repeatedly hydrate, or wait for capacity. The `session-lifecycle` check reports only
non-identifying counters:

- lifecycle mode and live/managed-live counts;
- running and hydrating counts;
- active capacity reservations;
- queued session and submission counts;
- configured `maxLive` and `hardMax`.

No session IDs, titles, prompts, URLs, or event payloads are included. Lifecycle telemetry
is also privacy-gated and numeric-only.

## Interpreting common states

| Symptom | Meaning | Action |
|---|---|---|
| `hydratingCount` stays nonzero | History, assembly, or auth reconciliation has not finished. | Inspect the runtime hydration failure code and retry; saved history is unchanged. |
| reservations exceed live graphs briefly | Parallel hydration is in its construction window. | Normal if ≤ `hardMax`; a thrown step must return the counter to zero. |
| queued sessions at `hardMax` | Every live graph is ineligible for LRU suspension. | Finish/stop work, answer input, or close a viewed surface; queued work resumes FIFO. |
| awaiting-input badge | Approval or browser foreground attention is pending. | Open the indicated conversation and respond. |
| durability degraded | The result exists, but its terminal recovery marker failed to persist. | Check storage before restarting; do not treat this as a failed task. |
| partial replay warning | The bounded live replay ring overflowed or the UI buffer truncated. | Wait for IDLE or choose Reload to fetch the committed rollout snapshot. |
| delivery unknown | A reconnect changed epochs before intent acceptance was proven. | Review the conversation; explicit resend uses a new client ID and may duplicate work. |

## Deletion recovery

Delete writes a tombstone first and keeps Undo available until purge begins. Hard purge
claims the tombstone, stops any live graph, removes rollout/cache/token/task/tool-result and
legacy rows, then deletes the index row last. A partial failure leaves `purgeState:failed`;
the two-hour scheduler retries it, and Undo remains disabled once purge is claimed.
