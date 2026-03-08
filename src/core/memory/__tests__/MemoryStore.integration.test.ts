import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeMemoryStore } from '@/server/storage/NodeMemoryStore';
import type { MemoryFact, MemoryConfig } from '@/core/memory/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('MemoryStore Integration (NodeMemoryStore)', () => {
    let store: NodeMemoryStore;
    let tempDir: string;
    let config: MemoryConfig;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-test-'));
        store = new NodeMemoryStore(tempDir);
        config = {
            enabled: true,
            embeddingProvider: 'openai',
            embeddingModel: 'text-embedding-3-small',
            embeddingDimensions: 4, // Use small dims for test
            databasePath: tempDir,
            maxMemories: 1000,
            coreMemoryPath: '',
        } as unknown as MemoryConfig;
        await store.initialize(config);
    });

    afterEach(async () => {
        await store.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const createMockFact = (id: string, text: string, category: any = 'general'): MemoryFact => ({
        id,
        factText: text,
        category,
        scope: {},
        contentHash: `hash-${id}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
    });

    it('initializes schema and vec0 tables correctly', async () => {
        const dims = await store.getSchemaDimensions();
        expect(dims).toBe(4);
        const count = await store.count();
        expect(count).toBe(0);
    });

    it('inserts and retrieves facts by id', async () => {
        const fact = createMockFact('1', 'Test fact');
        const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

        await store.insert(fact, embedding);

        const retrieved = await store.getById('1');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.factText).toBe('Test fact');

        const count = await store.count();
        expect(count).toBe(1);
    });

    it('performs KNN vector search correctly', async () => {
        // Insert 3 facts
        await store.insert(createMockFact('1', 'Fact A'), new Float32Array([1, 0, 0, 0]));
        await store.insert(createMockFact('2', 'Fact B'), new Float32Array([0, 1, 0, 0]));
        await store.insert(createMockFact('3', 'Fact C'), new Float32Array([0, 0, 1, 0]));

        // Search closest to [0.9, 0, 0, 0]
        const results = await store.search(new Float32Array([0.9, 0, 0, 0]), 2);

        expect(results).toHaveLength(2);
        expect(results[0].fact.id).toBe('1'); // Fact A Should be closest
        expect(results[1].distance).toBeGreaterThan(results[0].distance);
    });

    it('updates facts and their embeddings', async () => {
        const fact = createMockFact('1', 'Old fact');
        await store.insert(fact, new Float32Array([1, 0, 0, 0]));

        await store.update('1', { factText: 'New fact' }, new Float32Array([0, 1, 0, 0]));

        const retrieved = await store.getById('1');
        expect(retrieved?.factText).toBe('New fact');

        // Vector change check
        const results = await store.search(new Float32Array([0, 0.9, 0, 0]), 1);
        expect(results[0].fact.id).toBe('1');
    });

    it('deletes facts', async () => {
        const fact = createMockFact('1', 'Fact to delete');
        await store.insert(fact, new Float32Array([1, 0, 0, 0]));

        await store.delete('1');

        const retrieved = await store.getById('1');
        expect(retrieved).toBeNull();
        const count = await store.count();
        expect(count).toBe(0);
    });

    it('filters by categories', async () => {
        await store.insert(createMockFact('1', 'General fact 1', 'general'), new Float32Array([1, 0, 0, 0]));
        await store.insert(createMockFact('2', 'Preference fact 1', 'preference'), new Float32Array([0, 1, 0, 0]));
        await store.insert(createMockFact('3', 'Preference fact 2', 'preference'), new Float32Array([0, 0, 1, 0]));

        const prefs = await store.getByCategories(['preference']);
        expect(prefs).toHaveLength(2);

        const general = await store.getByCategories(['general']);
        expect(general).toHaveLength(1);
        expect(general[0].id).toBe('1');
    });

    it('updates access stats', async () => {
        await store.insert(createMockFact('1', 'Fact A'), new Float32Array([1, 0, 0, 0]));

        const before = await store.getById('1');
        expect(before?.accessCount).toBe(0);

        // Sleep 10ms to ensure timestamp difference
        await new Promise(r => setTimeout(r, 10));
        await store.updateAccessStats(['1']);

        const after = await store.getById('1');
        expect(after?.accessCount).toBe(1);
        expect(after!.lastAccessedAt).toBeGreaterThan(before!.lastAccessedAt);
    });

    it('logs history operations', async () => {
        await store.logOperation({
            id: 'op-1',
            memoryId: 'mem-1',
            event: 'ADD',
            oldContent: null,
            newContent: 'Fact 1',
            timestamp: Date.now()
        });

        const history = await store.getHistory('mem-1');
        expect(history).toHaveLength(1);
        expect(history[0].event).toBe('ADD');
        expect(history[0].newContent).toBe('Fact 1');

        const allHistory = await store.getAllHistory(10);
        expect(allHistory).toHaveLength(1);
    });

    it('migrates embedding dimensions correctly', async () => {
        // Current dimensions is 4
        await store.insert(createMockFact('1', 'Fact A'), new Float32Array([1, 0, 0, 0]));

        // Migrate to length 2
        await store.migrateDimensions(2);

        const dims = await store.getSchemaDimensions();
        expect(dims).toBe(2);

        const status = await store.getMigrationStatus();
        expect(status).toBe('PENDING');

        // Mark as COMPLETE
        await store.setMigrationStatus('COMPLETE');
        const newStatus = await store.getMigrationStatus();
        expect(newStatus).toBe('COMPLETE');

        // Vector operations on length 2 should now work
        await store.update('1', { factText: 'Fact A re-embedded' }, new Float32Array([0.5, 0.5]));
        const results = await store.search(new Float32Array([0.4, 0.4]), 1);
        expect(results).toHaveLength(1);
        expect(results[0].fact.id).toBe('1');
    });
});
