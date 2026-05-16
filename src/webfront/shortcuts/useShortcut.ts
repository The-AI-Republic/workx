import { get } from 'svelte/store';
import {
  CONTEXT_PRIORITY,
  getShortcutDisplay as getCoreShortcutDisplay,
  type ShortcutAction,
  type ShortcutContext,
} from '@/core/shortcuts';
import { shortcutStore } from './shortcutStore';

export type ShortcutHandler = (event: KeyboardEvent) => void | false | Promise<void | false>;

interface HandlerRegistration {
  action: ShortcutAction;
  context: ShortcutContext;
  handler: ShortcutHandler;
  order: number;
}

interface ContextRegistration {
  context: ShortcutContext;
  active: () => boolean;
  priority: number;
  order: number;
}

const handlers = new Map<ShortcutAction, HandlerRegistration[]>();
const contexts: ContextRegistration[] = [];
let nextOrder = 1;

export function registerShortcut(
  action: ShortcutAction,
  context: ShortcutContext,
  handler: ShortcutHandler,
): () => void {
  const registration: HandlerRegistration = { action, context, handler, order: nextOrder++ };
  const actionHandlers = handlers.get(action) ?? [];
  actionHandlers.push(registration);
  handlers.set(action, actionHandlers);

  return () => {
    const current = handlers.get(action);
    if (!current) return;
    const next = current.filter((item) => item !== registration);
    if (next.length === 0) {
      handlers.delete(action);
    } else {
      handlers.set(action, next);
    }
  };
}

export function registerShortcutContext(
  context: ShortcutContext,
  options: { active?: () => boolean; priority?: number } = {},
): () => void {
  const registration: ContextRegistration = {
    context,
    active: options.active ?? (() => true),
    priority: options.priority ?? CONTEXT_PRIORITY[context],
    order: nextOrder++,
  };
  contexts.push(registration);

  return () => {
    const index = contexts.indexOf(registration);
    if (index >= 0) contexts.splice(index, 1);
  };
}

export function getActiveShortcutContexts(): ShortcutContext[] {
  const active = contexts
    .filter((item) => item.active())
    .sort((a, b) => b.priority - a.priority || b.order - a.order)
    .map((item) => item.context);

  if (!active.includes('Global')) {
    active.push('Global');
  }

  return [...new Set(active)];
}

export function invokeShortcutAction(
  action: ShortcutAction,
  context: ShortcutContext,
  event: KeyboardEvent,
): boolean {
  const registrations = handlers.get(action);
  if (!registrations?.length) return false;

  const activeContexts = new Set(getActiveShortcutContexts());
  const match = registrations
    .filter((item) => item.context === context && activeContexts.has(item.context))
    .sort((a, b) => b.order - a.order)[0]
    ?? registrations
      .filter((item) => activeContexts.has(item.context))
      .sort((a, b) => b.order - a.order)[0];

  if (!match) return false;
  const result = match.handler(event);
  if (result instanceof Promise) {
    result.catch((error) => console.warn('[Shortcuts] Shortcut handler failed:', error));
    return true;
  }
  return result !== false;
}

export function getShortcutDisplay(
  action: ShortcutAction,
  context: ShortcutContext,
  fallback?: string,
): string {
  const state = get(shortcutStore);
  return getCoreShortcutDisplay(action, context, state.bindings, state.platform, fallback);
}
