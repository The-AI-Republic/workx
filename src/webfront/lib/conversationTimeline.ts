import { getResponseItemContent } from '@/core/protocol/types';
import type { HistoryPage } from '@/storage/rollout';
import type { ProcessedEvent } from '@/types/ui';
import { STYLE_PRESETS } from '@/types/ui';

export type TimelineSource = 'persisted' | 'live' | 'optimistic' | 'local';

export interface TimelineEntry {
  event: ProcessedEvent;
  source: TimelineSource;
}

/** The sole visible-conversation authority for one surface/thread. */
export interface ConversationTimeline {
  order: string[];
  byId: Record<string, TimelineEntry>;
  observedDeliveryIds: string[];
}

/** One-shot message copies already represented by the attach projection. */
export type MessageDedupeBudget = Map<string, number>;

export function emptyTimeline(): ConversationTimeline {
  return { order: [], byId: {}, observedDeliveryIds: [] };
}

export function timelineEvents(timeline: ConversationTimeline): ProcessedEvent[] {
  return timeline.order.flatMap((id) => timeline.byId[id]?.event ?? []);
}

export function upsertTimelineEvent(
  timeline: ConversationTimeline,
  event: ProcessedEvent,
  source: TimelineSource,
  position: 'append' | 'prepend' = 'append',
): ConversationTimeline {
  const exists = Boolean(timeline.byId[event.id]);
  return {
    ...timeline,
    order: exists
      ? timeline.order
      : position === 'prepend'
        ? [event.id, ...timeline.order]
        : [...timeline.order, event.id],
    byId: { ...timeline.byId, [event.id]: { event, source } },
  };
}

export function noteDelivery(
  timeline: ConversationTimeline,
  eventId: string,
): ConversationTimeline {
  if (timeline.observedDeliveryIds.includes(eventId)) return timeline;
  const observedDeliveryIds = [...timeline.observedDeliveryIds, eventId].slice(-2048);
  return { ...timeline, observedDeliveryIds };
}

/**
 * Replace the committed/replay projection while retaining only surface-local
 * rows and still-pending optimistic user messages. This prevents attach from
 * clobbering the last send and prevents stale live rows from duplicating a
 * now-durable response.
 */
export function reconcileAttachedTimeline(
  current: ConversationTimeline,
  persisted: readonly ProcessedEvent[],
  replay: readonly ProcessedEvent[],
  pendingClientMessageIds: ReadonlySet<string>,
): ConversationTimeline {
  let next = emptyTimeline();
  next.observedDeliveryIds = [...current.observedDeliveryIds];
  const persistedSignatures = new Map<string, number>();
  for (const event of persisted) next = upsertTimelineEvent(next, event, 'persisted');
  for (const event of persisted) {
    const signature = eventSignature(event);
    persistedSignatures.set(signature, (persistedSignatures.get(signature) ?? 0) + 1);
  }
  for (const event of replay) {
    const signature = eventSignature(event);
    const durableCopies = persistedSignatures.get(signature) ?? 0;
    if (durableCopies > 0 && event.category === 'message') {
      persistedSignatures.set(signature, durableCopies - 1);
      continue;
    }
    next = upsertTimelineEvent(next, event, 'live');
  }
  for (const id of current.order) {
    const entry = current.byId[id];
    if (!entry) continue;
    const pending = id.startsWith('user:') && pendingClientMessageIds.has(id.slice(5));
    if (
      !next.byId[id]
      && (entry.source === 'local' || (entry.source === 'optimistic' && pending))
    ) {
      next = insertRetainedTimelineEvent(next, entry.event, entry.source);
    }
  }
  return next;
}

/**
 * Attach history is already in durable sequence order. Insert retained local
 * rows at their event time without re-sorting that authoritative projection.
 */
