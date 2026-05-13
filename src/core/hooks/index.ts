/**
 * Hook & Event System — Public API
 */

export { HookRegistry } from './HookRegistry';
export { HookExecutor } from './HookExecutor';
export { HookMatcher } from './HookMatcher';
export { HookAggregator } from './HookAggregator';
export { HookDispatcher } from './HookDispatcher';
export type { HookFireOptions, HookEventEmitter } from './HookDispatcher';
export { ConfigHookLoader } from './loaders/ConfigHookLoader';
export { SessionHookStore } from './loaders/SessionHookStore';

export type {
  HookEvent,
  HookCommandType,
  HookCommand,
  HookMatcherEntry,
  HookSource,
  RegisteredHook,
  HookOutcome,
  HookResult,
  AggregatedHookResult,
  HookInput,
  HooksConfig,
} from './types';
