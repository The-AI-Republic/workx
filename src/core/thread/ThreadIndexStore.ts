import type { AgentMode } from '../../prompts/PromptComposer';
import type { StorageAdapter } from '../../storage/StorageAdapter';
import { PerKeyOperationQueue } from '../concurrency/PerKeyOperationQueue';

export const THREAD_INDEX_STORE = 'thread_index';
export const THREAD_INDEX_SCHEMA_VERSION = 1 as const;

export interface ThreadIndexEntry {
  sessionId: string;
  title: string;
  searchTitle: string;
  titleSource: 'generated' | 'user' | null;
  titleUpdatedAt: number;
  createdAt: number;
  lastActiveAt: number;
  /** Null while the thread is an empty draft hidden from chat history. */
  publishedAt: number | null;
  pinned: boolean;
  deletedAt: number | null;
  purgeAfter: number | null;
  purgeState?: 'pending' | 'failed';
  agentMode: AgentMode;
  origin: { kind: 'new' } | { kind: 'fork'; sourceSessionId: string };
  /** Legacy full-snapshot display or bounded canonical-log projection. */
  historyMode?: 'legacy' | 'paginated';
  schemaVersion: typeof THREAD_INDEX_SCHEMA_VERSION;
}

export interface ThreadListRequest {
  includeDeleted?: boolean;
  /** Internal maintenance/routing read; user-facing history leaves this false. */
  includeDrafts?: boolean;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface ThreadListPage {
  entries: ThreadIndexEntry[];
  nextCursor: string | null;
}

interface ThreadCursor {
  v: 1;
  query: string;
  includeDeleted: boolean;
  includeDrafts: boolean;
  pinned: boolean;
  lastActiveAt: number;
  sessionId: string;
}

export class ThreadIndexError extends Error {
  readonly errorCode: 'INVALID_ARGUMENT' | 'SESSION_NOT_FOUND' | 'SESSION_DELETED';
  readonly retryable = false;

