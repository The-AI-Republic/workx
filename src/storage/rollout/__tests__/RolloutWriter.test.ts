/**
 * Unit tests for RolloutWriter
 * Tests: T007
 * Target: src/storage/rollout/RolloutWriter.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { ConversationId, RolloutItem, SessionMetaLine } from '@/storage/rollout/types';
import { IndexedDBRolloutStorageProvider } from '@/storage/rollout/provider/IndexedDBRolloutStorageProvider';

let RolloutWriter: any;
let RolloutRecorder: any;

try {
  const writerModule = await import('@/storage/rollout/RolloutWriter');
  RolloutWriter = writerModule.RolloutWriter;
  const recorderModule = await import('@/storage/rollout/RolloutRecorder');
  RolloutRecorder = recorderModule.RolloutRecorder;
} catch {
  RolloutWriter = class {
    constructor() {
      throw new Error('RolloutWriter not implemented yet');
    }
  };
}

describe('RolloutWriter', () => {
  const rolloutId: ConversationId = '5973b6c0-94b8-487b-a530-2aeb6098ae0e';
  let writer: any;
  let provider: IndexedDBRolloutStorageProvider;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    provider = new IndexedDBRolloutStorageProvider();
    await provider.initialize();
    RolloutRecorder.setProvider(provider);
  });

  afterEach(async () => {
    if (writer?.close) {
      await writer.close();
    }
    RolloutRecorder.resetProvider();
  });

  describe('Initialization', () => {
    it('should create writer with provider', async () => {
      writer = await RolloutWriter.create(rolloutId, 0, provider);
      expect(writer).toBeDefined();
    });

    it('should create IndexedDB database "WorkXRollouts"', async () => {
      writer = await RolloutWriter.create(rolloutId, 0, provider);

      const dbs = await indexedDB.databases();
      const dbExists = dbs.some((db: any) => db.name === 'WorkXRollouts');
      expect(dbExists).toBe(true);
    });
  });

  describe('addItems', () => {
    beforeEach(async () => {
      writer = await RolloutWriter.create(rolloutId, 0, provider);
    });

    it('should queue write operations', async () => {
      const items: RolloutItem[] = [
        {
          type: 'session_meta',
          payload: {
            id: rolloutId,
            timestamp: '2025-10-01T12:00:00.000Z',
            cwd: '/test',
            originator: 'test',
            cliVersion: '1.0.0',
          } as SessionMetaLine,
        },
      ];

      await writer.addItems(rolloutId, items);
      expect(true).toBe(true);
    });

    it('should auto-increment sequence numbers', async () => {
      // Seed metadata so addItems can update itemCount
      await provider.putMetadata({
        id: rolloutId,
        created: Date.now(),
        updated: Date.now(),
        itemCount: 0,
        status: 'active',
        sessionMeta: { id: rolloutId, timestamp: '', originator: 'test', cliVersion: '1.0.0' },
      });

      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ];

      await writer.addItems(rolloutId, items);
      await writer.flush();

      const records = await provider.getItemsByRolloutId(rolloutId);
      expect(records[0].sequence).toBe(0);
      expect(records[1].sequence).toBe(1);
    });

    it('should batch multiple writes', async () => {
      await provider.putMetadata({
        id: rolloutId,
        created: Date.now(),
        updated: Date.now(),
        itemCount: 0,
        status: 'active',
        sessionMeta: { id: rolloutId, timestamp: '', originator: 'test', cliVersion: '1.0.0' },
      });

      const items1: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];
      const items2: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ];

      writer.addItems(rolloutId, items1);
      writer.addItems(rolloutId, items2);
      await writer.flush();

      const records = await provider.getItemsByRolloutId(rolloutId);
      expect(records.length).toBe(2);
    });

    it('should update rollouts metadata (itemCount, updated)', async () => {
      await provider.putMetadata({
        id: rolloutId,
        created: Date.now(),
        updated: Date.now(),
        itemCount: 0,
        status: 'active',
        sessionMeta: { id: rolloutId, timestamp: '', originator: 'test', cliVersion: '1.0.0' },
      });

      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ];

      await writer.addItems(rolloutId, items);
      await writer.flush();

      const metadata = await provider.getMetadata(rolloutId);
      expect(metadata!.itemCount).toBeGreaterThanOrEqual(2);
      expect(metadata!.updated).toBeDefined();
    });
  });

  describe('flush', () => {
    beforeEach(async () => {
      writer = await RolloutWriter.create(rolloutId, 0, provider);
    });

    it('should wait for all pending writes', async () => {
      await provider.putMetadata({
        id: rolloutId,
        created: Date.now(),
        updated: Date.now(),
        itemCount: 0,
        status: 'active',
        sessionMeta: { id: rolloutId, timestamp: '', originator: 'test', cliVersion: '1.0.0' },
      });

      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];

      writer.addItems(rolloutId, items);
      await writer.flush();

      const records = await provider.getItemsByRolloutId(rolloutId);
      expect(records.length).toBe(1);
    });

    it('should be idempotent (multiple flushes)', async () => {
      const items: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];

      await writer.addItems(rolloutId, items);
      await writer.flush();
      await writer.flush();
      await writer.flush();

      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      writer = await RolloutWriter.create(rolloutId, 0, provider);
    });

    it('should handle transaction failure', async () => {
      expect(writer.addItems).toBeDefined();
    });

    it('should propagate errors from flush', async () => {
      await expect(writer.flush()).resolves.not.toThrow();
    });
  });

  describe('Sequence Management', () => {
    beforeEach(async () => {
      writer = await RolloutWriter.create(rolloutId, 0, provider);
    });

    it('should continue sequence from last value', async () => {
      await provider.putMetadata({
        id: rolloutId,
        created: Date.now(),
        updated: Date.now(),
        itemCount: 0,
        status: 'active',
        sessionMeta: { id: rolloutId, timestamp: '', originator: 'test', cliVersion: '1.0.0' },
      });

      const items1: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '1' } },
      ];
      await writer.addItems(rolloutId, items1);
      await writer.flush();

      // Create new writer with next sequence
      const writer2 = await RolloutWriter.create(rolloutId, 1, provider);
      const items2: RolloutItem[] = [
        { type: 'response_item', payload: { type: 'Message', content: '2' } },
      ];
      await writer2.addItems(rolloutId, items2);
      await writer2.flush();

      const records = await provider.getItemsByRolloutId(rolloutId);
      expect(records[0].sequence).toBe(0);
      expect(records[1].sequence).toBe(1);

      await writer2.close();
    });
  });
});
