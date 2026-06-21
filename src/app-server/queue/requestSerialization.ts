/**
 * Request Serialization Keys
 *
 * Maps a method + target to a serialization key and access mode so the
 * request queue can serialize conflicting mutations while letting independent /
 * read-only requests run concurrently.
 *
 * @module app-server/queue/requestSerialization
 */

export type RequestAccessMode = 'read' | 'write';

export type RequestSerializationKey =
  | { kind: 'global'; resource: 'config' | 'credentials' | 'tools' }
  | { kind: 'session'; sessionKey: string }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'connection-local'; connectionId: string }
  | { kind: 'none' };

export interface SerializationResolution {
  /** Stable string key used by the scheduler's per-key lock. */
  key: string;
  mode: RequestAccessMode;
}

/** Stringify a serialization key for use as a lock map key. */
export function serializationKeyString(key: RequestSerializationKey): string {
  switch (key.kind) {
    case 'global':
      return `global:${key.resource}`;
    case 'session':
      return `session:${key.sessionKey}`;
    case 'approval':
      return `approval:${key.approvalId}`;
    case 'connection-local':
      return `conn:${key.connectionId}`;
    case 'none':
      return 'none';
  }
}

const WRITE = 'write' as const;
const READ = 'read' as const;

/**
 * Resolve the serialization key + mode for a method.
 */
export function resolveSerialization(
  method: string,
  ctx: { sessionKey?: string; connectionId: string; approvalId?: string },
): SerializationResolution {
  const session = ctx.sessionKey ?? `conn:${ctx.connectionId}`;
  const sessionKey: RequestSerializationKey = { kind: 'session', sessionKey: session };

  switch (method) {
    case 'health':
      return { key: serializationKeyString({ kind: 'none' }), mode: READ };
    case 'tools.catalog':
      return { key: serializationKeyString({ kind: 'global', resource: 'tools' }), mode: READ };

    case 'config.get':
      return { key: serializationKeyString({ kind: 'global', resource: 'config' }), mode: READ };
    case 'config.set':
    case 'config.patch':
      return { key: serializationKeyString({ kind: 'global', resource: 'config' }), mode: WRITE };

    case 'credentials.list':
      return { key: serializationKeyString({ kind: 'global', resource: 'credentials' }), mode: READ };
    case 'credentials.set':
    case 'credentials.delete':
      return { key: serializationKeyString({ kind: 'global', resource: 'credentials' }), mode: WRITE };

    case 'sessions.list':
      return { key: serializationKeyString({ kind: 'none' }), mode: READ };
    case 'sessions.get':
    case 'sessions.turns':
    case 'chat.history':
      return { key: serializationKeyString(sessionKey), mode: READ };
    case 'sessions.patch':
    case 'sessions.reset':
    case 'sessions.delete':
    case 'sessions.compact':
    case 'sessions.rewind':
    case 'chat.send':
    case 'chat.abort':
    case 'chat.inject':
      return { key: serializationKeyString(sessionKey), mode: WRITE };

    case 'exec.approval.resolve':
      return {
        key: serializationKeyString({ kind: 'approval', approvalId: ctx.approvalId ?? 'unknown' }),
        mode: WRITE,
      };

    case 'logs.tail':
      return {
        key: serializationKeyString({ kind: 'connection-local', connectionId: ctx.connectionId }),
        mode: READ,
      };

    default:
      return { key: serializationKeyString({ kind: 'none' }), mode: READ };
  }
}
