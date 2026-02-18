/**
 * Unit tests for DiffTracker
 *
 * Tests verify:
 * - addChange() stores changes and returns correct DiffResult
 * - getChanges() filters, sorts, and limits results correctly
 * - rollbackChanges() handles single, batch, session, and edge cases
 * - createSnapshot() / restoreSnapshot() / deleteSnapshot() lifecycle
 * - clearChanges() with and without session/turn scoping
 * - destroy() cleans up all internal state
 * - Event emission through the eventEmitter callback
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiffTracker } from '@/core/DiffTracker';
import type {
  AddChangeRequest,
  ChangeMetadata,
  DiffResult,
} from '@/core/DiffTracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<ChangeMetadata> = {}): ChangeMetadata {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    toolName: 'test-tool',
    timestamp: 1000,
    rollbackable: true,
    description: 'test change',
    ...overrides,
  };
}

function makeChange(overrides: Partial<AddChangeRequest> = {}): AddChangeRequest {
  return {
    changeId: 'change-1',
    type: 'storage',
    operation: 'update',
    target: { type: 'storage_key', storageKey: 'myKey', storageType: 'local' },
    before: { value: 'old' },
    after: { value: 'new' },
    metadata: makeMetadata(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiffTracker', () => {
  let tracker: DiffTracker;
  let emitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitSpy = vi.fn();
    tracker = new DiffTracker(emitSpy);
  });

  // -----------------------------------------------------------------------
  // addChange
  // -----------------------------------------------------------------------
  describe('addChange()', () => {
    it('should store a change and return a DiffResult with status "applied"', async () => {
      const result = await tracker.addChange(makeChange());

      expect(result.changeId).toBe('change-1');
      expect(result.type).toBe('storage');
      expect(result.operation).toBe('update');
      expect(result.status).toBe('applied');
    });

    it('should populate the diff field with before, after, delta, and size', async () => {
      const result = await tracker.addChange(makeChange());

      expect(result.diff.before).toEqual({ value: 'old' });
      expect(result.diff.after).toEqual({ value: 'new' });
      expect(result.diff.delta).toEqual({
        type: 'update',
        from: { value: 'old' },
        to: { value: 'new' },
      });
      expect(typeof result.diff.size).toBe('number');
      expect(result.diff.size).toBeGreaterThanOrEqual(0);
    });

    it('should compute a "create" delta when before is undefined', async () => {
      const result = await tracker.addChange(
        makeChange({ before: undefined, after: { v: 1 } }),
      );

      expect(result.diff.delta).toEqual({ type: 'create', value: { v: 1 } });
    });

    it('should compute a "delete" delta when after is undefined', async () => {
      const result = await tracker.addChange(
        makeChange({ before: { v: 1 }, after: undefined }),
      );

      expect(result.diff.delta).toEqual({ type: 'delete', value: { v: 1 } });
    });

    it('should store rollbackData from the before value', async () => {
      const result = await tracker.addChange(
        makeChange({ before: { old: true } }),
      );

      expect(result.rollbackData).toEqual({ old: true });
    });

    it('should generate a non-empty checksum when after data exists', async () => {
      const result = await tracker.addChange(
        makeChange({ after: { x: 42 } }),
      );

      expect(result.diff.checksum).toBeTruthy();
      expect(typeof result.diff.checksum).toBe('string');
    });

    it('should generate an empty checksum when after is undefined', async () => {
      const result = await tracker.addChange(
        makeChange({ after: undefined }),
      );

      expect(result.diff.checksum).toBe('');
    });

    it('should use provided metadata', async () => {
      const meta = makeMetadata({ sessionId: 'custom-sess', toolName: 'custom-tool' });
      const result = await tracker.addChange(makeChange({ metadata: meta }));

      expect(result.metadata.sessionId).toBe('custom-sess');
      expect(result.metadata.toolName).toBe('custom-tool');
    });

    it('should assign default metadata when none is provided', async () => {
      const req = makeChange();
      delete (req as any).metadata;
      const result = await tracker.addChange(req);

      expect(result.metadata.sessionId).toBe('unknown');
      expect(result.metadata.turnId).toBe('unknown');
      expect(result.metadata.toolName).toBe('diff_tracker');
      expect(result.metadata.rollbackable).toBe(true);
    });

    it('should emit a ChangeAdded event', async () => {
      await tracker.addChange(makeChange({ changeId: 'c-evt' }));

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'evt_change_added_c-evt',
          msg: expect.objectContaining({ type: 'ChangeAdded' }),
        }),
      );
    });

    it('should overwrite a change with the same changeId', async () => {
      await tracker.addChange(makeChange({ changeId: 'dup', before: 'a', after: 'b' }));
      await tracker.addChange(makeChange({ changeId: 'dup', before: 'b', after: 'c' }));

      const changes = await tracker.getChanges({ includeRolledBack: true });
      const dups = changes.filter(c => c.changeId === 'dup');
      expect(dups).toHaveLength(1);
      expect(dups[0].diff.after).toBe('c');
    });
  });

  // -----------------------------------------------------------------------
  // getChanges
  // -----------------------------------------------------------------------
  describe('getChanges()', () => {
    beforeEach(async () => {
      await tracker.addChange(
        makeChange({
          changeId: 'c1',
          type: 'dom',
          metadata: makeMetadata({ sessionId: 'sA', turnId: 'tA', timestamp: 100 }),
        }),
      );
      await tracker.addChange(
        makeChange({
          changeId: 'c2',
          type: 'storage',
          metadata: makeMetadata({ sessionId: 'sA', turnId: 'tB', timestamp: 200 }),
        }),
      );
      await tracker.addChange(
        makeChange({
          changeId: 'c3',
          type: 'storage',
          metadata: makeMetadata({ sessionId: 'sB', turnId: 'tC', timestamp: 300 }),
        }),
      );
    });

    it('should return all applied changes when no filter is given', async () => {
      const results = await tracker.getChanges({});
      expect(results).toHaveLength(3);
    });

    it('should filter by sessionId', async () => {
      const results = await tracker.getChanges({ sessionId: 'sA' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.metadata.sessionId === 'sA')).toBe(true);
    });

    it('should filter by turnId', async () => {
      const results = await tracker.getChanges({ turnId: 'tB' });
      expect(results).toHaveLength(1);
      expect(results[0].changeId).toBe('c2');
    });

    it('should filter by type', async () => {
      const results = await tracker.getChanges({ type: 'storage' });
      expect(results).toHaveLength(2);
    });

    it('should filter by since (inclusive)', async () => {
      const results = await tracker.getChanges({ since: 200 });
      expect(results).toHaveLength(2);
      expect(results.map(r => r.changeId).sort()).toEqual(['c2', 'c3']);
    });

    it('should filter by until (inclusive)', async () => {
      const results = await tracker.getChanges({ until: 200 });
      expect(results).toHaveLength(2);
      expect(results.map(r => r.changeId).sort()).toEqual(['c1', 'c2']);
    });

    it('should filter by since and until together', async () => {
      const results = await tracker.getChanges({ since: 150, until: 250 });
      expect(results).toHaveLength(1);
      expect(results[0].changeId).toBe('c2');
    });

    it('should combine sessionId and type filters', async () => {
      const results = await tracker.getChanges({ sessionId: 'sA', type: 'dom' });
      expect(results).toHaveLength(1);
      expect(results[0].changeId).toBe('c1');
    });

    it('should sort results by timestamp descending (most recent first)', async () => {
      const results = await tracker.getChanges({});
      const timestamps = results.map(r => r.metadata.timestamp);
      expect(timestamps).toEqual([300, 200, 100]);
    });

    it('should respect the limit parameter', async () => {
      const results = await tracker.getChanges({ limit: 2 });
      expect(results).toHaveLength(2);
      // Most recent first, so c3 (300) and c2 (200)
      expect(results[0].changeId).toBe('c3');
      expect(results[1].changeId).toBe('c2');
    });

    it('should exclude rolled-back changes by default', async () => {
      await tracker.rollbackChanges({ changeId: 'c2' });

      const results = await tracker.getChanges({});
      expect(results).toHaveLength(2);
      expect(results.find(r => r.changeId === 'c2')).toBeUndefined();
    });

    it('should include rolled-back changes when includeRolledBack is true', async () => {
      await tracker.rollbackChanges({ changeId: 'c2' });

      const results = await tracker.getChanges({ includeRolledBack: true });
      expect(results).toHaveLength(3);
      const rolledBack = results.find(r => r.changeId === 'c2');
      expect(rolledBack?.status).toBe('rolled_back');
    });

    it('should emit a ChangesRetrieved event', async () => {
      emitSpy.mockClear();
      await tracker.getChanges({ sessionId: 'sA' });

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: 'ChangesRetrieved',
            data: expect.objectContaining({ count: 2 }),
          }),
        }),
      );
    });

    it('should return empty array when no changes match', async () => {
      const results = await tracker.getChanges({ sessionId: 'non-existent' });
      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // rollbackChanges
  // -----------------------------------------------------------------------
  describe('rollbackChanges()', () => {
    describe('single change rollback (changeId)', () => {
      it('should mark a rollbackable change as rolled_back', async () => {
        await tracker.addChange(makeChange({ changeId: 'rb-1' }));

        const result = await tracker.rollbackChanges({ changeId: 'rb-1' });

        expect(result.success).toBe(true);
        expect(result.rolledBackChanges).toEqual(['rb-1']);
        expect(result.failedChanges).toHaveLength(0);
        expect(result.totalChanges).toBe(1);
      });

      it('should emit RollbackStarted and RollbackCompleted events', async () => {
        await tracker.addChange(makeChange({ changeId: 'rb-evt' }));
        emitSpy.mockClear();

        await tracker.rollbackChanges({ changeId: 'rb-evt' });

        const eventTypes = emitSpy.mock.calls.map(
          (call: any[]) => call[0].msg.type,
        );
        expect(eventTypes).toContain('RollbackStarted');
        expect(eventTypes).toContain('RollbackCompleted');
      });

      it('should fail if the change does not exist', async () => {
        const result = await tracker.rollbackChanges({ changeId: 'no-such-id' });

        expect(result.success).toBe(false);
        expect(result.failedChanges).toHaveLength(1);
        expect(result.failedChanges[0].reason).toBe('Change not found');
      });

      it('should fail if the change was already rolled back', async () => {
        await tracker.addChange(makeChange({ changeId: 'rb-twice' }));
        await tracker.rollbackChanges({ changeId: 'rb-twice' });

        const result = await tracker.rollbackChanges({ changeId: 'rb-twice' });

        expect(result.success).toBe(false);
        expect(result.failedChanges).toHaveLength(1);
        expect(result.failedChanges[0].reason).toBe('Already rolled back');
      });

      it('should fail if the change is not rollbackable', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'rb-noroll',
            metadata: makeMetadata({ rollbackable: false }),
          }),
        );

        const result = await tracker.rollbackChanges({ changeId: 'rb-noroll' });

        expect(result.success).toBe(false);
        expect(result.failedChanges).toHaveLength(1);
        expect(result.failedChanges[0].reason).toBe('Change is not rollbackable');
      });
    });

    describe('batch rollback (changeIds)', () => {
      it('should rollback multiple changes at once', async () => {
        await tracker.addChange(makeChange({ changeId: 'b1' }));
        await tracker.addChange(makeChange({ changeId: 'b2' }));
        await tracker.addChange(makeChange({ changeId: 'b3' }));

        const result = await tracker.rollbackChanges({
          changeIds: ['b1', 'b2', 'b3'],
        });

        expect(result.success).toBe(true);
        expect(result.rolledBackChanges.sort()).toEqual(['b1', 'b2', 'b3']);
        expect(result.totalChanges).toBe(3);
      });

      it('should report partial success when some changes fail', async () => {
        await tracker.addChange(makeChange({ changeId: 'ok' }));
        // 'missing' does not exist

        const result = await tracker.rollbackChanges({
          changeIds: ['ok', 'missing'],
        });

        expect(result.success).toBe(true); // at least one succeeded
        expect(result.rolledBackChanges).toEqual(['ok']);
        expect(result.failedChanges).toHaveLength(1);
        expect(result.failedChanges[0].changeId).toBe('missing');
      });

      it('should emit BatchRollbackStarted event', async () => {
        await tracker.addChange(makeChange({ changeId: 'bx1' }));
        await tracker.addChange(makeChange({ changeId: 'bx2' }));
        emitSpy.mockClear();

        await tracker.rollbackChanges({ changeIds: ['bx1', 'bx2'] });

        const eventTypes = emitSpy.mock.calls.map(
          (call: any[]) => call[0].msg.type,
        );
        expect(eventTypes).toContain('BatchRollbackStarted');
      });
    });

    describe('session/turn rollback', () => {
      beforeEach(async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'st1',
            metadata: makeMetadata({
              sessionId: 'sRB',
              turnId: 'tRB',
              timestamp: 100,
              rollbackable: true,
            }),
          }),
        );
        await tracker.addChange(
          makeChange({
            changeId: 'st2',
            metadata: makeMetadata({
              sessionId: 'sRB',
              turnId: 'tRB',
              timestamp: 200,
              rollbackable: true,
            }),
          }),
        );
        await tracker.addChange(
          makeChange({
            changeId: 'st3',
            metadata: makeMetadata({
              sessionId: 'sRB',
              turnId: 'tOther',
              timestamp: 300,
              rollbackable: true,
            }),
          }),
        );
      });

      it('should rollback all applied, rollbackable changes for a session', async () => {
        const result = await tracker.rollbackChanges({ sessionId: 'sRB' });

        expect(result.success).toBe(true);
        expect(result.rolledBackChanges.sort()).toEqual(['st1', 'st2', 'st3']);
      });

      it('should rollback only changes matching both sessionId and turnId', async () => {
        const result = await tracker.rollbackChanges({
          sessionId: 'sRB',
          turnId: 'tRB',
        });

        expect(result.success).toBe(true);
        expect(result.rolledBackChanges.sort()).toEqual(['st1', 'st2']);
      });

      it('should respect the until timestamp filter', async () => {
        const result = await tracker.rollbackChanges({
          sessionId: 'sRB',
          until: 150,
        });

        expect(result.success).toBe(true);
        expect(result.rolledBackChanges).toEqual(['st1']);
      });

      it('should skip non-rollbackable changes in session rollback', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'st4-noroll',
            metadata: makeMetadata({
              sessionId: 'sRB',
              turnId: 'tRB',
              timestamp: 400,
              rollbackable: false,
            }),
          }),
        );

        const result = await tracker.rollbackChanges({ sessionId: 'sRB' });

        // st4-noroll should not appear in either list since session/turn
        // rollback only selects changes where rollbackable === true
        expect(result.rolledBackChanges).not.toContain('st4-noroll');
      });

      it('should emit SessionRollbackStarted event', async () => {
        emitSpy.mockClear();

        await tracker.rollbackChanges({ sessionId: 'sRB', turnId: 'tRB' });

        const eventTypes = emitSpy.mock.calls.map(
          (call: any[]) => call[0].msg.type,
        );
        expect(eventTypes).toContain('SessionRollbackStarted');
      });
    });

    describe('rollback with unsupported type', () => {
      it('should mark the change as failed when executeRollback throws', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'file-change',
            type: 'file',
            operation: 'update',
            target: { type: 'file_path', filePath: '/tmp/test' },
          }),
        );

        const result = await tracker.rollbackChanges({ changeId: 'file-change' });

        expect(result.success).toBe(false);
        expect(result.failedChanges).toHaveLength(1);
        expect(result.failedChanges[0].reason).toBe('Rollback execution failed');
        expect(result.failedChanges[0].error).toContain('not implemented');
      });

      it('should set the change status to "failed"', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'file-fail',
            type: 'file',
            target: { type: 'file_path', filePath: '/x' },
          }),
        );

        await tracker.rollbackChanges({ changeId: 'file-fail' });

        const changes = await tracker.getChanges({ includeRolledBack: true });
        const failed = changes.find(c => c.changeId === 'file-fail');
        expect(failed?.status).toBe('failed');
      });
    });

    describe('empty rollback request', () => {
      it('should return success false with no targets when request is empty', async () => {
        const result = await tracker.rollbackChanges({});

        expect(result.success).toBe(false);
        expect(result.rolledBackChanges).toHaveLength(0);
        expect(result.totalChanges).toBe(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // createSnapshot / restoreSnapshot / deleteSnapshot / getSnapshot
  // -----------------------------------------------------------------------
  describe('snapshot lifecycle', () => {
    describe('createSnapshot()', () => {
      it('should create a snapshot containing applied changes for the session/turn', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'snap-c1',
            metadata: makeMetadata({ sessionId: 's1', turnId: 't1' }),
          }),
        );
        await tracker.addChange(
          makeChange({
            changeId: 'snap-c2',
            metadata: makeMetadata({ sessionId: 's1', turnId: 't1' }),
          }),
        );

        const snapshot = await tracker.createSnapshot('s1', 't1', 'my snapshot');

        expect(snapshot.id).toMatch(/^snapshot_/);
        expect(snapshot.changes).toHaveLength(2);
        expect(snapshot.metadata.sessionId).toBe('s1');
        expect(snapshot.metadata.turnId).toBe('t1');
        expect(snapshot.metadata.description).toBe('my snapshot');
        expect(typeof snapshot.timestamp).toBe('number');
      });

      it('should only include applied changes, not rolled-back ones', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'snap-applied',
            metadata: makeMetadata({ sessionId: 's2', turnId: 't2' }),
          }),
        );
        await tracker.addChange(
          makeChange({
            changeId: 'snap-rb',
            metadata: makeMetadata({ sessionId: 's2', turnId: 't2' }),
          }),
        );
        await tracker.rollbackChanges({ changeId: 'snap-rb' });

        const snapshot = await tracker.createSnapshot('s2', 't2');

        expect(snapshot.changes).toHaveLength(1);
        expect(snapshot.changes[0].changeId).toBe('snap-applied');
      });

      it('should not include changes from other sessions/turns', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'snap-match',
            metadata: makeMetadata({ sessionId: 'sX', turnId: 'tX' }),
          }),
        );
        await tracker.addChange(
          makeChange({
            changeId: 'snap-other',
            metadata: makeMetadata({ sessionId: 'sY', turnId: 'tY' }),
          }),
        );

        const snapshot = await tracker.createSnapshot('sX', 'tX');

        expect(snapshot.changes).toHaveLength(1);
        expect(snapshot.changes[0].changeId).toBe('snap-match');
      });

      it('should emit SnapshotCreated event', async () => {
        emitSpy.mockClear();

        await tracker.createSnapshot('s1', 't1', 'desc');

        expect(emitSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            msg: expect.objectContaining({
              type: 'SnapshotCreated',
              data: expect.objectContaining({
                session_id: 's1',
                turn_id: 't1',
              }),
            }),
          }),
        );
      });

      it('should create an empty snapshot when no matching changes exist', async () => {
        const snapshot = await tracker.createSnapshot('empty-sess', 'empty-turn');

        expect(snapshot.changes).toHaveLength(0);
      });
    });

    describe('getSnapshot()', () => {
      it('should retrieve an existing snapshot by ID', async () => {
        const created = await tracker.createSnapshot('s', 't');
        const retrieved = await tracker.getSnapshot(created.id);

        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(created.id);
      });

      it('should return null for a non-existent snapshot', async () => {
        const result = await tracker.getSnapshot('no-such-snapshot');
        expect(result).toBeNull();
      });
    });

    describe('restoreSnapshot()', () => {
      it('should rollback the changes that were captured in the snapshot', async () => {
        await tracker.addChange(
          makeChange({
            changeId: 'restore-1',
            metadata: makeMetadata({ sessionId: 'sR', turnId: 'tR' }),
          }),
        );
        await tracker.addChange(
          makeChange({
            changeId: 'restore-2',
            metadata: makeMetadata({ sessionId: 'sR', turnId: 'tR' }),
          }),
        );

        const snapshot = await tracker.createSnapshot('sR', 'tR');
        const result = await tracker.restoreSnapshot(snapshot.id);

        expect(result.success).toBe(true);
        expect(result.rolledBackChanges.sort()).toEqual(['restore-1', 'restore-2']);
      });

      it('should return failure result for a non-existent snapshot', async () => {
        const result = await tracker.restoreSnapshot('bogus');

        expect(result.success).toBe(false);
        expect(result.failedChanges).toHaveLength(1);
        expect(result.failedChanges[0].reason).toBe('Snapshot not found');
      });

      it('should emit SnapshotRestored event', async () => {
        const snapshot = await tracker.createSnapshot('sR', 'tR');
        emitSpy.mockClear();

        await tracker.restoreSnapshot(snapshot.id);

        const eventTypes = emitSpy.mock.calls.map(
          (call: any[]) => call[0].msg.type,
        );
        expect(eventTypes).toContain('SnapshotRestored');
      });
    });

    describe('deleteSnapshot()', () => {
      it('should remove a snapshot and return true', async () => {
        const snapshot = await tracker.createSnapshot('sD', 'tD');

        const deleted = tracker.deleteSnapshot(snapshot.id);

        expect(deleted).toBe(true);
        const retrieved = await tracker.getSnapshot(snapshot.id);
        expect(retrieved).toBeNull();
      });

      it('should return false when deleting a non-existent snapshot', () => {
        const deleted = tracker.deleteSnapshot('no-such-id');
        expect(deleted).toBe(false);
      });
    });

    describe('getAllSnapshots()', () => {
      it('should return all snapshots sorted by timestamp descending', async () => {
        // Create snapshots with a small delay to ensure different timestamps
        const snap1 = await tracker.createSnapshot('s1', 't1', 'first');
        const snap2 = await tracker.createSnapshot('s2', 't2', 'second');

        const all = tracker.getAllSnapshots();

        expect(all).toHaveLength(2);
        // Most recent first
        expect(all[0].timestamp).toBeGreaterThanOrEqual(all[1].timestamp);
      });

      it('should return an empty array when no snapshots exist', () => {
        const all = tracker.getAllSnapshots();
        expect(all).toEqual([]);
      });
    });
  });

  // -----------------------------------------------------------------------
  // clearChanges
  // -----------------------------------------------------------------------
  describe('clearChanges()', () => {
    beforeEach(async () => {
      await tracker.addChange(
        makeChange({
          changeId: 'cl-1',
          metadata: makeMetadata({ sessionId: 'sA', turnId: 'tA' }),
        }),
      );
      await tracker.addChange(
        makeChange({
          changeId: 'cl-2',
          metadata: makeMetadata({ sessionId: 'sA', turnId: 'tB' }),
        }),
      );
      await tracker.addChange(
        makeChange({
          changeId: 'cl-3',
          metadata: makeMetadata({ sessionId: 'sB', turnId: 'tC' }),
        }),
      );
    });

    it('should clear all changes when called without arguments and return the count', async () => {
      const count = await tracker.clearChanges();

      expect(count).toBe(3);
      const remaining = await tracker.getChanges({ includeRolledBack: true });
      expect(remaining).toHaveLength(0);
    });

    it('should clear only changes for a given sessionId', async () => {
      const count = await tracker.clearChanges('sA');

      expect(count).toBe(2);
      const remaining = await tracker.getChanges({ includeRolledBack: true });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].changeId).toBe('cl-3');
    });

    it('should clear only changes for a given sessionId and turnId', async () => {
      const count = await tracker.clearChanges('sA', 'tA');

      expect(count).toBe(1);
      const remaining = await tracker.getChanges({ includeRolledBack: true });
      expect(remaining).toHaveLength(2);
    });

    it('should return 0 when no changes match the session filter', async () => {
      const count = await tracker.clearChanges('non-existent');
      expect(count).toBe(0);
    });

    it('should emit a ChangesCleared event', async () => {
      emitSpy.mockClear();

      await tracker.clearChanges('sA', 'tA');

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: 'ChangesCleared',
            data: expect.objectContaining({
              session_id: 'sA',
              turn_id: 'tA',
              cleared_count: 1,
            }),
          }),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------
  describe('destroy()', () => {
    it('should clear all changes', async () => {
      await tracker.addChange(makeChange({ changeId: 'd1' }));
      await tracker.addChange(makeChange({ changeId: 'd2' }));

      tracker.destroy();

      const changes = await tracker.getChanges({ includeRolledBack: true });
      expect(changes).toHaveLength(0);
    });

    it('should clear all snapshots', async () => {
      await tracker.addChange(
        makeChange({
          changeId: 'ds1',
          metadata: makeMetadata({ sessionId: 'sd', turnId: 'td' }),
        }),
      );
      await tracker.createSnapshot('sd', 'td');

      tracker.destroy();

      const snapshots = tracker.getAllSnapshots();
      expect(snapshots).toHaveLength(0);
    });

    it('should be safe to call destroy on an empty tracker', () => {
      expect(() => tracker.destroy()).not.toThrow();
    });

    it('should allow adding changes again after destroy', async () => {
      await tracker.addChange(makeChange({ changeId: 'pre-destroy' }));
      tracker.destroy();

      const result = await tracker.addChange(makeChange({ changeId: 'post-destroy' }));
      expect(result.changeId).toBe('post-destroy');

      const changes = await tracker.getChanges({});
      expect(changes).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Constructor / event emitter
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('should work without an event emitter', async () => {
      const noEmitTracker = new DiffTracker();

      const result = await noEmitTracker.addChange(makeChange());
      expect(result.status).toBe('applied');

      // Should not throw despite no emitter
      await noEmitTracker.getChanges({});
      await noEmitTracker.rollbackChanges({ changeId: 'change-1' });
      await noEmitTracker.clearChanges();
      noEmitTracker.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // diff calculation edge cases
  // -----------------------------------------------------------------------
  describe('diff calculation', () => {
    it('should handle string before/after values', async () => {
      const result = await tracker.addChange(
        makeChange({ before: 'old text', after: 'new longer text' }),
      );

      expect(result.diff.before).toBe('old text');
      expect(result.diff.after).toBe('new longer text');
      expect(result.diff.size).toBe(
        Math.abs(JSON.stringify('new longer text').length - JSON.stringify('old text').length),
      );
    });

    it('should handle numeric before/after values', async () => {
      const result = await tracker.addChange(
        makeChange({ before: 42, after: 100 }),
      );

      expect(result.diff.delta).toEqual({ type: 'update', from: 42, to: 100 });
    });

    it('should handle complex nested objects', async () => {
      const before = { users: [{ name: 'Alice' }] };
      const after = { users: [{ name: 'Alice' }, { name: 'Bob' }] };

      const result = await tracker.addChange(makeChange({ before, after }));

      expect(result.diff.before).toEqual(before);
      expect(result.diff.after).toEqual(after);
    });

    it('should compute size as zero when before and after have same serialized length', async () => {
      const result = await tracker.addChange(
        makeChange({ before: { a: 1 }, after: { b: 2 } }),
      );

      // {"a":1} and {"b":2} have the same length
      expect(result.diff.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Interaction between operations
  // -----------------------------------------------------------------------
  describe('cross-operation interactions', () => {
    it('should not include cleared changes in snapshots', async () => {
      await tracker.addChange(
        makeChange({
          changeId: 'cross-1',
          metadata: makeMetadata({ sessionId: 'si', turnId: 'ti' }),
        }),
      );
      await tracker.clearChanges('si', 'ti');

      const snapshot = await tracker.createSnapshot('si', 'ti');
      expect(snapshot.changes).toHaveLength(0);
    });

    it('should preserve snapshot array structure after rollback (shallow copy)', async () => {
      await tracker.addChange(
        makeChange({
          changeId: 'cross-snap',
          metadata: makeMetadata({ sessionId: 'sn', turnId: 'tn' }),
        }),
      );

      const snapshot = await tracker.createSnapshot('sn', 'tn');

      // The snapshot should contain the change
      expect(snapshot.changes).toHaveLength(1);
      expect(snapshot.changes[0].changeId).toBe('cross-snap');

      // Rollback the original change
      await tracker.rollbackChanges({ changeId: 'cross-snap' });

      // createSnapshot uses a shallow copy ([...sessionChanges]), so the
      // objects are shared references. Rolling back mutates the original
      // object, which is visible through the snapshot reference as well.
      expect(snapshot.changes[0].status).toBe('rolled_back');

      // However, the snapshot array itself is independent -- adding new
      // changes won't alter it.
      await tracker.addChange(
        makeChange({
          changeId: 'cross-snap-new',
          metadata: makeMetadata({ sessionId: 'sn', turnId: 'tn' }),
        }),
      );
      expect(snapshot.changes).toHaveLength(1);
    });

    it('should track many changes without error', async () => {
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          tracker.addChange(
            makeChange({
              changeId: `mass-${i}`,
              metadata: makeMetadata({ timestamp: i }),
            }),
          ),
        );
      }
      await Promise.all(promises);

      const changes = await tracker.getChanges({});
      expect(changes).toHaveLength(100);
    });
  });
});
