import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnManager } from '../TurnManager';
import { TurnContext } from '../TurnContext';
import { Session } from '../Session';

describe('TurnManager Memory Integration', () => {
    let mockTurnContext: any;
    let mockSession: any;
    let mockMemoryService: any;
    let mockModelClient: any;
    let turnManager: TurnManager;

    beforeEach(() => {

        mockModelClient = {
            stream: vi.fn(),
            getSelectedModelKey: vi.fn().mockReturnValue('openai:test-model'),
        };

        mockTurnContext = {
            getBaseInstructions: vi.fn().mockReturnValue('Base instructions.'),
            getUserInstructions: vi.fn().mockReturnValue('User instructions.'),
            getModelClient: vi.fn().mockReturnValue(mockModelClient),
            getTools: vi.fn().mockReturnValue([]),
            getToolsConfig: vi.fn().mockReturnValue({ enabled: {} }),
            getSelectedModelKey: vi.fn().mockReturnValue('openai:test-model'),
            getSessionId: vi.fn().mockReturnValue('test-session-id'),
        };

        mockMemoryService = {
            getFormattedGlobalContext: vi.fn().mockResolvedValue('Global Memory Facts here.'),
            processConversation: vi.fn().mockResolvedValue(undefined),
        };

        mockSession = {
            getMemoryService: vi.fn().mockReturnValue(mockMemoryService),
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

    it('injects core memories into the prompt before execution', async () => {
        mockModelClient.stream.mockResolvedValue((async function* () {
            yield { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } };
        })());

        await turnManager.runTurn([]);

        expect(mockMemoryService.getFormattedGlobalContext).toHaveBeenCalledTimes(1);

        // Verify stream was called with the injected instructions
        expect(mockModelClient.stream).toHaveBeenCalledWith(
            expect.objectContaining({
                base_instructions_override: 'Base instructions.\n\nGlobal Memory Facts here.',
            })
        );
    });

    it('tolerates getFormattedGlobalContext failures without crashing', async () => {
        mockMemoryService.getFormattedGlobalContext.mockRejectedValue(new Error('Memory load failed'));

        // Mute console.warn for the test
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        mockModelClient.stream.mockResolvedValue((async function* () {
            yield { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } };
        })());

        await turnManager.runTurn([]);

        // Stream should still be called with default base instructions
        expect(mockModelClient.stream).toHaveBeenCalledWith(
            expect.objectContaining({
                base_instructions_override: 'Base instructions.',
            })
        );

        warnSpy.mockRestore();
    });

    it('fires fireMemoryExtraction asynchronously after the turn completes', async () => {
        // C4: User messages now come from the input array, assistant from stream output
        const streamItems = [
            {
                type: 'OutputItemDone',
                item: { type: 'message', role: 'assistant', content: 'Hello Alice! I will remember that.' }
            },
            { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } }
        ];

        mockModelClient.stream.mockResolvedValue((async function* () {
            for (const event of streamItems) {
                yield event;
            }
        })());

        // Pass user message as input (C4 fix: input is now the source of user messages)
        await turnManager.runTurn(['Hello agent, my name is Alice.']);

        // Memory extraction is fire-and-forget, so it takes a microtask.
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockMemoryService.processConversation).toHaveBeenCalledTimes(1);
        expect(mockMemoryService.processConversation).toHaveBeenCalledWith(
            [
                { role: 'user', content: 'Hello agent, my name is Alice.' },
                { role: 'assistant', content: 'Hello Alice! I will remember that.' }
            ],
            { userId: 'default-user' }  // C5: stable user ID
        );
    });

    it('tolerates processConversation extraction failures without crashing', async () => {
        mockMemoryService.processConversation.mockRejectedValue(new Error('Extraction failed'));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        mockModelClient.stream.mockResolvedValue((async function* () {
            yield { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } };
        })());

        // C4: Pass user message via input array
        await expect(turnManager.runTurn(['Hello'])).resolves.not.toThrow();

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(warnSpy).toHaveBeenCalledWith(
            '[TurnManager] Memory extraction failed (non-critical):',
            expect.any(Error)
        );

        warnSpy.mockRestore();
    });
});
