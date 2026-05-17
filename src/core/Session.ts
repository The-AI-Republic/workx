/**
 * Session management class
 * Manages conversation state, turn context, and history
 *
 * REFACTORED: Now uses SessionState, SessionServices, and ActiveTurn for better organization
 * while maintaining full backward compatibility
 */

import type { InputItem, AskForApproval, SandboxPolicy, ReasoningEffortConfig, ReasoningSummaryConfig, Event, ResponseItem, ConversationHistory, ReviewDecision } from './protocol/types';
import { mapResponseItemToEventMessages } from './events/EventMapping';
import type { EventMsg } from './protocol/events';
import { RolloutRecorder, type RolloutItem } from '../storage/rollout';
import { v4 as uuidv4 } from 'uuid';
import { TurnContext } from './TurnContext';
import { AgentConfig } from '../config/AgentConfig';
import type { SessionTask } from './tasks/SessionTask';
import type { ToolRegistry } from '../tools/ToolRegistry';

// New state management imports
import { SessionState, type SessionStateExport } from './session/state/SessionState';
import { type SessionServices, createSessionServices } from './session/state/SessionServices';
import { ActiveTurn } from './session/state/ActiveTurn';
import type { TokenUsageInfo, RunningTask, RateLimitSnapshot, TurnAbortReason, InitialHistory } from './session/state/types';
import { TaskKind } from './session/state/types';
import { toRateLimitSnapshotEvent, evaluateEarlyWarning } from './models/types/RateLimits';
import { isDOMSnapshotOutput, compressSnapshot } from './session/state/SnapshotCompressor';
import type { HookDispatcher } from './hooks/HookDispatcher';

// Compaction imports
import { CompactService } from './compact/CompactService';
import type { CompactionResult, CompactionTrigger } from './compact/types';
import { estimateRequestTokens } from './compact/utils';
import type { ModelClient } from './models/ModelClient';

// Memory system
import type { MemoryService } from './memory/MemoryService';
import { createMemoryService } from './memory/createMemoryService';

// Track 05b: session summary auto-extraction
import type {
  PostTurnContext,
  SessionSummaryHook,
} from './sessionSummary/SessionSummaryHook';

/**
 * Post-turn hook signature. Owned by Session because TurnManager is per-task
 * but hooks (notably the session-summary extractor) live the length of the
 * session. TurnManager fires hooks via `session.firePostTurnHooks(ctx)`.
 */
export type PostTurnHook = (ctx: PostTurnContext) => Promise<void> | void;

/** Lightweight alias so the field declaration doesn't pull the full class. */
type SessionSummaryHookHandle = SessionSummaryHook;

// Title generation imports
import { TitleGenerator } from './title';
import { PromptSuggestionGenerator } from './suggestions/promptSuggestion';
import { SUGGESTION_COOLDOWN_MS } from './suggestions/constants';

// Track 04: typed tasks
import type { BackgroundAgentTaskState, TaskState } from './tasks/types';
import { isTerminalTaskStatus } from './tasks/types';
import type { AgentContext } from '../tools/AgentTool/types';
import { PANEL_GRACE_MS, STOPPED_DISPLAY_MS } from './tasks/timing';
import type { TaskOutputStore } from './tasks/TaskOutputStore';

// Track 09: tool result persistence
import {
  createToolResultStore,
  type ToolResultStore,
} from '../tools/resultStore';
import {
  ContentReplacementState,
  type ContentReplacementRecord,
} from '../tools/replacementState';

/**
 * Execution state of the session
 */
export type ExecutionState =
  | 'idle'           // Waiting for input
  | 'processing'     // Processing a submission
  | 'executing'      // Executing a task
  | 'waiting'        // Waiting for approval
  | 'interrupted'    // Interrupted by user
  | 'error';         // Error state

/**
 * Session class managing conversation state
 */
export class Session {
  readonly sessionId: string;
  private config?: AgentConfig;
  private sessionState: SessionState; // Pure data state
  private services: SessionServices | null = null; // Service collection
  private activeTurn: ActiveTurn | null = null; // Active turn management
  private turnContext: TurnContext;
  private _mockCwd = '/'; // For backward compatibility in tests
  private eventEmitter: ((event: Event) => Promise<void>) | null = null;
  private isPersistent: boolean = true;
  private toolRegistry: ToolRegistry | null = null; // Tool registry from RepublicAgent

  // Runtime state (not persisted, lives in Session only)
  private toolUsageStats: Map<string, number> = new Map();
  private errorHistory: Array<{ timestamp: number, error: string, context?: any }> = [];
  private interruptRequested: boolean = false;
  private compactService: CompactService;
  private titleGenerator: TitleGenerator;
  private suggestionGenerator: PromptSuggestionGenerator;
  private suggestionInFlight = false;
  private lastSuggestionAt = 0;
  private _memoryService: MemoryService | null = null;

  // ─── Track 04: typed task registry ────────────────────────────────────
  /**
   * Cross-turn registry of every tracked task (foreground + background).
   * Lives alongside `activeTurn` which still holds foreground-only turn
   * state (approvals, pending input). See design.md §Concurrency Seam.
   */
  private activeTasks: Map<string, RunningTask> = new Map();
  /** Single-valued pointer to the currently-foreground task, if any. */
  private foregroundTaskId: string | null = null;
  /** Lazily-started eviction timer that walks `activeTasks` for terminal tasks. */
  private evictionTimerId: ReturnType<typeof setInterval> | null = null;
  /** Optional output store shared with background sub-agent task runners. */
  private taskOutputStore: TaskOutputStore | null = null;
  // Title generation stage: 0 = not started, 1 = generated at 2 messages, 2 = generated at 5 messages (final)
  private titleGenerationStage: number = 0;
  private initializationPromise: Promise<void> | null = null;
  private hookDispatcher: HookDispatcher | null = null;

  // Track 05b: per-session post-turn callbacks (e.g. session-summary
  // extractor). TurnManager is created per-task; the callback list lives on
  // Session so listeners survive across multiple TurnManager instances.
  // The session-summary hook itself is owned here and disposed in shutdown().
  private postTurnHooks: PostTurnHook[] = [];
  private _sessionSummaryHook: SessionSummaryHookHandle | null = null;

  // Tool result persistence (track 09). Both fields are undefined when the
  // platform deps required to build a store aren't available — TurnManager
  // detects that and short-circuits persistence, falling back to passthrough.
  private toolResultStore: ToolResultStore | undefined;
  private replacementState: ContentReplacementState | undefined;

  constructor(
    configOrIsPersistent?: AgentConfig | boolean,
    isPersistent?: boolean,
    services?: SessionServices,
    toolRegistry?: ToolRegistry,
    initialHistory?: InitialHistory
  ) {
    // For resumed mode, use the provided sessionId; otherwise generate a new one
    if (initialHistory?.mode === 'resumed' && initialHistory.sessionId) {
      this.sessionId = initialHistory.sessionId;
    } else {
      this.sessionId = uuidv4();
      if (!this.sessionId) {
        this.sessionId = crypto.randomUUID();
      }
    }

    // Handle both new and old signatures for backward compatibility
    if (typeof configOrIsPersistent === 'boolean') {
      // Old signature: Session(isPersistent?: boolean)
      this.isPersistent = configOrIsPersistent;
      this.config = undefined;
    } else {
      // New signature: Session(config?: AgentConfig, isPersistent?: boolean, services?: SessionServices, toolRegistry?: ToolRegistry, initialHistory?: InitialHistory)
      this.config = configOrIsPersistent;
      this.isPersistent = isPersistent ?? true;
    }

    // Initialize session state
    this.sessionState = new SessionState(); // Pure data state
    this.toolRegistry = toolRegistry ?? null; // Tool registry from RepublicAgent
    this.compactService = new CompactService(); // Initialize compaction service
    this.titleGenerator = new TitleGenerator(); // Initialize title generation service
    this.suggestionGenerator = new PromptSuggestionGenerator(); // Track 24.3

    // Initialize services (merged from initialize() method)
    if (services) {
      this.services = services;
    } else {
      // For synchronous construction, set to null and create on-demand
      this.services = null;
    }

    // Initialize with default turn context, using config values if available
    // Initialize with a dummy context for immediate access (will be properly initialized in initializeSession)
    const dummyClient = {
      _model: 'gpt-4',
      getModel: function () { return (this as any)._model; },
      setModel: function (m: string) { (this as any)._model = m; },
      getReasoningEffort: () => undefined,
      setReasoningEffort: () => { },
      getReasoningSummary: () => undefined,
      setReasoningSummary: () => { },
    } as any;
    this.turnContext = new TurnContext(dummyClient, {
      sessionId: this.sessionId,
      approvalPolicy: 'on-request',
      sandboxPolicy: { mode: 'workspace-write' },
    });

    this.activeTurn = new ActiveTurn();

    // Session starts with no tab binding (tabId = -1)
    // Tab binding is handled by the UI when the side panel opens
    this.sessionState.setTabId(-1);

    // Tool result persistence wiring (track 09).
    //
    // The replacementState's onRecord callback writes every persisted decision
    // to the rollout recorder so it survives resume — preserving prompt-cache
    // stability across replays.
    //
    // The store is platform-dependent. If the required deps aren't present
    // (e.g. SessionCacheManager not provided), we leave both fields undefined;
    // TurnManager treats that as "feature off" and passes results through
    // unmodified.
    this.replacementState = new ContentReplacementState({
      onRecord: (rec: ContentReplacementRecord) => {
        const rollout = this.services?.rollout;
        if (!rollout) return;
        rollout
          .recordItems([{ type: 'content_replacement', payload: rec }])
          .catch((err) => {
            console.error('[Session] Failed to record content_replacement:', err);
          });
      },
    });
    try {
      this.toolResultStore = createToolResultStore({
        cache: this.services?.sessionCache,
        serverRootDir: this.services?.serverRootDir,
      });
    } catch (err) {
      // Missing dep for this platform is normal during early bootstrap or
      // tests — log once and continue without persistence.
      console.warn(
        '[Session] Tool result persistence disabled:',
        err instanceof Error ? err.message : err,
      );
      this.toolResultStore = undefined;
    }

    // Handle initial history
    const historyMode = initialHistory ?? { mode: 'new' as const };


    // For 'new' mode, SessionState is already initialized with empty history
    // Initialize session with RolloutRecorder based on history mode (asynchronous)
    // Note: We call initializeSession without await since constructor must be synchronous
    // The initialization happens in the background
    if (this.isPersistent && (historyMode.mode === 'new' || historyMode.mode === 'forked')) {
      // Create new rollout
      this.initializationPromise = this.initializeSession('create', this.sessionId, this.config).then(() => {
        // For forked mode, reconstruct THEN persist the forked history after
        // the new rollout is created. recordInitialHistory() does
        // reconstructHistoryFromRollout() -> persistRolloutResponseItems();
        // this is its sole correct caller (Track 15, Phase 0a — previously
        // this branch persisted an empty sessionState because nothing
        // reconstructed historyMode.rolloutItems first).
        if (historyMode.mode === 'forked') {
          return this.recordInitialHistory(historyMode);
        }
      }).catch(err => {
        console.error('Failed to initialize session:', err);
      });
    } else if (this.isPersistent && historyMode.mode === 'resumed') {
      // Resume from existing rollout (note: initializeSession will also reconstruct history)
      this.initializationPromise = this.initializeSession('resume', this.sessionId, this.config).catch(err => {
        console.error('Failed to resume session:', err);
      });
    } else if (!this.isPersistent && historyMode.mode !== 'new') {
      // Child/forked sessions are non-persistent but still need the provided
      // in-memory history before the first turn runs.
      this.initializationPromise = this.recordInitialHistory(historyMode).catch(err => {
        console.error('Failed to initialize non-persistent session history:', err);
      });
    }
  }


