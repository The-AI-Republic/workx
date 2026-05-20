import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnManager } from '../TurnManager';
import { setConfigStorage, type ConfigStorageProvider } from '../storage/ConfigStorageProvider';

// Stub PromptLoader so the test does not depend on the bundled default prompt
// and we can prove TurnManager pulls fresh base instructions per turn.
vi.mock('../PromptLoader', () => ({
    loadPrompt: vi.fn(),
    loadUserInstructions: vi.fn().mockResolvedValue('User instructions.'),
}));

import { loadPrompt } from '../PromptLoader';

describe('TurnManager Memory Integration', () => {
    let mockTurnContext: any;
    let mockSession: any;
    let mockModelClient: any;
    let turnManager: TurnManager;

    beforeEach(() => {
        const storageData = new Map<string, unknown>();
        const configStorage: ConfigStorageProvider = {
            async get<T>(key: string): Promise<T | null> {
                return storageData.has(key) ? (storageData.get(key) as T) : null;
            },
            async set<T>(key: string, value: T): Promise<void> {
                storageData.set(key, value);
            },
            async remove(key: string): Promise<void> {
                storageData.delete(key);
            },
            async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
                const result: Record<string, T> = {};
                for (const key of keys) {
                    if (storageData.has(key)) result[key] = storageData.get(key) as T;
                }
                return result;
            },
            async setMany<T = unknown>(items: Record<string, T>): Promise<void> {
                for (const [key, value] of Object.entries(items)) {
                    storageData.set(key, value);
                }
            },
            async removeMany(keys: string[]): Promise<void> {
                for (const key of keys) storageData.delete(key);
            },
            async getAll(): Promise<Record<string, unknown>> {
                return Object.fromEntries(storageData);
            },
            async clear(): Promise<void> {
                storageData.clear();
            },
            async getBytesInUse(): Promise<number> {
                return 0;
            },
        };
        setConfigStorage(configStorage);

        (loadPrompt as any).mockReset();
        (loadPrompt as any).mockResolvedValue('Base instructions.');

        mockModelClient = {
            stream: vi.fn(),
            getSelectedModelKey: vi.fn().mockReturnValue('openai:test-model'),
        };

        mockTurnContext = {
            getBaseInstructions: vi.fn().mockReturnValue('STALE INSTRUCTIONS'),
            getUserInstructions: vi.fn().mockReturnValue('User instructions.'),
            getModelClient: vi.fn().mockReturnValue(mockModelClient),
            getTools: vi.fn().mockReturnValue([]),
            getToolsConfig: vi.fn().mockReturnValue({ enabled: {} }),
            getSelectedModelKey: vi.fn().mockReturnValue('openai:test-model'),
            getSessionId: vi.fn().mockReturnValue('test-session-id'),
            getAgentMode: vi.fn().mockReturnValue('general'),
            getUnattended: vi.fn().mockReturnValue(false),
            getUnattendedResetCapMs: vi.fn().mockReturnValue(undefined),
            setActiveToolAllowList: vi.fn(),
        };

        mockSession = {
            getMemoryService: vi.fn().mockReturnValue(null),
            getToolRegistry: vi.fn().mockReturnValue(null),
            showRawAgentReasoning: vi.fn().mockReturnValue(false),
        };
        const mockToolRegistry = { listTools: vi.fn().mockReturnValue([]) };
        turnManager = new TurnManager(mockSession as any, mockTurnContext as any, mockToolRegistry as any, { maxRetries: 0 } as any);

        // Mock private emits to avoid crashing
        (turnManager as any).emitEvent = vi.fn().mockResolvedValue(undefined);
        (turnManager as any).recordTurnContext = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // Note: Core memory injection is handled by PromptLoader prompt extensions
    // (registered by RepublicAgent). TurnManager reloads the prompt per turn so
    // newly saved / forgotten core memories take effect immediately.

    it('reloads the system prompt per turn so memory injection is fresh', async () => {
        mockModelClient.stream.mockResolvedValue((async function* () {
            yield { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } };
        })());

        await turnManager.runTurn([]);

        expect(loadPrompt).toHaveBeenCalledTimes(1);
        expect(mockModelClient.stream).toHaveBeenCalledWith(
            expect.objectContaining({
                // Comes from loadPrompt() — the cached value on TurnContext is ignored.
                base_instructions_override: 'Base instructions.',
            })
        );
    });

    it('falls back to TurnContext.getBaseInstructions when loadPrompt throws', async () => {
        (loadPrompt as any).mockRejectedValueOnce(new Error('compose failure'));
        mockModelClient.stream.mockResolvedValue((async function* () {
            yield { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } };
        })());

        await turnManager.runTurn([]);

        expect(mockModelClient.stream).toHaveBeenCalledWith(
            expect.objectContaining({
                base_instructions_override: 'STALE INSTRUCTIONS',
            })
        );
    });
});
