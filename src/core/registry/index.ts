/**
 * Registry module exports
 * Feature: 015-multi-agent-instances
 */

export { SessionManager, SessionManager as AgentRegistry } from './SessionManager';
export { AgentSession } from './AgentSession';
export { SessionStorage, type PersistedSession } from './SessionStorage';
export type {
  SessionState,
  SessionType,
  SessionConfig,
  SessionMetadata,
  SessionEventType,
  SessionCreatedEvent,
  SessionStateChangedEvent,
  SessionTerminatedEvent,
  SessionEvent,
  SessionEventListener,
  RegistryConfig,
} from './types';
export {
  VALID_STATE_TRANSITIONS,
  SESSION_LETTERS,
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_LIMIT,
  MIN_CONCURRENT_LIMIT,
} from './types';