  /**
   * Get or create a conversation in storage using RolloutRecorder
   */
  private async getOrCreateConversation(): Promise<string> {
    if (!this.services?.rollout) {
      return this.sessionId;
    }

    // For RolloutRecorder, we don't need to list/find conversations
    // The sessionId is already set and RolloutRecorder handles persistence
    return this.sessionId;
  }

  /**
   * Save current session state to storage using RolloutRecorder
   */
  async saveState(): Promise<void> {
    if (!this.services?.rollout) return;

    // Record session metadata to rollout
    // Include both cwd (for desktop) and tabId (for extension) so the
    // session can be restored correctly in either runtime mode.
    const tabId = this.sessionState.getTabId();
    const sessionMetaItems: RolloutItem[] = [{
      type: 'session_meta',
      payload: {
        id: this.sessionId,
        timestamp: new Date().toISOString(),
        ...(tabId > 0 ? { tabId } : {}),
        originator: 'chrome-extension',
        cliVersion: '1.0.0'
      }
    }];

    try {
      await this.services.rollout.recordItems(sessionMetaItems);
    } catch (error) {
      console.error('Failed to save session state to rollout:', error);
    }
  }

  /**
   * Set the turn context (replaces the existing context)
   */
  setTurnContext(context: TurnContext): void {
    // Ensure the turn context has the correct session ID
    if (context.getSessionId() !== this.sessionId) {
      context.update({ sessionId: this.sessionId });
    }
    this.turnContext = context;
  }

  /**
   * Update turn context with new values
   */
  updateTurnContext(updates: any): void {
    if (this.turnContext && typeof this.turnContext.update === 'function') {
      this.turnContext.update(updates);
      if (updates.cwd) {
        this._mockCwd = updates.cwd;
      }
    }
  }

  /**
   * Get current turn context
   */
  getTurnContext(): TurnContext {
    return this.turnContext;
  }

  /**
   * Add a message to history using RolloutRecorder
   */
  async addToHistory(entry: { timestamp: number; text: string; type: 'user' | 'agent' | 'system' }): Promise<void> {
    // Convert to ResponseItem
    const responseItem: ResponseItem = {
      type: 'message',
      role: entry.type === 'user' ? 'user' : entry.type === 'system' ? 'system' : 'assistant',
      content: [{
        type: entry.type === 'user' || entry.type === 'system' ? 'input_text' : 'output_text',
        text: entry.text
      }],
    };

    // Use recordConversationItemsDual for dual persistence
    await this.recordConversationItemsDual([responseItem]);
  }

  /**
   * Get conversation history as ConversationHistory
   */
  getConversationHistory(): ConversationHistory {
    return this.sessionState.getConversationHistory();
  }

  /**
   * Get history entry by offset
   * @param offset Negative offset from end of history
   */
  getHistoryEntry(offset: number): ResponseItem | undefined {
    const items = this.sessionState.historySnapshot();
    if (offset >= 0 || Math.abs(offset) > items.length) {
      return undefined;
    }
    return items[items.length + offset];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.sessionState = new SessionState();
  }

  /**
   * Get current message count (derived from session state)
   */
  getMessageCount(): number {
    return this.sessionState.historySnapshot().length;
  }


  /**
   * Export session for persistence
   * Uses SessionState export structure
   */
  export(): {
    id: string;
    state: SessionStateExport;
    metadata: {
      created: number;
      lastAccessed: number;
      messageCount: number;
    };
  } {
    return {
      id: this.sessionId,
      state: this.sessionState.export(),
      metadata: {
        created: this.sessionState.getConversationHistory().metadata?.startTime || Date.now(),
        lastAccessed: Date.now(),
        messageCount: this.getMessageCount(),
      },
    };
  }

  /**
   * Import session from persistence
   */
  static import(data: {
    id: string;
    state: SessionStateExport;
    metadata: {
      created: number;
      lastAccessed: number;
      messageCount?: number; // Optional for backward compatibility
    };
  }, services?: SessionServices, toolRegistry?: ToolRegistry): Session {
    // Create session with resumed history mode (no rollout items since we're importing directly)
    const initialHistory: InitialHistory = { mode: 'new' }; // Use 'new' mode since we're setting state directly
    const session = new Session(undefined, true, services, toolRegistry, initialHistory);

    // Import SessionState
    session.sessionState = SessionState.import(data.state);

    Object.assign(session, {
      sessionId: data.id,
    });

    return session;
  }

  /**
   * Check if session is empty
   */
  isEmpty(): boolean {
    return this.sessionState.getConversationHistory().items.length === 0;
  }

  /**
   * Estimate token count of the current conversation history.
   */
  estimateHistoryTokens(): number {
    return estimateRequestTokens(this.sessionState.getConversationHistory().items);
  }

  /**
   * Get last message from history
   */
  getLastMessage(): ResponseItem | undefined {
    const items = this.sessionState.historySnapshot();
    return items[items.length - 1];
  }

  /**
   * Get messages by type
   */
  getMessagesByType(type: 'user' | 'agent' | 'system'): ResponseItem[] {
    const role = type === 'user' ? 'user' : type === 'system' ? 'system' : 'assistant';
    return this.sessionState.historySnapshot().filter(item => item.type === 'message' && item.role === role);
  }

  /**
   * Set event emitter for sending events to the queue
   */
  setEventEmitter(emitter: (event: Event) => Promise<void>): void {
    this.eventEmitter = emitter;
  }

  /**
   * Set the hook dispatcher for task lifecycle hooks.
   */
  setHookDispatcher(dispatcher: HookDispatcher): void {
    this.hookDispatcher = dispatcher;
  }

  /**
   * Get the hook dispatcher (for passing to TurnManager).
   */
  getHookDispatcher(): HookDispatcher | null {
    return this.hookDispatcher;
  }

  /**
   * Emit an event
   */
  async emitEvent(event: Event): Promise<void> {
    if (this.eventEmitter) {
      await this.eventEmitter(event);
    } else {
      console.warn('Event emitter not set, event dropped:', event);
    }
  }

  /**
   * Get session ID (conversation ID)
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Track 18: fold a task's USD cost into the cumulative session total.
   * Delegated to SessionState so it persists in the session export and is
   * restored on resume. Called once per task from TaskRunner.persistTokenUsage.
   */
  addCost(usd: number, estimated: boolean): void {
    this.sessionState.addCost(usd, estimated);
  }

  /**
   * Track 18: cumulative USD cost for this session (live total) and whether
   * any of it was priced via the fallback rate. Backs the /cost surface.
   */
  getCostInfo(): { cumulativeCostUSD: number; hasUnknownModelCost: boolean } {
    return this.sessionState.getCostInfo();
  }

  // ─── Track 05b: post-turn hooks + session-summary hook ──────────────────

  /**
   * Register a callback that fires after every successful turn (after the
   * `Completed` event in TurnManager). Returns an unregister function.
   *
   * Errors thrown inside hooks are swallowed by firePostTurnHooks so a
   * misbehaving hook can't break the turn.
   */
  registerPostTurnHook(fn: PostTurnHook): () => void {
    this.postTurnHooks.push(fn);
    return () => {
      const i = this.postTurnHooks.indexOf(fn);
      if (i >= 0) this.postTurnHooks.splice(i, 1);
    };
  }

