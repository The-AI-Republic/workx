import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnManager } from '../TurnManager';

describe('TurnManager Memory Integration', () => {
    let mockTurnContext: any;
    let mockSession: any;
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

    // Note: Core memory injection is now handled via PromptLoader prompt extensions
    // registered by RepublicAgent.initialize(), not by TurnManager directly.
    // Memory tools (save_memory, search_memory, forget_memory) are registered in
    // the ToolRegistry by RepublicAgent.initialize() and flow through the standard
    // tool execution path.

    it('does not inject memory context directly (handled by PromptLoader)', async () => {
        mockModelClient.stream.mockResolvedValue((async function* () {
            yield { type: 'Completed', tokenUsage: { inputTokens: 10, outputTokens: 10 } };
        })());

        await turnManager.runTurn([]);

        // TurnManager passes base instructions as-is — no memory injection
        expect(mockModelClient.stream).toHaveBeenCalledWith(
            expect.objectContaining({
                base_instructions_override: 'Base instructions.',
            })
        );
    });
});