  constructor(
    readonly code: 'INVALID_ARGUMENT' | 'SESSION_NOT_FOUND' | 'SESSION_DELETED',
    message: string,
  ) {
    super(message);
    this.name = 'ThreadIndexError';
    this.errorCode = code;
  }
}

export function normalizeSearchTitle(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

export function createThreadIndexEntry(input: {
  sessionId: string;
  title?: string;
  now?: number;
  agentMode?: AgentMode;
  origin?: ThreadIndexEntry['origin'];
  publishedAt?: number | null;
}): ThreadIndexEntry {
  const now = input.now ?? Date.now();
  const title = input.title?.trim() ?? '';
  return {
    sessionId: input.sessionId,
    title,
    searchTitle: normalizeSearchTitle(title),
    titleSource: null,
    titleUpdatedAt: now,
    createdAt: now,
    lastActiveAt: now,
    publishedAt: input.publishedAt === undefined ? now : input.publishedAt,
    pinned: false,
    deletedAt: null,
    purgeAfter: null,
    agentMode: input.agentMode ?? 'general',
    origin: input.origin ?? { kind: 'new' },
    historyMode: 'paginated',
    schemaVersion: THREAD_INDEX_SCHEMA_VERSION,
  };
}

export class ThreadIndexStore {
  private readonly queue = new PerKeyOperationQueue();
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  private initialize(): Promise<void> {
    return this.initPromise ??= this.adapter.initialize();
  }

  async get(sessionId: string, includeDeleted = false): Promise<ThreadIndexEntry | null> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const entry = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
      if (!entry) return null;
      const repaired = this.repair(entry);
      if (repaired !== entry) await this.adapter.put(THREAD_INDEX_STORE, repaired);
      if (!includeDeleted && repaired.deletedAt !== null) return null;
      return repaired;
    });
  }

  async require(sessionId: string, includeDeleted = false): Promise<ThreadIndexEntry> {
    const entry = await this.get(sessionId, true);
    if (!entry) throw new ThreadIndexError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (!includeDeleted && entry.deletedAt !== null) {
      throw new ThreadIndexError('SESSION_DELETED', `Session is deleted: ${sessionId}`);
    }
    return entry;
  }

  async upsert(entry: ThreadIndexEntry): Promise<ThreadIndexEntry> {
    return this.queue.run(entry.sessionId, async () => {
      await this.initialize();
      const normalized = this.repair({ ...entry });
      await this.adapter.put(THREAD_INDEX_STORE, normalized);
      return normalized;
    });
  }

  async createIfMissing(entry: ThreadIndexEntry): Promise<ThreadIndexEntry> {
    return this.queue.run(entry.sessionId, async () => {
      await this.initialize();
      const current = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, entry.sessionId);
      if (current) {
        const repaired = this.repair(current);
        if (repaired !== current) await this.adapter.put(THREAD_INDEX_STORE, repaired);
        return repaired;
      }
      const normalized = this.repair({ ...entry });
      await this.adapter.put(THREAD_INDEX_STORE, normalized);
      return normalized;
    });
  }

  async patch(
    sessionId: string,
    update: Partial<Omit<ThreadIndexEntry, 'sessionId' | 'schemaVersion'>>,
  ): Promise<ThreadIndexEntry> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
      if (!current) throw new ThreadIndexError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
      const next = this.repair({ ...current, ...update, sessionId, schemaVersion: 1 });
      await this.adapter.put(THREAD_INDEX_STORE, next);
      return next;
    });
  }

  async rename(sessionId: string, rawTitle: string): Promise<ThreadIndexEntry> {
    const title = rawTitle.trim();
    if (Array.from(title).length < 1 || Array.from(title).length > 120) {
      throw new ThreadIndexError('INVALID_ARGUMENT', 'Title must contain 1 to 120 Unicode characters');
    }
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.requireStored(sessionId);
      if (current.deletedAt !== null) {
        throw new ThreadIndexError('SESSION_DELETED', `Session is deleted: ${sessionId}`);
      }
      if (current.title === title && current.titleSource === 'user') return this.repair(current);
      const next = this.repair({
        ...current,
        title,
        searchTitle: normalizeSearchTitle(title),
        titleSource: 'user',
        titleUpdatedAt: this.now(),
      });
      await this.adapter.put(THREAD_INDEX_STORE, next);
      return next;
    });
  }

  async pin(sessionId: string, pinned: boolean): Promise<ThreadIndexEntry> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.requireStored(sessionId);
      if (current.deletedAt !== null) {
        throw new ThreadIndexError('SESSION_DELETED', `Session is deleted: ${sessionId}`);
      }
      if (current.pinned === pinned) return this.repair(current);
      const next = this.repair({ ...current, pinned });
      await this.adapter.put(THREAD_INDEX_STORE, next);
      return next;
    });
  }

  async commitGeneratedTitle(sessionId: string, rawTitle: string): Promise<boolean> {
    const title = rawTitle.trim();
    if (!title) return false;
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
      if (!current || current.deletedAt !== null || current.titleSource === 'user') return false;
      await this.adapter.put(THREAD_INDEX_STORE, this.repair({
        ...current,
        title,
        searchTitle: normalizeSearchTitle(title),
        titleSource: 'generated',
        titleUpdatedAt: this.now(),
      }));
      return true;
    });
  }

  async softDelete(sessionId: string, retentionMs = 30 * 24 * 60 * 60 * 1000): Promise<ThreadIndexEntry> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.requireStored(sessionId);
      if (current.deletedAt !== null) return this.repair(current);
      const deletedAt = this.now();
      const next = this.repair({
        ...current,
        deletedAt,
        purgeAfter: deletedAt + retentionMs,
        purgeState: undefined,
      });
      await this.adapter.put(THREAD_INDEX_STORE, next);
      return next;
    });
  }

  async undelete(sessionId: string): Promise<ThreadIndexEntry | null> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
      if (!current) throw new ThreadIndexError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
      if (current.purgeState) return null;
      if (current.deletedAt === null) return this.repair(current);
      const restored = this.repair({
        ...current,
        deletedAt: null,
        purgeAfter: null,
        purgeState: undefined,
      });
      await this.adapter.put(THREAD_INDEX_STORE, restored);
      return restored;
    });
  }

  /** Atomically claim a tombstone for hard purge; null means Undo won first. */
  async beginPurge(sessionId: string): Promise<ThreadIndexEntry | null> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
      if (!current || current.deletedAt === null) return null;
      if (current.purgeState === 'pending') return this.repair(current);
      const pending = this.repair({ ...current, purgeState: 'pending' });
      await this.adapter.put(THREAD_INDEX_STORE, pending);
      return pending;
    });
  }

  async purge(sessionId: string): Promise<boolean> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      return this.adapter.delete(THREAD_INDEX_STORE, sessionId);
    });
  }

  async list(request: ThreadListRequest = {}): Promise<ThreadListPage> {
    await this.initialize();
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ThreadIndexError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100');
    }
    const query = normalizeSearchTitle(request.query ?? '');
    const includeDeleted = request.includeDeleted ?? false;
    const includeDrafts = request.includeDrafts ?? false;
    const cursor = request.cursor ? this.decodeCursor(request.cursor) : null;
    if (cursor && (
      cursor.query !== query
      || cursor.includeDeleted !== includeDeleted
      || cursor.includeDrafts !== includeDrafts
    )) {
      throw new ThreadIndexError('INVALID_ARGUMENT', 'Cursor does not match the list request');
    }

    const raw = await this.adapter.getAll<ThreadIndexEntry>(THREAD_INDEX_STORE);
    const repaired = raw.map((entry) => this.repair(entry));
    const repairs = repaired.filter((entry, index) => entry !== raw[index]);
    if (repairs.length > 0) {
      // Re-read and repair in the same per-session lane as every other write.
      // Persisting the stale row returned by getAll() could otherwise overwrite
      // a rename or activity update that completed while list() was running.
      await Promise.all(repairs.map((entry) => this.repairStored(entry.sessionId)));
    }
    const rows = repaired
      .filter((entry) => includeDeleted || entry.deletedAt === null)
      .filter((entry) => includeDrafts || entry.publishedAt !== null)
      .filter((entry) => !query || entry.searchTitle.includes(query))
      .sort(compareEntries);
    const cursorStart = cursor
      ? rows.findIndex((entry) => compareEntryToCursor(entry, cursor) > 0)
      : 0;
    const start = cursor && cursorStart < 0 ? rows.length : cursorStart;
    const page = rows.slice(start, start + limit);
    const hasMore = start + page.length < rows.length;
    const last = page[page.length - 1];
    return {
      entries: page,
      nextCursor: hasMore && last
        ? this.encodeCursor({
            v: 1,
            query,
            includeDeleted,
            includeDrafts,
            pinned: last.pinned,
            lastActiveAt: last.lastActiveAt,
            sessionId: last.sessionId,
          })
        : null,
    };
  }

  private repairStored(sessionId: string): Promise<void> {
    return this.queue.run(sessionId, async () => {
      await this.initialize();
      const current = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
      if (!current) return;
      const repaired = this.repair(current);
      if (repaired !== current) await this.adapter.put(THREAD_INDEX_STORE, repaired);
    });
  }

  async backfill(input: {
    rollouts: Array<{
      id: string;
      created?: number;
      updated?: number;
      sessionMeta?: { title?: string };
    }>;
    persistedSessions?: Array<{
      sessionId: string;
      createdAt?: number;
      lastActivityAt?: number;
    }>;
    defaultMode?: AgentMode;
  }): Promise<void> {
    await this.initialize();
    const marker = await this.adapter.get<{ key: string; value: boolean }>(
      'config',
      'thread_index_backfill_v1',
    );
    const rollouts = new Map(input.rollouts.map((rollout) => [rollout.id, rollout]));
    const persisted = new Map(
      (input.persistedSessions ?? []).map((session) => [session.sessionId, session]),
    );
    const ids = new Set([...rollouts.keys(), ...persisted.keys()]);
    for (const sessionId of [...ids].sort()) {
      const rollout = rollouts.get(sessionId);
      const session = persisted.get(sessionId);
      const title = typeof rollout?.sessionMeta?.title === 'string'
        ? rollout.sessionMeta.title.trim()
        : '';
      const createdCandidates = [rollout?.created, session?.createdAt]
        .filter((value): value is number => Number.isFinite(value));
      const createdAt = createdCandidates.length > 0
        ? Math.min(...createdCandidates)
        : this.now();
      const activeCandidates = [rollout?.updated, session?.lastActivityAt, createdAt]
        .filter((value): value is number => Number.isFinite(value));
      const candidate: ThreadIndexEntry = {
        ...createThreadIndexEntry({
          sessionId,
          title,
          now: createdAt,
          agentMode: input.defaultMode,
        }),
        titleSource: title ? 'user' : null,
        titleUpdatedAt: title && Number.isFinite(rollout?.updated)
          ? rollout!.updated!
          : createdAt,
        lastActiveAt: Math.max(...activeCandidates),
        historyMode: 'legacy',
      };
      const current = await this.get(sessionId, true);
      if (!current) {
        await this.createIfMissing(candidate);
      } else if (
        current.titleSource !== 'user'
        && title
        && (current.title !== title || current.titleUpdatedAt < candidate.titleUpdatedAt)
      ) {
        await this.patch(sessionId, {
          title,
          searchTitle: normalizeSearchTitle(title),
          titleSource: 'generated',
          titleUpdatedAt: candidate.titleUpdatedAt,
          createdAt: Math.min(current.createdAt, candidate.createdAt),
          lastActiveAt: Math.max(current.lastActiveAt, candidate.lastActiveAt),
        });
      }
    }
    await this.queue.flush();
    if (!marker?.value) {
      await this.adapter.put('config', { key: 'thread_index_backfill_v1', value: true });
    }
  }

  flush(sessionId?: string): Promise<void> {
    return this.queue.flush(sessionId);
  }

  private repair(entry: ThreadIndexEntry): ThreadIndexEntry {
    const expected = normalizeSearchTitle(entry.title ?? '');
    // Rows created before draft publication existed are real history entries.
    // Treat them as published rather than hiding an existing user's history.
    const publishedAt = entry.publishedAt === undefined ? entry.createdAt : entry.publishedAt;
    if (
      entry.searchTitle === expected
      && entry.schemaVersion === 1
      && entry.publishedAt === publishedAt
      && (entry.historyMode === 'legacy' || entry.historyMode === 'paginated')
    ) return entry;
    return {
      ...entry,
      searchTitle: expected,
      publishedAt,
      historyMode: entry.historyMode === 'paginated' ? 'paginated' : 'legacy',
      schemaVersion: 1,
    };
  }

  private async requireStored(sessionId: string): Promise<ThreadIndexEntry> {
    const entry = await this.adapter.get<ThreadIndexEntry>(THREAD_INDEX_STORE, sessionId);
    if (!entry) throw new ThreadIndexError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    return entry;
  }

  private encodeCursor(cursor: ThreadCursor): string {
    const bytes = new TextEncoder().encode(JSON.stringify(cursor));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private decodeCursor(value: string): ThreadCursor {
    try {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const decoded = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ThreadCursor>;
      if (
        decoded.v !== 1
        || typeof decoded.query !== 'string'
        || typeof decoded.includeDeleted !== 'boolean'
        || (decoded.includeDrafts !== undefined && typeof decoded.includeDrafts !== 'boolean')
        || typeof decoded.pinned !== 'boolean'
        || !Number.isFinite(decoded.lastActiveAt)
        || typeof decoded.sessionId !== 'string'
      ) throw new Error('invalid cursor');
      return { ...decoded, includeDrafts: decoded.includeDrafts ?? false } as ThreadCursor;
    } catch {
      throw new ThreadIndexError('INVALID_ARGUMENT', 'Invalid list cursor');
    }
  }
}

function compareEntries(a: ThreadIndexEntry, b: ThreadIndexEntry): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.lastActiveAt !== b.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
  return a.sessionId.localeCompare(b.sessionId);
}

function compareEntryToCursor(entry: ThreadIndexEntry, cursor: ThreadCursor): number {
  return compareEntries(entry, {
    ...entry,
    pinned: cursor.pinned,
    lastActiveAt: cursor.lastActiveAt,
    sessionId: cursor.sessionId,
  });
}