  /**
   * Fire all registered post-turn hooks. Called by TurnManager's `Completed`
   * case. Sequential await preserves ordering; errors are caught per-hook.
   */
  async firePostTurnHooks(ctx: PostTurnContext): Promise<void> {
    if (this.postTurnHooks.length === 0) return;
    for (const hook of this.postTurnHooks) {
      try {
        await hook(ctx);
      } catch (err) {
        console.warn(
          '[Session] postTurnHook failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /** Attach the session-summary hook (constructed by RepublicAgent). */
  setSessionSummaryHook(hook: SessionSummaryHookHandle | null): void {
    this._sessionSummaryHook = hook;
  }

  /** Read access for tests, manual extraction, and the compaction interlock. */
  getSessionSummaryHook(): SessionSummaryHookHandle | null {
    return this._sessionSummaryHook;
  }

  /**
   * Compatibility: Initialize session components
   * Note: Refactored Session initializes in constructor, this is for backward compatibility
   */
  async initialize(): Promise<void> {
    // Wait for background initialization if it's in progress
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
    return Promise.resolve();
  }

  /**
   * Compatibility: Get current turn items
   */
  getCurrentTurnItems(): InputItem[] {
    return this.activeTurn?.takePendingInput() || [];
  }

  /**
   * Compatibility: Set current turn items
   */
  setCurrentTurnItems(items: InputItem[]): void {
    if (this.activeTurn) {
      this.activeTurn.clearPending();
      for (const item of items) {
        this.activeTurn.pushPendingInput(item);
      }
    }
  }

  /**
   * Compatibility: Clear current turn items
   */
  clearCurrentTurn(): void {
    this.activeTurn?.clearPending();
  }

  /**
   * Record input items in conversation
   */
  async recordInput(items: InputItem[]): Promise<void> {
    const timestamp = Date.now();

    for (const item of items) {
      let text = '';

      switch (item.type) {
        case 'text':
          text = item.text;
          break;
        case 'image':
          text = '[image]';
          break;
        case 'clipboard':
          text = item.content || '[clipboard]';
          break;
        case 'context':
          text = `[context: ${item.path || 'unknown'}]`;
          break;
        default:
          text = '[unknown input]';
      }

      await this.addToHistory({
        timestamp,
        text,
        type: 'user',
      });
    }
  }

  /**
   * Get pending user input during turn execution
   * Delegates to ActiveTurn if turn is active, otherwise returns empty array
   */
  async getPendingInput(): Promise<any[]> {
    if (this.activeTurn) {
      // Delegate to ActiveTurn
      const pending = this.activeTurn.takePendingInput();
      return pending.map(item => this.convertInputToResponse(item));
    } else {
      // No active turn, return empty array
      return [];
    }
  }

  /**
   * Add pending input (for interrupting turns)
   * Delegates to ActiveTurn if turn is active, otherwise ignores input
   */
  addPendingInput(items: InputItem[]): void {
    if (this.activeTurn) {
      // Delegate to ActiveTurn
      items.forEach(item => this.activeTurn!.pushPendingInput(item));
    }
  }

  /**
   * Convert input item to response format
   */
  private convertInputToResponse(item: InputItem): any {
    switch (item.type) {
      case 'text':
        return {
          role: 'user',
          content: [{ type: 'input_text', text: item.text }],
        };
      case 'image':
        return {
          role: 'user',
          content: [{ type: 'input_image', image_url: item.image_url }],
        };
      case 'clipboard':
        return {
          role: 'user',
          content: [{ type: 'input_text', text: item.content || '[clipboard]' }],
        };
      case 'context':
        return {
          role: 'user',
          content: [{ type: 'input_text', text: `[context: ${item.path || 'unknown'}]` }],
        };
      default:
        return {
          role: 'user',
          content: [{ type: 'input_text', text: '[unknown]' }],
        };
    }
  }

  /**
   * Build turn input with full conversation history
   */
  async buildTurnInputWithHistory(newItems: any[]): Promise<any[]> {
    const conversationHistory = this.sessionState.getConversationHistory();
    // Items are already in ResponseItem format, no conversion needed
    const historyItems = conversationHistory.items;

    return [...historyItems, ...newItems];
  }


  /**
   * Compact conversation history using LLM-based summarization
   * Requires modelClient - if not provided, no compaction occurs
   *
   * @param trigger - What triggered the compaction ('auto' or 'manual')
   * @param modelClient - Model client for LLM-based summarization (required for compaction)
   * @returns CompactionResult with metrics
   */
  async compact(
    trigger: CompactionTrigger = 'auto',
    modelClient?: ModelClient
  ): Promise<CompactionResult> {
    const items = this.sessionState.historySnapshot();
    const tokenInfo = this.getTokenUsageInfo();
    const tokensBefore = tokenInfo?.total_tokens ?? 0;

    // If no modelClient provided, do not compact - return without changes
    if (!modelClient) {
      console.warn('[Session] compact() called without modelClient - skipping compaction');
      return {
        success: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        itemsTrimmed: 0,
        retriesUsed: 0,
        triggerReason: trigger,
        error: 'No modelClient provided for LLM-based summarization',
      };
    }

    // Get base instructions from turn context (same as TurnManager does for normal turns)
    const baseInstructions = this.turnContext?.getBaseInstructions?.();

    // Use CompactService for LLM-based compaction.
    // Track 05b: thread sessionId + sessionSummaryHook so the service can
    // (a) await any in-flight summary extraction before destructively
    // rewriting history, and (b) fold the cached summary into the
    // summarization prompt as a hint.
    const result = await this.compactService.compact(
      items,
      trigger,
      modelClient,
      tokensBefore,
      baseInstructions,
      {
        sessionId: this.sessionId,
        sessionSummaryHook: this._sessionSummaryHook,
      },
    );

    if (result.success && result.newHistory) {
      // Replace history with compacted version from CompactService
      this.sessionState.replaceHistory(result.newHistory);

      // Update compaction state
      const tokensSaved = result.tokensBefore - result.tokensAfter;
      this.sessionState.incrementCompactionCount(tokensSaved);
    }

    return result;
  }

  /**
   * Check if compaction should be triggered based on current token usage
   *
   * @param contextWindow - Model's context window size
   * @returns true if compaction should be triggered
   */
  shouldCompact(contextWindow: number): boolean {
    const tokenInfo = this.getTokenUsageInfo();
    const currentTokens = tokenInfo?.total_tokens ?? 0;
    return this.compactService.shouldCompact(currentTokens, contextWindow);
  }

  /**
   * Get compaction count for this session
   */
  getCompactionCount(): number {
    return this.sessionState.getCompactionCount();
  }

  /**
   * Build initial context for review mode
   */
  buildInitialContext(turnContext?: any): any[] {
    // Replaced working directory with tab context
    const tabId = turnContext?.tabId ?? -1;
    const tabContext = tabId === -1 ? 'No tab bound' : `Tab ID: ${tabId}`;

    return [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `Browser tab context: ${tabContext}`,
          },
        ],
      },
    ];
  }

  /**
   * Search messages in conversation history
   */
  async searchMessages(query: string): Promise<ResponseItem[]> {
    return this.sessionState.historySnapshot().filter(item => {
      const content = item.type === 'message'
        ? (typeof item.content === 'string' ? item.content : JSON.stringify(item.content))
        : JSON.stringify(item);
      return content.toLowerCase().includes(query.toLowerCase());
    });
  }

  /**
   * Export session with storage persistence using RolloutRecorder
   */
  async exportWithStorage(): Promise<any> {
    const baseExport = this.export();

    if (!this.services?.rollout) {
      return baseExport;
    }

    // Get rollout statistics if available
    let rolloutStats = null;
    try {
      // RolloutRecorder might have a getStatistics method or similar
      // For now, we'll return basic info
      rolloutStats = {
        sessionId: this.sessionId,
        messageCount: this.getMessageCount(),
        hasRollout: true
      };
    } catch (error) {
      console.error('Failed to get rollout statistics:', error);
    }

    return {
      ...baseExport,
      storageStats: rolloutStats,
      persistent: this.isPersistent
    };
  }

  /**
   * Reset session to initial state (for new conversation) using RolloutRecorder
   */
  async reset(): Promise<void> {
    await this.closeMemoryService();

    // Shutdown old RolloutRecorder if it exists
    if (this.services?.rollout) {
      try {
        await this.services.rollout.shutdown();
      } catch (error) {
        console.error('Failed to shutdown old rollout recorder:', error);
      }
    }

    // Clear conversation history
    this.clearHistory();

    // Create new conversation ID
    Object.assign(this, { sessionId: uuidv4() });

    // Reset tab binding to -1 (unbound)
    // Tab will be auto-bound by UI when side panel reopens
    this.sessionState.setTabId(-1);

    // Initialize new RolloutRecorder for the new conversation
    if (this.isPersistent) {
      await this.initializeSession('create', this.sessionId, this.config);
    }
  }

  /**
   * Close session and cleanup resources using RolloutRecorder
   */
  async close(): Promise<void> {
    await this.closeMemoryService();

    // Tool result persistence cleanup (track 09).
    //
    // Only purge persisted results on close for non-persistent sessions.
    // Persistent sessions can be resumed — the rollout still contains
    // <persisted-output> messages pointing at these storage keys / file
    // paths, and the agent must be able to retrieve the full content on
    // resume. Stale entries from persistent sessions are reclaimed via
    // server-mode TTL sweep / cache quota eviction instead.
    if (this.toolResultStore && !this.isPersistent) {
      try {
        await this.toolResultStore.cleanup(this.sessionId);
      } catch (error) {
        console.error('Failed to clean up tool result store:', error);
      }
    }

    if (this.services?.rollout) {
      try {
        // Record session close event
        const closeEvent: EventMsg = {
          type: 'BackgroundEvent',
          data: {
            message: `Session closed: ${this.sessionId} (${this.getMessageCount()} messages)`
          }
        };

        const rolloutItems: RolloutItem[] = [{
          type: 'event_msg',
          payload: closeEvent
        }];

        await this.services.rollout.recordItems(rolloutItems);

        // Flush and close rollout recorder
        await this.services.rollout.flush();
      } catch (error) {
        console.error('Failed to close rollout recorder:', error);
      }
    }
  }

  /**
   * Get session ID (conversation ID)
   */
  getId(): string {
    return this.sessionId;
  }

  /**
   * Get the tool result store (track 09). May be undefined if no backing store
   * is available for the current platform; callers should treat that as
   * "persistence disabled" and pass tool results through unchanged.
   */
  getToolResultStore(): ToolResultStore | undefined {
    return this.toolResultStore;
  }

  /**
   * Get the content-replacement state (track 09). Mutated in place by
   * TurnManager during tier-1 and tier-2 persistence; survives resume via
   * the rollout `content_replacement` items.
   */
  getContentReplacementState(): ContentReplacementState | undefined {
    return this.replacementState;
  }

  /**
   * Get current tab ID bound to this session
   */
  getTabId(): number {
    return this.sessionState.getTabId();
  }

  /**
   * Set tab ID for this session
   */
  setTabId(tabId: number): void {
    this.sessionState.setTabId(tabId);
  }

  /**
   * Get the memory service (null if memory is disabled or unsupported)
   */
  getMemoryService(): MemoryService | null {
    return this._memoryService;
  }

  /**
   * Set the memory service (called during initialization)
   */
  setMemoryService(service: MemoryService | null): void {
    console.log(`[Memory] setMemoryService called with: ${service ? 'MemoryService instance' : 'null'}`, new Error().stack?.split('\n').slice(1, 4).join('\n'));
    this._memoryService = service;
  }

  /**
   * Rebuild the memory service from current config/auth state.
   * Used on startup and after runtime config/auth changes.
   */
  async refreshMemoryService(configOverride?: AgentConfig): Promise<void> {
    await this.closeMemoryService();

    // Initialize memory service (for desktop/server only)
    // Memory uses file-based storage with a cheap LLM for search operations.
    try {
      if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ !== 'extension') {
        const agentConfig = configOverride || this.config || await AgentConfig.getInstance();
        const preferences = agentConfig.getConfig().preferences;
        const memoryEnabled = preferences?.memoryEnabled ?? false;

        console.log(`[Memory] Init check: BUILD_MODE=${__BUILD_MODE__}, memoryEnabled=${memoryEnabled}, preferences=`, JSON.stringify({ memoryEnabled: preferences?.memoryEnabled, memoryUseOwnApiKey: preferences?.memoryUseOwnApiKey }));

        // Determine API key source for the cheap memory LLM
        const memoryUseOwnApiKey = preferences?.memoryUseOwnApiKey ?? true;
        const useBackendForMemory = !memoryUseOwnApiKey;

        const openaiApiKey = await agentConfig.getProviderApiKey('openai');

        // Build backend routing config if applicable
        let backendBaseUrl: string | undefined;
        if (useBackendForMemory) {
          const { LLM_API_URL } = await import('../config/constants');
          if (LLM_API_URL) {
            backendBaseUrl = LLM_API_URL;
          }
        }

        // Create a dedicated LLM caller for memory keyword generation and relevance filtering.
        // Prefers a cheap model (gpt-4o-mini) via OpenAI API key. Falls back to the
        // user's current main LLM provider/model when no OpenAI key is available.
        const { OpenAIChatCompletionClient } = await import('./models/client/OpenAIChatCompletionClient');
        const { DEFAULT_EXTRACTION_MODEL } = await import('./memory/types');
        const extractionModel = preferences?.extractionModel ?? DEFAULT_EXTRACTION_MODEL;

        const memoryApiKey = useBackendForMemory
          ? (openaiApiKey || 'backend-routed')
          : (openaiApiKey || '');

        let llmCaller = null;

        if (memoryApiKey) {
          // Preferred path: dedicated gpt-4o-mini client via OpenAI key.
          // Track 11 note: memory extraction is a single tool-less completion;
          // it intentionally does not take the agent's parallelToolCalls flag.
          const memoryLLMClient = new OpenAIChatCompletionClient({
            apiKey: memoryApiKey,
            baseUrl: useBackendForMemory && backendBaseUrl ? backendBaseUrl + '/openai' : undefined,
            sessionId: 'memory-search',
            modelFamily: {
              family: extractionModel,
              base_instructions: '',
              supports_reasoning: false,
              supports_reasoning_summaries: false,
              needs_special_apply_patch_instructions: false,
            },
            provider: {
              name: 'OpenAI',
              wire_api: 'Chat' as const,
              requires_openai_auth: true,
            },
            ...(useBackendForMemory && backendBaseUrl && { useCredentials: true }),
          });

          llmCaller = {
            complete: async (systemPrompt: string, userPrompt: string) => {
              const response = await memoryLLMClient.complete({
                model: extractionModel,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ]
              });
              return response.choices[0]?.message?.content || '';
            }
          };
        }

        // Fallback: if no OpenAI key available, use the user's selected main LLM
        // for memory operations (search keyword generation, relevance filtering).
        // This ensures memory works regardless of which provider the user chose.
        if (!llmCaller) {
          llmCaller = await this.createFallbackMemoryLLMCaller(agentConfig);
          if (llmCaller) {
            console.info('[Memory] No OpenAI API key — using main LLM provider for memory operations.');
          }
        }

        console.log(`[Memory] llmCaller=${llmCaller ? 'available' : 'null'}, memoryApiKey=${memoryApiKey ? 'set' : 'empty'}, openaiApiKey=${openaiApiKey ? 'set' : 'empty'}`);

        const memoryService = await createMemoryService({
          config: { enabled: memoryEnabled },
          llmCaller,
        });

        console.log(`[Memory] createMemoryService result: ${memoryService ? 'initialized' : 'null'}`);

        if (memoryEnabled && !memoryService) {
          console.warn('[Memory] Memory is enabled but failed to initialize. Check logs for details.');
        }

        this.setMemoryService(memoryService);
      }
    } catch (err) {
      console.error('[Memory] Initialization failed:', err);
    }
  }

  /**
   * Close memory service and release its resources.
   */
  private async closeMemoryService(): Promise<void> {
    if (this._memoryService) {
      try {
        await this._memoryService.close();
      } catch (error) {
        console.error('Failed to close memory service:', error);
      }
      this._memoryService = null;
    }
  }

  /**
   * Track token usage
   */
  addTokenUsage(tokens: number): void {
    this.sessionState.addTokenUsage(tokens);
  }

  /**
   * Get token usage info
   * @returns Token usage information or undefined if not set
   */
  getTokenUsageInfo(): TokenUsageInfo | undefined {
    return this.sessionState.getTokenInfo();
  }

  /**
   * Add approved command to session
   * NEW: Delegates to SessionState
   */
  addApprovedCommand(command: string): void {
    this.sessionState.addApprovedCommand(command);
  }

  /**
   * Check if command is approved
   * NEW: Delegates to SessionState
   */
  isCommandApproved(command: string): boolean {
    return this.sessionState.isCommandApproved(command);
  }

  /**
   * Check if there's an active turn
   * NEW: Uses ActiveTurn
   */
  isActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  /**
   * Start a turn (creates ActiveTurn)
   */
  async startTurn(): Promise<void> {
    // Also create ActiveTurn for active turn management
    if (this.activeTurn) {
      throw new Error('Cannot start turn: turn already active');
    }
    this.activeTurn = new ActiveTurn();
  }

  /**
   * End a turn (clears ActiveTurn)
   */
  async endTurn(): Promise<void> {
    if (!this.activeTurn) {
      console.warn('No active turn to end');
      return;
    }

    // Drain any remaining tasks
    const remaining = this.activeTurn.drain();
    if (remaining.size > 0) {
      console.warn(`Ending turn with ${remaining.size} remaining tasks`);
    }

    this.activeTurn = null;
  }

  /**
   * Track tool usage
   */
  trackToolUsage(toolName: string): void {
    const current = this.toolUsageStats.get(toolName) || 0;
    this.toolUsageStats.set(toolName, current + 1);
  }

  /**
   * Add error to state
   */
  addError(error: string, context?: any): void {
    this.errorHistory.push({
      timestamp: Date.now(),
      error,
      context,
    });
  }

  /**
   * Request interrupt
   */
  requestInterrupt(): void {
    this.interruptRequested = true;
  }

  /**
   * Check if interrupt requested
   */
  isInterruptRequested(): boolean {
    return this.interruptRequested;
  }

  /**
   * Clear interrupt flag
   */
  clearInterrupt(): void {
    this.interruptRequested = false;
  }


  /**
   * Get default model from config or fallback
   */
  getDefaultModel(): string {
    // AgentConfig.getConfig() might return synchronously or via property
    // For now, return default until config structure is clarified
    return 'gpt-5';
  }

  /**
   * Get default cwd from config or fallback
   */
  getDefaultCwd(): string {
    // AgentConfig.getConfig() might return synchronously or via property
    // For now, return default until config structure is clarified
    return '/';
  }

  /**
   * Check if storage is enabled from config or fallback
   */
  isStorageEnabled(): boolean {
    // AgentConfig.getConfig() might return synchronously or via property
    // For now, return default until config structure is clarified
    return true;
  }

  /**
   * Get tool registry
   */
  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  /**
   * Set tool registry (called by RepublicAgent)
   */
  setToolRegistry(toolRegistry: ToolRegistry): void {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Initialize session with RolloutRecorder (replaces ConversationStore)
   */
  async initializeSession(
    mode: 'create' | 'resume',
    sessionId: string,
    config?: AgentConfig
  ): Promise<void> {
    try {
      const uuid = sessionId;

      if (mode === 'create') {
        // Create new rollout
        const rollout = await RolloutRecorder.create(
          {
            type: 'create',
            sessionId: uuid,
          },
          config as any
        );

        // Ensure services object exists
        if (!this.services) {
          // Initialize minimal services
          // Note: Since we're inside Session, we can't easily use createSessionServices async factory
          // without significant refactoring or awaiting imports.
          // For now, we create a minimal compatible object.
          // Ideally should use createSessionServices but that requires async module loading or circular deps?
          // Actually createSessionServices is imported in Session.ts.
          // But we can't await it nicely if we want to keep this simple?
          // Let's just create the object directly as it is simple.
          // But wait, createSessionServices is imported. Let's try to use it? 
          // Issue is createSessionServices might not be available if not passed.
          // Let's just instantiate a minimal services implementation.
          this.services = {
            rollout: null,
            notifier: {
              notify: () => { },
              error: () => { },
              success: () => { },
              warning: () => { }
            },
            showRawAgentReasoning: false
          };
        }

        this.services.rollout = rollout;
      } else {
        // Resume from existing rollout
        const rollout = await RolloutRecorder.create(
          {
            type: 'resume',
            rolloutId: uuid,
          },
          config as any
        );

        // Ensure services object exists
        if (!this.services) {
          this.services = {
            rollout: null,
            notifier: {
              notify: () => { },
              error: () => { },
              success: () => { },
              warning: () => { }
            },
            showRawAgentReasoning: false
          };
        }

        this.services.rollout = rollout;

        // Reconstruct history from rollout
        const initialHistory = await RolloutRecorder.getRolloutHistory(uuid);
        if (initialHistory.type === 'resumed' && initialHistory.payload.history) {
          this.reconstructHistoryFromRollout(initialHistory.payload.history);
        }
      }
    } catch (e) {
      console.error('Failed to initialize rollout recorder:', e);
      // Graceful degradation: set rollout to null, session continues without persistence
      if (this.services) {
        this.services.rollout = null;
      }
    }

    await this.refreshMemoryService(config);
  }

  /**
   * Create a memory LLM caller that mirrors the user's current main LLM provider/model.
   * Used as a fallback when no OpenAI API key is available.
   */
  private async createFallbackMemoryLLMCaller(
    agentConfig: AgentConfig
  ): Promise<{ complete: (systemPrompt: string, userPrompt: string) => Promise<string> } | null> {
    try {
      const fullConfig = agentConfig.getConfig();
      const modelData = agentConfig.getModelByKey(fullConfig.selectedModelKey);
      if (!modelData) return null;

      const providerId = modelData.provider.id;
      const providerApiKey = await agentConfig.getProviderApiKey(providerId);
      if (!providerApiKey) return null;

      const modelKey = modelData.model.modelKey;
      const baseUrl = modelData.provider.baseUrl || undefined;

      if (providerId === 'google-ai-studio') {
        const { GoogleCompletionClient } = await import('./models/client/GoogleCompletionClient');
        const client = new GoogleCompletionClient({
          apiKey: providerApiKey,
          baseUrl,
          provider: {
            name: 'Google AI Studio',
            wire_api: 'Chat' as const,
            requires_openai_auth: false,
          },
          modelFamily: {
            family: modelKey,
            base_instructions: '',
            supports_reasoning: false,
            supports_reasoning_summaries: false,
            needs_special_apply_patch_instructions: false,
          },
        });

        return {
          complete: async (systemPrompt: string, userPrompt: string) => {
            const response = await client.complete({
              model: modelKey,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            });
            return response.choices[0]?.message?.content || '';
          }
        };
      }

      // All other providers use OpenAI-compatible Chat Completions API.
      // Track 11 note: memory-search is a single tool-less completion; it
      // intentionally does not take the agent's parallelToolCalls flag.
      const { OpenAIChatCompletionClient } = await import('./models/client/OpenAIChatCompletionClient');
      const client = new OpenAIChatCompletionClient({
        apiKey: providerApiKey,
        baseUrl,
        sessionId: 'memory-search',
        modelFamily: {
          family: modelKey,
          base_instructions: '',
          supports_reasoning: false,
          supports_reasoning_summaries: false,
          needs_special_apply_patch_instructions: false,
        },
        provider: {
          name: modelData.provider.name || providerId,
          wire_api: 'Chat' as const,
          requires_openai_auth: true,
        },
      });

      return {
        complete: async (systemPrompt: string, userPrompt: string) => {
          const response = await client.complete({
            model: modelKey,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          });
          return response.choices[0]?.message?.content || '';
        }
      };
    } catch (err) {
      console.warn('[Memory] Failed to create fallback memory LLM caller:', err);
      return null;
    }
  }

  /**
   * Persist rollout items (replaces ConversationStore.addMessage)
   */
  async persistRolloutItems(items: RolloutItem[]): Promise<void> {
    if (this.services?.rollout) {
      try {
        await this.services.rollout.recordItems(items);
      } catch (e) {
        console.error('Failed to record rollout items:', e);
        // Don't throw - persistence failure should not stop execution
      }
    }
  }


  /**
   * Flush rollout recorder before session ends
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    // Track 05b: detach the session-summary hook (unregisters post-turn
    // callback + prompt extension). Safe to call without an attached hook.
    try {
      this._sessionSummaryHook?.detach();
    } catch (err) {
      console.warn(
        '[Session] sessionSummaryHook.detach failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    this._sessionSummaryHook = null;
    this.postTurnHooks.length = 0;

    await this.closeMemoryService();

    if (this.services?.rollout) {
      try {
        await this.services.rollout.flush();
      } catch (e) {
        console.error('Failed to flush rollout recorder:', e);
      }
    }
  }

  // ========================================================================
  // Browser-Compatible Session Methods
  // ========================================================================

  /**
   * Generate internal submission ID
   *
   * Generates unique internal submission IDs for auto-generated operations
   * (e.g., auto-compact). Uses simple counter since JavaScript is single-threaded.
   *
   * @returns Unique submission ID in format "auto-compact-{id}"
   */
  private internalSubIdCounter: number = 0;

  nextInternalSubId(): string {
    const id = this.internalSubIdCounter++;
    return `auto-compact-${id}`;
  }

  /**
   * Utility getters
   */

  /**
   * Check if raw agent reasoning should be shown
   * @returns Boolean from SessionServices or config
   */
  showRawAgentReasoning(): boolean {
    return this.services?.showRawAgentReasoning ?? false;
  }

  /**
   * Get user notifier service
   * @returns User notifier (can integrate with Chrome notifications or UI)
   */
  notifier(): any {
    return this.services?.notifier ?? null;
  }

  /**
   * Enhanced send_event with rollout persistence
   *
   * Persists event to rollout and emits via event emitter.
   * Replaces/enhances existing emitEvent() method.
   *
   * @param event Event to send
   */
  async recordTurnContext(contextItem: any): Promise<void> {
    // SessionState doesn't have recordTurnContext, we only persist to rollout

    // Persist to rollout
    if (this.services?.rollout) {
      const rolloutItem: RolloutItem = {
        type: 'turn_context',
        payload: contextItem,
      };
      try {
        await this.services.rollout.recordItems([rolloutItem]);
      } catch (error) {
        console.error('Failed to persist turn context:', error);
      }
    }
  }
  async sendEvent(event: Event): Promise<void> {
    // Persist event to rollout as EventMsg
    if (this.services?.rollout) {
      const rolloutItems: RolloutItem[] = [{
        type: 'event_msg',
        payload: event.msg,
      }];

      try {
        await this.services.rollout.recordItems(rolloutItems);
      } catch (e) {
        // Graceful degradation - log and continue
        console.error('Failed to persist event to rollout:', e);
      }
    }

    // Emit event via existing event emitter
    if (this.eventEmitter) {
      await this.eventEmitter(event);
    }
  }

  /**
   * Notify background event
   *
   * Helper to create and send BackgroundEvent.
   *
   * @param subId Submission ID
   * @param message Background event message
   */
  async notifyBackgroundEvent(subId: string, message: string): Promise<void> {
    const event: Event = {
      id: subId,
      msg: {
        type: 'BackgroundEvent',
        data: {
          message,
        },
      } as EventMsg,
    };
    await this.sendEvent(event);
  }

  /**
   * Notify stream error
   *
   * Helper to create and send StreamErrorEvent.
   *
   * @param subId Submission ID
   * @param message Error message
   */
  async notifyStreamError(subId: string, message: string): Promise<void> {
    const event: Event = {
      id: subId,
      msg: {
        type: 'Error',
        data: {
          message: message,
        },
      } as EventMsg,
    };
    await this.sendEvent(event);
  }

  /**
   * Send token count event
   *
   * Retrieves token info and rate limits from SessionState and emits TokenCountEvent.
   *
   * @param subId Submission ID
   */
  async sendTokenCountEvent(subId: string): Promise<void> {
    // Track 12: read the real values from SessionState (both were previously
    // hardcoded undefined — the getters now exist). The stored snapshot is
    // adapted to the flat RateLimitSnapshotEvent wire shape.
    const tokenInfo = this.sessionState.getTokenInfo();
    const snapshot = this.sessionState.getRateLimits();
    const rateLimits = snapshot
      ? toRateLimitSnapshotEvent(snapshot)
      : undefined;

    // Track 18: ride the cumulative session cost out on the same event
    // (purely additive on Track 12's repair).
    const cost = this.sessionState.getCostInfo();

    const event: Event = {
      id: subId,
      msg: {
        type: 'TokenCount',
        data: {
          info: tokenInfo,
          rate_limits: rateLimits,
          cost: cost.cumulativeCostUSD,
          cost_estimated: cost.hasUnknownModelCost,
        },
      } as EventMsg,
    };
    await this.sendEvent(event);
  }

  /**
   * Notify approval
   *
   * Resolves a pending approval request with the user's decision.
   * Locates the pending approval in ActiveTurn, removes it, and calls the resolver.
   *
   * @param executionId Unique identifier for the approval request
   * @param decision User's review decision (approve/reject/request_change)
   */
  notifyApproval(executionId: string, decision: ReviewDecision): void {
    if (!this.activeTurn) {
      console.warn(`No active turn to notify approval for executionId: ${executionId}`);
      return;
    }

    const resolver = this.activeTurn.removePendingApproval(executionId);
    if (resolver) {
      resolver(decision);
    } else {
      console.warn(`No pending approval found for executionId: ${executionId}`);
    }
  }

  // ========================================================================
  // Task Lifecycle Management
  // ========================================================================


  /**
   * Take all running tasks and clear the active turn
   *
   * @returns Map of all running tasks (submission ID -> RunningTask)
   * @private
   */
  private takeAllRunningTasks(): Map<string, RunningTask> {
    // If no active turn, return empty map
    if (!this.activeTurn) {
      return new Map();
    }

    // Clear pending approvals and input before draining
    this.activeTurn.clearPending();

    // Drain all tasks from the turn
    const tasks = this.activeTurn.drain();

    // Clear the active turn since all tasks are removed
    this.activeTurn = null;

    return tasks;
  }

  /**
   * Handle individual task abortion
   *
   * @param subId Submission ID of the task to abort
   * @param task RunningTask to abort
   * @param reason Reason for aborting the task
   * @private
   */
  private async handleTaskAbort(
    subId: string,
    task: RunningTask,
    reason: TurnAbortReason
  ): Promise<void> {
    // ── Track 04 Q7 ordering ──────────────────────────────────────────
    // Step 1: resolve pending approvals owned by this task with 'denied'
    //         so the awaiting tool call unwinds cleanly. Note: ActiveTurn
    //         doesn't track per-task approvals today (single foreground
    //         turn assumption), so this drains all pending approvals only
    //         when the aborted task is the foreground task.
    const isForeground = this.foregroundTaskId === subId;
    if (isForeground && this.activeTurn) {
      try {
        this.activeTurn.clearPending();
      } catch (e) {
        console.warn(`[Session] clearPending failed during abort:`, e);
      }
    }

    // Step 3 (re-ordered: must be set before abortController fires so the
    // SubAgentRunner detached IIFE sees the flag during its await): mark
    // the AgentContext cancelled. Suppresses misleading task-notification
    // from SubAgentRunner.ts:127.
    if (task.context) {
      task.context.cancelled = true;
    }

    // Step 4: abort the controller.
    task.abortController.abort();

    // Step 5: delegate to the task's own abort hook.
    try {
      await task.task.abort(this, subId);
    } catch (error) {
      console.warn(`Task abort() failed for ${subId}:`, error);
    }

    // Step 6: update typed state to terminal + set eviction grace.
    if (task.taskState && !isTerminalTaskStatus(task.taskState.status)) {
      task.taskState.status = 'killed';
      task.taskState.endTime = Date.now();
      if (!task.taskState.retain) {
        task.taskState.evictAfter = Date.now() + PANEL_GRACE_MS;
      }
      // Cancelled background tasks have their notification suppressed; treat
      // them as notified so the eviction timer can later reclaim their
      // chunks. (See design.md Q5/Q7 and SubAgentRunner.ts:127.)
      task.taskState.notified = true;
      this.ensureEvictionTimer();
    }

    // Emit TurnAborted event
    const event: Event = {
      id: subId,
      msg: {
        type: 'TurnAborted',
        data: {
          reason: reason === 'UserInterrupt' ? 'user_interrupt' : 'error',
          submission_id: subId,
          turn_count: 0,
        },
      },
    };

    if (this.eventEmitter) {
      await this.eventEmitter(event);
    }
  }

  /**
   * Abort all running tasks
   *
   * Takes all running tasks and aborts each one with the specified reason.
   *
   * @param reason Reason for aborting all tasks
   */
  async abortAllTasks(reason: TurnAbortReason): Promise<void> {
    // Take all running tasks from the foreground ActiveTurn
    const tasks = this.takeAllRunningTasks();

    // Also pull background tasks tracked in activeTasks but not in the
    // foreground turn (Track 04). Hard-shutdown paths call this and expect
    // everything to be killed.
    const allIds = new Set<string>(tasks.keys());
    for (const id of this.activeTasks.keys()) allIds.add(id);

    // Abort each task
    const abortPromises: Promise<void>[] = [];
    for (const id of allIds) {
      const task = tasks.get(id) ?? this.activeTasks.get(id);
      if (!task) continue;
      abortPromises.push(this.handleTaskAbort(id, task, reason));
    }

    // Wait for all aborts to complete (parallel execution)
    await Promise.all(abortPromises);

    // Drain the typed-task registry too
    this.activeTasks.clear();
    this.foregroundTaskId = null;
  }

  /**
   * Handle task completion
   *
   * Called when a task completes successfully.
   * Removes the task from ActiveTurn and emits TaskComplete event.
   *
   * @param subId Submission ID of the completed task
   * @param lastAgentMessage Final assistant message (or null)
   * @private
   */
  private async onTaskFinished(subId: string, lastAgentMessage: string | null): Promise<void> {
    // Remove task from ActiveTurn, and clear ActiveTurn if it's now empty
    if (this.activeTurn) {
      const isEmpty = this.activeTurn.removeTask(subId);
      if (isEmpty) {
        this.activeTurn = null;
      }
    }

    // Track 04: update typed-state to terminal + set eviction grace.
    // Background sub-agents have their notification flag set by
    // SubAgentRunner.safeEnqueueNotification; foreground RegularTasks are
    // notified immediately here (no async notification path).
    const t = this.activeTasks.get(subId);
    if (t?.taskState && !isTerminalTaskStatus(t.taskState.status)) {
      t.taskState.status = 'completed';
      t.taskState.endTime = Date.now();
      if (!t.taskState.isBackgrounded) {
        // Foreground: no async notification path — the result already
        // returned via the tool call, so consider it notified.
        t.taskState.notified = true;
      }
      if (!t.taskState.retain) {
        t.taskState.evictAfter = Date.now() + PANEL_GRACE_MS;
      }
      this.ensureEvictionTimer();
    }
    if (this.foregroundTaskId === subId) {
      this.foregroundTaskId = null;
    }
    // Note: we leave the entry in activeTasks for the eviction grace window.
    // The eviction timer removes it once gates pass.
  }

  /**
   * Spawn task
   *
   * Spawns a SessionTask and manages its lifecycle.
   *
   * @param task - The SessionTask to execute (RegularTask or CompactTask)
   * @param context - Turn context for execution
   * @param subId - Submission ID (unique identifier for this task)
   * @param input - Input items for the task
   */
  async spawnTask(
    task: SessionTask,
    context: TurnContext,
    subId: string,
    input: InputItem[],
    opts: { background?: boolean; scopedTabIds?: number[] } = {}
  ): Promise<void> {
    // Track 04: foreground replacement no longer kills background tasks.
    // Only abort the prior foreground task if this spawn is foreground.
    if (!opts.background) {
      if (this.foregroundTaskId) {
        await this.abortTask(this.foregroundTaskId, 'UserInterrupt');
      }
      this.foregroundTaskId = subId;
    }

    // Create AbortController for cancellation
    const abortController = new AbortController();

    // Fire TaskCreated hook (fire-and-forget)
    if (this.hookDispatcher) {
      this.hookDispatcher.fire('TaskCreated', {
        hook_event_name: 'TaskCreated',
        session_id: this.sessionId,
        task_id: subId,
        task_type: task.constructor.name,
      }).catch(() => {});
    }

    // Create promise wrapper for task execution
    const promise = (async (): Promise<string | null> => {
      try {
        // Execute task
        const result = await task.run(this, context, subId, input);
        // On success, call completion handler
        await this.onTaskFinished(subId, result);

        // Fire TaskCompleted hook (fire-and-forget)
        if (this.hookDispatcher) {
          this.hookDispatcher.fire('TaskCompleted', {
            hook_event_name: 'TaskCompleted',
            session_id: this.sessionId,
            task_id: subId,
            task_type: task.constructor.name,
          }).catch(() => {});
        }

        return result;
      } catch (error) {
        // On error, call abort handler
        await this.onTaskAborted(subId, error);
        return null;
      }
    })();

    // Create RunningTask entry
    const runningTask: RunningTask = {
      kind: task.kind(),
      abortController,
      task,
      promise,
      startTime: Date.now(),
      scopedTabIds: opts.scopedTabIds,
    };

    // Register as new active task (creates new ActiveTurn and adds task)
    this.registerNewActiveTask(subId, runningTask);

    // Track 04: also insert into the cross-turn typed-task registry.
    // SubAgentRunner.prepare will subsequently call registerTaskState to
    // populate the taskState + context fields for background sub-agents.
    this.activeTasks.set(subId, runningTask);

    // Execute asynchronously (fire-and-forget, don't await)
    // The promise will handle completion/abortion internally
  }

  /**
   * (Track 04 / Q2) Attach or create a typed BackgroundAgentTaskState in
   * this session's activeTasks. Called by SubAgentRunner.prepare after it
   * builds the typed state.
   *
   * Two code paths reach here:
   *
   * 1. The task came through Session.spawnTask first — there's a matching
   *    RunningTask entry already; this call attaches state + context to it.
   *    NOTE on the `existing` branch: the caller may pass `abortController`
   *    via `bits`, but we intentionally KEEP the spawn's own controller
   *    rather than swap it. Reason: the spawn's controller is already wired
   *    into the task's promise chain; replacing it mid-run would leave the
   *    real run uncancellable.
   *
   * 2. The task was spawned by a child engine (sub-agent) whose flow does
   *    NOT go through the parent session's spawnTask — there's no matching
   *    entry. We create a synthetic RunningTask owned by the sub-agent's
   *    AbortController so the parent session can track / abort / display it.
   *
   * ⚠️  WARNING: AbortController duality for sub-agents.
   * The sub-agent runs inside its own RepublicAgentEngine which has its
   * own Session. That child session's spawnTask creates its OWN
   * AbortController, separate from the one stored here (which comes from
   * SubAgentRunner.prepare and is wired into AgentContext).
   *
   * Aborting via THIS (parent) session's abortTask fires only the parent-
   * side controller. That signal reaches the child's model call via the
   * `signal:` option passed to engine.run(...), and the resulting thrown
   * abort error propagates through the child's task promise → child's
   * onTaskAborted. So abort DOES propagate, but through the model-error
   * path, NOT by the child session's controller being fired directly.
   *
   * If you change this code, preserve that property — or move sub-agent
   * tracking to the child session entirely and have the parent only hold
   * a read-through projection.
   *
   * @param state - The typed task state. state.id must equal the runId.
   * @param bits - Runtime bits: AgentContext for cancel propagation,
   *               AbortController for per-task abort (synthetic path only),
   *               scopedTabIds for tab-close granularity.
   */
  registerTaskState(
    state: BackgroundAgentTaskState,
    bits: {
      context: AgentContext;
      abortController?: AbortController;
      scopedTabIds?: number[];
    }
  ): void {
    const existing = this.activeTasks.get(state.id);
    if (existing) {
      // Attach-only path: preserve the spawn's existing AbortController.
      // `bits.abortController` is deliberately ignored — see JSDoc.
      existing.taskState = state;
      existing.context = bits.context;
      if (bits.scopedTabIds !== undefined) {
        existing.scopedTabIds = bits.scopedTabIds;
      }
      return;
    }
    // Synthetic registration path: sub-agent owned by a child engine that
    // didn't go through this session's spawnTask.
    const abortController = bits.abortController ?? new AbortController();
    const synthetic: RunningTask = {
      // Sub-agents don't have a meaningful SessionTask kind. Use Regular
      // as a sentinel; the handleTaskAbort path keys off taskState +
      // context, not kind.
      kind: TaskKind.Regular,
      abortController,
      // A no-op SessionTask shim. The real abort path is:
      //   parent.abortTask(id) -> handleTaskAbort
      //     -> context.cancelled = true
      //     -> abortController.abort()
      //     -> (model call inside child engine throws, child task ends)
      // This shim's abort() is intentionally a no-op because the work
      // happens through the context + abortController above.
      task: {
        kind: () => TaskKind.Regular,
        run: async () => null,
        abort: async () => undefined,
      },
      promise: Promise.resolve(null),
      startTime: state.startTime,
      taskState: state,
      context: bits.context,
      scopedTabIds: bits.scopedTabIds,
    };
    this.activeTasks.set(state.id, synthetic);
  }

  /**
   * (Track 04) Abort a single task by id. Per-task variant of abortAllTasks.
   * Walks the same handleTaskAbort path (which is the Q7-ordering source
   * of truth: approvals → deny, pending input → drop, context.cancelled
   * → set, abort, await, terminal-state update, ActiveTurn cleanup).
   */
  async abortTask(id: string, reason: TurnAbortReason): Promise<void> {
    const t = this.activeTasks.get(id);
    if (!t) return;
    await this.handleTaskAbort(id, t, reason);
    // Also drain from ActiveTurn so hasRunningTask reports false immediately
    // even if the task's promise never resolves (e.g., synthetic sub-agent
    // entries created by SubAgentRunner whose promise is Promise.resolve(null)
    // but never went through ActiveTurn anyway, and edge-case mocks).
    if (this.activeTurn) {
      const isEmpty = this.activeTurn.removeTask(id);
      if (isEmpty) this.activeTurn = null;
    }
    this.activeTasks.delete(id);
    if (this.foregroundTaskId === id) {
      this.foregroundTaskId = null;
    }
  }

  /**
   * (Track 04 / Q9) Abort all tasks scoped to a specific tab. Used by the
   * service worker when a working tab closes (chat-panel tab close still
   * routes through abortAllTasks).
   */
  async abortTasksForTab(tabId: number, reason: TurnAbortReason): Promise<void> {
    const toAbort: string[] = [];
    for (const [id, t] of this.activeTasks) {
      if (t.scopedTabIds?.includes(tabId)) toAbort.push(id);
    }
    await Promise.all(toAbort.map(id => this.abortTask(id, reason)));
  }

  /** (Track 04) Internal full-record listing — runtime + typed-state pairs. */
  listActiveTasks(): RunningTask[] {
    return [...this.activeTasks.values()];
  }

  /** (Track 04) Projection of typed task states for UI and engine API. */
  listTaskStates(): TaskState[] {
    const out: TaskState[] = [];
    for (const t of this.activeTasks.values()) {
      if (t.taskState) out.push(t.taskState);
    }
    return out;
  }

  /** (Track 04) Lookup the full RunningTask record. */
  getTask(id: string): RunningTask | undefined {
    return this.activeTasks.get(id);
  }

  /** (Track 04) Get the foreground task id, if any. */
  getForegroundTaskId(): string | null {
    return this.foregroundTaskId;
  }

  /**
   * (Track 04 / Q10) UI-driven retain toggle. Called by BackgroundTaskPanel
   * mount/unmount. retain=true blocks eviction; retain=false re-arms
   * evictAfter for terminal tasks.
   */
  retainTask(id: string, retain: boolean): void {
    const t = this.activeTasks.get(id);
    if (!t?.taskState) return;
    t.taskState.retain = retain;
    if (retain) {
      t.taskState.evictAfter = undefined;
    } else if (isTerminalTaskStatus(t.taskState.status)) {
      t.taskState.evictAfter = Date.now() + PANEL_GRACE_MS;
    }
  }

  /** (Track 04) Inject the shared TaskOutputStore (called at engine startup). */
  setTaskOutputStore(store: TaskOutputStore): void {
    this.taskOutputStore = store;
  }

  /** (Track 04) Get the shared TaskOutputStore, if set. */
  getTaskOutputStore(): TaskOutputStore | null {
    return this.taskOutputStore;
  }

  /**
   * (Track 04) Lazily start the eviction timer. Runs every STOPPED_DISPLAY_MS
   * and processes terminal tasks whose grace window has elapsed.
   */
  private ensureEvictionTimer(): void {
    if (this.evictionTimerId !== null) return;
    this.evictionTimerId = setInterval(() => {
      void this.runEvictionTick();
    }, STOPPED_DISPLAY_MS);
  }

  private async runEvictionTick(): Promise<void> {
    const now = Date.now();
    const toEvict: string[] = [];
    for (const [id, t] of this.activeTasks) {
      const state = t.taskState;
      if (!state) continue;
      if (!state.notified) continue;
      if (!isTerminalTaskStatus(state.status)) continue;
      if (state.retain) continue;
      if (state.evictAfter !== undefined && now < state.evictAfter) continue;
      toEvict.push(id);
    }
    if (toEvict.length === 0) {
      // Stop the timer when there's nothing terminal awaiting eviction.
      // It will restart lazily next time a task terminates.
      const hasTerminal = [...this.activeTasks.values()].some(
        t => t.taskState && isTerminalTaskStatus(t.taskState.status),
      );
      if (!hasTerminal && this.evictionTimerId !== null) {
        clearInterval(this.evictionTimerId);
        this.evictionTimerId = null;
      }
      return;
    }
    for (const id of toEvict) {
      if (this.taskOutputStore) {
        try {
          await this.taskOutputStore.cleanupTask(id);
        } catch (err) {
          console.warn(`[Session] cleanupTask failed for ${id}:`, err);
        }
      }
      this.activeTasks.delete(id);
    }
  }

  /**
   * Interrupt task
   *
   * Wrapper around abortAllTasks with Interrupted reason.
   * Used when user explicitly interrupts execution.
   */
  async interruptTask(): Promise<void> {
    // Track 04: narrow to foreground-only — background tasks survive
    // user interrupts. The chat-panel tab close path still goes through
    // abortAllTasks for hard shutdown.
    if (this.foregroundTaskId) {
      await this.abortTask(this.foregroundTaskId, 'UserInterrupt');
    }
  }

  // ========================================================================
  // Rollout Recording & History Management
  // ========================================================================

  /**
   * Persist rollout response items
   *
   * Converts ResponseItems to RolloutItems and persists them via RolloutRecorder.
   * This is used to save conversation history to persistent storage.
   *
   * Enhanced to compress DOM snapshots immediately before persistence.
   * Rollout storage never needs uncompressed snapshots (not directly read by LLM)
   *
   * @param items Response items to persist
   * @private
   */
  private async persistRolloutResponseItems(items: ResponseItem[]): Promise<void> {
    if (!this.services?.rollout) {
      return;
    }

    // Compress DOM snapshots immediately before persistence
    // Rollout is never directly read by LLM, so we compress all snapshots
    const compressedItems = items.map((item) => compressSnapshot(item));

    // Convert ResponseItems to RolloutItems
    const rolloutItems: RolloutItem[] = compressedItems.map((item) => ({
      type: 'response_item',
      payload: item,
    }));

    if (!this.services?.rollout) {
      return;
    }

    try {
      await this.services.rollout.recordItems(rolloutItems);
    } catch (error) {
      console.error('Failed to persist rollout items:', error);
    }
  }

  /**
   * Record conversation items with dual persistence
   *
   * Records ResponseItems to both SessionState (in-memory history) and
   * RolloutRecorder (persistent storage).
   */
  async recordConversationItemsDual(items: ResponseItem[]): Promise<void> {
    // If incoming items contain any DOM snapshot output, compress previous snapshots in history first
    // This keeps the latest snapshot fresh for LLM reasoning
    if (items.some(item => isDOMSnapshotOutput(item))) {
      // Compress previous DOM snapshots BEFORE recording new items
      this.sessionState.compressPreviousDomSnapshot();
    }

    // Record to SessionState (in-memory history)
    this.sessionState.recordItems(items);

    // Persist to rollout storage
    await this.persistRolloutResponseItems(items);
  }

  /**
   * Record input and rollout user message
   *
   * Converts InputItems to ResponseItem, records to history, derives UserMessage event,
   * and persists only the UserMessage to rollout (not the full ResponseItem).
   *
   * This is used when recording user input to the conversation.
   *
   * @param subId Submission ID
   * @param input Input items from user
   * @public
   */
  public async recordInputAndRolloutUsermsg(
    input: InputItem[]
  ): Promise<void> {
    // Convert input to ResponseItem (simplified - would need full protocol mapping)
    const responseItems: ResponseItem[] = input.map((item) => ({
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: typeof item === 'string' ? item : JSON.stringify(item)
      }]
    }));

    // Record to SessionState history
    await this.recordConversationItemsDual(responseItems);

    // Derive user message events using event mapping
    // This ensures proper handling of user_instructions and environment_context tags
    if (this.services?.rollout && responseItems.length > 0) {
      const showRawReasoning = false; // User messages don't have reasoning
      const eventMsgs = mapResponseItemToEventMessages(responseItems[0], showRawReasoning);

      // Filter and persist only UserMessage events to rollout
      const userMsgEvents = eventMsgs.filter(msg => msg.type === 'UserMessage');

      if (userMsgEvents.length > 0) {
        const rolloutItems: RolloutItem[] = userMsgEvents.map(event => ({
          type: 'event_msg',
          payload: event,
        }));

        try {
          await this.services.rollout.recordItems(rolloutItems);
        } catch (error) {
          // Failure to persist to rollout is non-fatal
        }
      }

      // Check if we should generate a title (after 3 user messages)
      this.maybeGenerateTitle();
    }
  }

  /**
   * Check if title generation should be triggered and execute if needed.
   * Two-stage title generation:
   * - Stage 1: Generate title after 2 user messages (initial title)
   * - Stage 2: Regenerate title after 5 user messages (final title with more context)
   * @private
   */
  private maybeGenerateTitle(): void {
    // Skip if title generation is complete (stage 2) or no rollout service
    if (this.titleGenerationStage >= 2 || !this.services?.rollout) {
      return;
    }

    // Count user messages in history
    const history = this.sessionState.historySnapshot();
    const userMessageCount = this.titleGenerator.countUserMessages(history);

    // Stage 0 → 1: Generate title after 2 user messages
    if (this.titleGenerationStage === 0 && userMessageCount >= 2) {
      this.titleGenerationStage = 1;

      // Run title generation asynchronously with first 2 messages
      this.generateAndUpdateTitle(history, 2).catch((error) => {
        console.error('[Session] Failed to generate title (stage 1):', error);
        // Reset to allow retry
        this.titleGenerationStage = 0;
      });
    }
    // Stage 1 → 2: Regenerate title after 5 user messages (final)
    else if (this.titleGenerationStage === 1 && userMessageCount >= 5) {
      this.titleGenerationStage = 2;

      // Run title generation asynchronously with all 5 messages
      this.generateAndUpdateTitle(history, 5).catch((error) => {
        console.error('[Session] Failed to generate title (stage 2):', error);
        // Reset to stage 1 to allow retry
        this.titleGenerationStage = 1;
      });
    }
  }

  /**
   * Generate title using LLM and update rollout metadata.
   * @param history - Current conversation history
   * @param maxMessages - Maximum number of user messages to use for title generation
   * @private
   */
  private async generateAndUpdateTitle(history: ResponseItem[], maxMessages: number): Promise<void> {
    // Get model client for title generation
    const modelClient = this.getModelClientForTitle();
    if (!modelClient) {
      console.warn('[Session] No model client available for title generation');
      return;
    }

    // Extract user messages up to maxMessages
    const userMessages = this.titleGenerator.extractUserMessages(history, maxMessages);
    if (userMessages.length === 0) {
      console.warn('[Session] No user messages found for title generation');
      return;
    }

    // Generate title
    const result = await this.titleGenerator.generateTitle(userMessages, modelClient);

    if (result.success && result.title && this.services?.rollout) {
      try {
        await this.services.rollout.updateTitle(result.title);
        console.debug('[Session] Title updated (using %d messages):', maxMessages, result.title);
      } catch (error) {
        console.error('[Session] Failed to update title in storage:', error);
      }
    } else if (!result.success) {
      console.warn('[Session] Title generation failed:', result.error);
    }
  }

  /**
   * Get model client for title generation.
   * Uses modelForTitleGenerate from config if set, otherwise uses main model.
   * @private
   */
  private getModelClientForTitle(): ModelClient | null {
    // For now, return the turn context's model client
    // TODO: Support separate model for title generation via config.modelForTitleGenerate
    if (this.turnContext && typeof this.turnContext.getModelClient === 'function') {
      return this.turnContext.getModelClient();
    }
    return null;
  }

  /**
   * Track 24.3: after a completed turn, predict the user's likely next
   * message and emit it for one-tap accept in the interactive UI.
   *
   * Gated OFF on the headless server build — there is no user to suggest to,
   * so the extra model call would be pure cost. Fire-and-forget; never blocks
   * task completion. Mirrors {@link maybeGenerateTitle}'s background pattern.
   */
  async maybeGenerateSuggestion(): Promise<void> {
    if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'server') {
      return;
    }
    // Single-flight + cooldown: a slow background call must not stack with the
    // next task's completion, and rapid retried/aborted completions must not
    // each spawn a model call.
    if (this.suggestionInFlight) return;
    if (Date.now() - this.lastSuggestionAt < SUGGESTION_COOLDOWN_MS) return;

    const history = this.sessionState.historySnapshot();
    if (this.suggestionGenerator.countAssistantTurns(history) < 2) {
      return;
    }
    const modelClient = this.getModelClientForTitle();
    if (!modelClient) return;

    this.suggestionInFlight = true;
    try {
      const result = await this.suggestionGenerator.generateSuggestion(history, modelClient);
      this.lastSuggestionAt = Date.now();
      if (result.success && result.suggestion) {
        await this.emitEvent({
          id: crypto.randomUUID(),
          msg: { type: 'PromptSuggestion', data: { suggestion: result.suggestion } },
        });
      } else if (!result.success) {
        console.debug('[Session] Prompt suggestion generation failed:', result.error);
      }
    } finally {
      this.suggestionInFlight = false;
    }
  }

  /**
   * Reconstruct history from rollout
   *
   * Reconstructs conversation history from rollout storage, handling both
   * regular ResponseItems and compacted history with summaries.
   *
   * This is called when resuming a session from persistent storage.
   *
   * @param rolloutItems Items from rollout storage
   * @private
   */
  private reconstructHistoryFromRollout(rolloutItems: RolloutItem[]): void {
    const responseItems: ResponseItem[] = [];

    for (const rolloutItem of rolloutItems) {
      if (rolloutItem.type === 'response_item') {
        // Regular response item
        responseItems.push(rolloutItem.payload as ResponseItem);
        // Track 09: seed seenIds from any function_call_output we've seen.
        // This freezes "seen but unreplaced" decisions so tier-2 can't
        // retroactively persist an output that the model already observed
        // unchanged.
        const r = rolloutItem.payload as any;
        if (r && r.type === 'function_call_output' && typeof r.call_id === 'string') {
          this.replacementState?.freezeUnreplaced(r.call_id);
        }
      } else if (rolloutItem.type === 'compacted') {
        // Compacted history with summary
        // The compacted item should contain a summary that replaces multiple items
        const compactedData = rolloutItem.payload as any;
        // CompactedItem declares `message` (storage/rollout/types.ts). Earlier
        // notes referenced `summary`; read `message` first and fall back to
        // `summary` for forward/backward tolerance (Track 15, Phase 0b — this
        // is what summarize_up_to emits and what fork-replay reads back).
        const compactedText = compactedData.message ?? compactedData.summary;
        if (compactedText) {
          // Add summary as a system message
          responseItems.push({
            role: 'system',
            content: compactedText,
            type: 'message'
          } as ResponseItem);
        }
      } else if (rolloutItem.type === 'content_replacement') {
        // Track 09: re-seed the replacement state with the exact preview
        // string the model saw on the original turn. seedFromResume
        // deliberately bypasses the rollout onRecord callback so we don't
        // re-record everything. A corrupted / older-format payload must
        // not poison the rest of resume — validate shape, skip on mismatch.
        const p = rolloutItem.payload as any;
        if (
          p &&
          typeof p === 'object' &&
          typeof p.toolUseId === 'string' &&
          typeof p.replacement === 'string'
        ) {
          this.replacementState?.seedFromResume(p);
        } else {
          console.warn('[Session] Skipping malformed content_replacement rollout record');
        }
      }
      // Other rollout item types (event_msg, etc.) are not added to history
    }

    // Replace entire history with reconstructed items
    this.sessionState.replaceHistory(responseItems);
  }

  // ========================================================================
  // Token & Rate Limit Tracking
  // ========================================================================

  /**
   * Update token usage info
   *
   * Updates SessionState with token usage information and sends token count event.
   *
   * @param subId Submission ID
   * @param tokenUsage Token usage data (or null if not available)
   * @private
   */
  private async updateTokenUsageInfo(
    subId: string,
    tokenUsage: any | null
  ): Promise<void> {
    if (!tokenUsage) {
      return;
    }

    // Convert TokenUsage to TokenUsageInfo for SessionState
    const tokenInfo: TokenUsageInfo = {
      input_tokens: tokenUsage.input_tokens,
      output_tokens: tokenUsage.output_tokens,
      total_tokens: tokenUsage.total_tokens,
      cache_creation_input_tokens: tokenUsage.cached_input_tokens,
      cache_read_input_tokens: 0, // Not provided in TokenUsage
    };

    // Update SessionState
    this.sessionState.updateTokenInfo(tokenInfo);

    // Send token count event
    await this.sendTokenCountEvent(subId);
  }

  /**
   * Track 12: record a rate-limit snapshot observed on the live model
   * stream (the `RateLimits` ResponseEvent in TurnManager). This is the
   * public entrypoint that makes the snapshot path actually fire in
   * production — without it the parsed snapshot was dropped and
   * `sendTokenCountEvent` could only ever emit `undefined`.
   *
   * @param rateLimits Rate limit snapshot parsed by the provider client
   */
  async recordRateLimits(rateLimits: RateLimitSnapshot): Promise<void> {
    // Reactive emission (not tied to a specific submission) — use a fresh
    // correlation id, consistent with how other mid-stream events are id'd.
    await this.updateRateLimits(uuidv4(), rateLimits);
  }

  /**
   * Update rate limits
   *
   * Updates SessionState with rate limit information and sends token count event.
   *
   * @param subId Submission ID
   * @param rateLimits Rate limit snapshot
   * @private
   */
  private async updateRateLimits(
    subId: string,
    rateLimits: RateLimitSnapshot
  ): Promise<void> {
    // Update SessionState
    this.sessionState.updateRateLimits(rateLimits);

    // Track 12: emit an early warning when quota is being burned faster than
    // the window sustains (before the API actually rejects).
    const warning = evaluateEarlyWarning(rateLimits);
    if (warning) {
      const resetSuffix =
        warning.resets_in_seconds !== undefined
          ? `, resets in ${Math.ceil(warning.resets_in_seconds)}s`
          : '';
      await this.sendEvent({
        id: subId,
        msg: {
          type: 'RateLimitWarning',
          data: {
            window: warning.window,
            used_percent: warning.used_percent,
            time_progress: warning.time_progress,
            resets_in_seconds: warning.resets_in_seconds,
            message:
              `Approaching rate limit: ${warning.used_percent.toFixed(0)}% of ` +
              `the ${warning.window} window used${resetSuffix}`,
          },
        } as EventMsg,
      });
    }

    // Send token count event
    await this.sendTokenCountEvent(subId);
  }

  // ========================================================================
  // Initialization & Utilities
  // ========================================================================

  /**
   * Inject input
   *
   * Attempts to inject input into the active turn. If there's an active turn,
   * the input is queued for processing. If there's no active turn, the input
   * is returned back to the caller.
   *
   * @param input Input items to inject
   * @returns Result object with success status and optionally returned input
   */
  async injectInput(input: InputItem[]): Promise<{ success: boolean; returned?: InputItem[] }> {
    if (!this.activeTurn) {
      // No active turn - return input back to caller
      return {
        success: false,
        returned: input,
      };
    }

    // Inject input into active turn
    for (const item of input) {
      this.activeTurn.pushPendingInput(item);
    }

    return {
      success: true,
    };
  }

  /**
   * Turn input with history
   *
   * Combines session history with extra turn items to create full turn input.
   * This is used when preparing input for a new turn.
   *
   * @param extra Additional response items for this turn
   * @returns Combined array of history + extra items
   */
  async turnInputWithHistory(extra: ResponseItem[]): Promise<ResponseItem[]> {
    // Get history snapshot from SessionState
    const history = this.sessionState.historySnapshot();

    // Combine history with extra items
    return [...history, ...extra];
  }

  /**
   * Record initial history
   *
   * Records initial conversation history based on session mode.
   * - New sessions: Records initial context
   * - Resumed sessions: Reconstructs history from rollout
   * - Forked sessions: Reconstructs and persists history
   *
   * @param initialHistory Initial history configuration
   * @private
   */
  private async recordInitialHistory(
    initialHistory: InitialHistory
  ): Promise<void> {
    if (initialHistory.mode === 'new') {
      // New session - no history to record yet
      return;
    } else if (initialHistory.mode === 'resumed') {
      // Resumed session - reconstruct from rollout
      this.reconstructHistoryFromRollout(initialHistory.rolloutItems);
    } else if (initialHistory.mode === 'forked') {
      // Forked session - reconstruct and persist
      this.reconstructHistoryFromRollout(initialHistory.rolloutItems);

      // Persist forked history to new rollout
      const history = this.sessionState.historySnapshot();
      await this.persistRolloutResponseItems(history);
    }
  }

  /**
   * Flush any queued rollout writes to durable storage.
   *
   * The static RolloutRecorder read path bypasses this live session's
   * writer (writes are serialized through RolloutWriter.writeQueue), so any
   * caller that needs to read this conversation's items while it is still
   * live — e.g. the Track 15 rewind selector / slice fn — MUST call this
   * first, otherwise queued-but-unflushed turns are invisible (Track 15,
   * D13 / Phase 0c). No-op if this session has no rollout recorder.
   */
  async flushRollout(): Promise<void> {
    if (this.services?.rollout) {
      try {
        await this.services.rollout.flush();
      } catch (e) {
        console.error('Failed to flush rollout recorder:', e);
      }
    }
  }

  // ========================================================================
  // Task Management Helper Methods (Feature 012)
  // ========================================================================

  /**
   * Get snapshot of running tasks (for debugging/monitoring)
   *
   * @returns Copy of tasks map (not live reference)
   */
  getRunningTasks(): Map<string, RunningTask> {
    if (!this.activeTurn) {
      return new Map();
    }
    // Return snapshot (non-destructive)
    return this.activeTurn.getTasks();
  }

  /**
   * Check if a specific task is running
   *
   * @param subId - Submission ID to check
   * @returns true if task exists in ActiveTurn
   */
  hasRunningTask(subId: string): boolean {
    return this.activeTurn?.hasTask(subId) ?? false;
  }

  /**
   * Register a new active task
   *
   * Creates a new ActiveTurn, adds the task to it, and replaces the current active turn.
   * This effectively ensures only one turn can be active at a time.
   *
   * @param subId - Submission ID
   * @param task - Running task to register
   * @private
   */
  private registerNewActiveTask(subId: string, task: RunningTask): void {
    // Create a new ActiveTurn
    const turn = new ActiveTurn();

    // Add the task to it
    turn.addTask(subId, task);

    // Replace the current active turn with the new one
    this.activeTurn = turn;
  }

  /**
   * Handle task abortion (internal callback)
   *
   * @param subId - Submission ID of aborted task
   * @param error - Error that caused abort (or AbortError)
   * @private
   */
  private async onTaskAborted(subId: string, error: any): Promise<void> {
    // Remove from ActiveTurn
    if (this.activeTurn) {
      const isEmpty = this.activeTurn.removeTask(subId);
      if (isEmpty) {
        this.activeTurn = null;
      }
    }

    // Determine abort reason from error
    const reason: any = error?.name === 'AbortError' ? 'user_interrupt' : 'error';

    // Track 04: update typed state. handleTaskAbort already does this for
    // explicit Session.abortTask paths; this handler covers the case where
    // a task threw an error that wasn't a direct abort.
    const t = this.activeTasks.get(subId);
    if (t?.taskState && !isTerminalTaskStatus(t.taskState.status)) {
      t.taskState.status = reason === 'user_interrupt' ? 'killed' : 'failed';
      t.taskState.endTime = Date.now();
      t.taskState.notified = true;
      if (!t.taskState.retain) {
        t.taskState.evictAfter = Date.now() + PANEL_GRACE_MS;
      }
      this.ensureEvictionTimer();
    }
    if (this.foregroundTaskId === subId) {
      this.foregroundTaskId = null;
    }

    // Emit TurnAborted event (if eventEmitter is set)
    if (this.eventEmitter) {
      const event: Event = {
        id: uuidv4(),
        msg: {
          type: 'TurnAborted',
          data: {
            reason,
            submission_id: subId,
            turn_count: 0,
          }
        }
      };
      await this.eventEmitter(event);
    }
  }
}