function insertRetainedTimelineEvent(
  timeline: ConversationTimeline,
  event: ProcessedEvent,
  source: TimelineSource,
): ConversationTimeline {
  if (timeline.byId[event.id]) {
    return upsertTimelineEvent(timeline, event, source);
  }
  const timestamp = event.timestamp?.getTime?.() ?? Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return upsertTimelineEvent(timeline, event, source);
  }
  const insertionIndex = timeline.order.findIndex((id) => {
    const existingTimestamp = timeline.byId[id]?.event.timestamp?.getTime?.();
    return existingTimestamp !== undefined
      && Number.isFinite(existingTimestamp)
      && existingTimestamp > timestamp;
  });
  if (insertionIndex < 0) {
    return upsertTimelineEvent(timeline, event, source);
  }
  return {
    ...timeline,
    order: [
      ...timeline.order.slice(0, insertionIndex),
      event.id,
      ...timeline.order.slice(insertionIndex),
    ],
    byId: { ...timeline.byId, [event.id]: { event, source } },
  };
}

/**
 * Build the remaining one-shot duplicate budget for the attach live tail.
 * Replay copies are consumed first; only the narrow snapshot/buffer race is
 * left for the caller to suppress while draining its attach buffer.
 */
export function createAttachMessageDedupeBudget(
  persisted: readonly ProcessedEvent[],
  replay: readonly ProcessedEvent[],
): MessageDedupeBudget {
  const budget: MessageDedupeBudget = new Map();
  for (const event of persisted) {
    if (event.category !== 'message') continue;
    const signature = eventSignature(event);
    budget.set(signature, (budget.get(signature) ?? 0) + 1);
  }
  for (const event of replay) consumeAttachMessageDuplicate(budget, event);
  return budget;
}

/** Consume at most one durable copy; the budget is discarded after attach. */
export function consumeAttachMessageDuplicate(
  budget: MessageDedupeBudget | undefined,
  event: ProcessedEvent,
): boolean {
  if (!budget || event.category !== 'message') return false;
  const signature = eventSignature(event);
  const copies = budget.get(signature) ?? 0;
  if (copies <= 0) return false;
  if (copies === 1) budget.delete(signature);
  else budget.set(signature, copies - 1);
  return true;
}

function eventSignature(event: ProcessedEvent): string {
  return `${event.category}\u0000${event.title}\u0000${typeof event.content === 'string'
    ? event.content
    : JSON.stringify(event.content)}`;
}

export function prependHistoryPage(
  current: ConversationTimeline,
  events: readonly ProcessedEvent[],
): ConversationTimeline {
  let next = current;
  for (const event of [...events].reverse()) {
    next = upsertTimelineEvent(next, event, 'persisted', 'prepend');
  }
  return next;
}

export function historyPageToEvents(page: HistoryPage): ProcessedEvent[] {
  return page.items.flatMap((item): ProcessedEvent[] => {
    const response = item.response;
    if (response.type === 'message') {
      if (response.role === 'system') return [];
      const content = getResponseItemContent(response);
      const imageCount = Array.isArray(response.content)
        ? response.content.filter((part) => (
          part && typeof part === 'object' && 'type' in part && part.type === 'input_image'
        )).length
        : 0;
      const visible = content || (imageCount > 0 ? `[${imageCount} image(s)]` : '');
      if (!visible) return [];
      const user = response.role === 'user';
      return [{
        id: item.id,
        category: 'message',
        timestamp: new Date(item.timestamp),
        title: user ? 'user' : 'workx',
        content: visible,
        style: user ? { textColor: 'text-cyan-400' } : STYLE_PRESETS.agent_message,
        streaming: false,
        collapsible: false,
        ...(!user && response.modelKey ? { modelKey: response.modelKey } : {}),
      }];
    }
    if (response.type === 'reasoning') {
      const content = getResponseItemContent(response);
      if (!content) return [];
      return [{
        id: item.id,
        category: 'reasoning',
        timestamp: new Date(item.timestamp),
        title: 'reasoning',
        content,
        style: STYLE_PRESETS.reasoning,
        streaming: false,
        collapsible: true,
      }];
    }
    return [];
  });
}
