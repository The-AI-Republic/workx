/**
 * EventMsg secret redaction for server egress (Track 24.5).
 *
 * Shared by the two non-blocking server gates: the WebSocket frame broadcast
 * (`ServerChannel.sendEvent`) and the on-disk transcript append
 * (`ServerAgentBootstrap` event dispatcher). Both must scrub assistant-produced
 * text without dropping the event (blocking a WS stream or losing a transcript
 * entry would break the surface) — so detected secrets become `***`.
 *
 * Only consolidated text fields are scrubbed. Deltas are fragmentary and
 * unreliable to scan; the durable surfaces (the full `AgentMessage`, the
 * connector reply) carry the complete text and are covered.
 *
 * @module server/security/eventRedaction
 */

import type { EventMsg } from '@/core/protocol/events';
import { scanForSecrets } from '@/core/security/secretScanner';

/** Return a redacted copy of `event` if it carries scannable text, else the
 *  original reference unchanged (no allocation when nothing matched). */
export function redactEventMsgSecrets(event: EventMsg): EventMsg {
  if (event.type === 'AgentMessage') {
    const message = scanForSecrets(event.data.message).redacted;
    return message === event.data.message
      ? event
      : { ...event, data: { ...event.data, message } };
  }
  if (event.type === 'AgentReasoning') {
    const content = scanForSecrets(event.data.content).redacted;
    const reasoning =
      event.data.reasoning !== undefined
        ? scanForSecrets(event.data.reasoning).redacted
        : undefined;
    if (content === event.data.content && reasoning === event.data.reasoning) return event;
    return { ...event, data: { ...event.data, content, reasoning } };
  }
  if (event.type === 'AgentReasoningRawContent') {
    const content = scanForSecrets(event.data.content).redacted;
    return content === event.data.content
      ? event
      : { ...event, data: { ...event.data, content } };
  }
  return event;
}
