/**
 * Session management class
 * Manages conversation state, turn context, and history
 *
 * REFACTORED: Now uses SessionState, SessionServices, and ActiveTurn for better organization
 * while maintaining full backward compatibility
 */

import type { InputItem, AskForApproval, SandboxPolicy, ReasoningEffortConfig, ReasoningSummaryConfig, Event, ResponseItem, ConversationHistory, ReviewDecision } from '../protocol/types';
import { mapResponseItemToEventMessages } from './events/EventMapping';
import type { EventMsg } from '../protocol/events';
import { RolloutRecorder, type RolloutItem } from '../storage/rollout';
import { v4 as uuidv4 } from 'uuid';
import { TurnContext } from './TurnContext';
import type { AgentConfig } from '../config/AgentConfig';
import type { SessionTask } from './tasks/SessionTask';
import type { ToolRegistry } from '../tools/ToolRegistry';

// New state management imports
import { SessionState, type SessionStateExport } from './session/state/SessionState';
import { type SessionServices, createSessionServices } from './session/state/SessionServices';
import { ActiveTurn } from './session/state/ActiveTurn';
import type { TokenUsageInfo, RunningTask, RateLimitSnapshot, TurnAbortReason, InitialHistory } from './session/state/types';
import { isDOMSnapshotOutput, compressSnapshot } from './session/state/SnapshotCompressor';

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
  readonly conversationId: string;
  private config?: AgentConfig;
  private sessionState: SessionState; // Pure data state
  private services: SessionServices | null = null; // Service collection
  private activeTurn: ActiveTurn | null = null; // Active turn management
  private turnContext: TurnContext;
  private eventEmitter: ((event: Event) => Promise<void>) | null = null;
  private isPersistent: boolean = true;
  private toolRegistry: ToolRegistry | null = null; // Tool registry from BrowserxAgent

  // Runtime state (not persisted, lives in Session only)
  private toolUsageStats: Map<string, number> = new Map();
  private errorHistory: Array<{timestamp: number, error: string, context?: any}> = [];
  private interruptRequested: boolean = false;

  constructor(
    configOrIsPersistent?: AgentConfig | boolean,
    isPersistent?: boolean,
    services?: SessionServices,
    toolRegistry?: ToolRegistry,
    initialHistory?: InitialHistory
  ) {
    this.conversationId = `conv_${uuidv4()}`;

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
    this.toolRegistry = toolRegistry ?? null; // Tool registry from BrowserxAgent

    // Initialize services (merged from initialize() method)
    if (services) {
      this.services = services;
    } else {
      // Services will be created asynchronously if needed
      // For synchronous construction, set to null and create on-demand
      this.services = null;
    }

    // Initialize with default turn context, using config values if available
    // Note: TurnContext requires a ModelClient, which will be set later
    // For now, create a minimal context that will be replaced
    this.turnContext = {} as TurnContext;

    this.activeTurn = new ActiveTurn();

    // Session starts with no tab binding (tabId = -1)
    // Tab binding is handled by the UI when the side panel opens
    this.sessionState.setTabId(-1);

    // Handle initial history
    const historyMode = initialHistory ?? { mode: 'new' as const };

 
    // For 'new' mode, SessionState is already initialized with empty history
    // Initialize session with RolloutRecorder based on history mode (asynchronous)
    // Note: We call initializeSession without await since constructor must be synchronous
    // The initialization happens in the background
    if (historyMode.mode === 'new' || historyMode.mode === 'forked') {
      // Create new rollout
      this.initializeSession('create', this.conversationId, this.config).then(() => {
        // For forked mode, persist the forked history after rollout is created
        if (historyMode.mode === 'forked') {
          const history = this.sessionState.historySnapshot();
          return this.persistRolloutResponseItems(history);
        }
      }).catch(err => {
        console.error('Failed to initialize session:', err);
      });
    } else if (historyMode.mode === 'resumed') {
      // Resume from existing rollout (note: initializeSession will also reconstruct history)
      this.initializeSession('resume', this.conversationId, this.config).catch(err => {
        console.error('Failed to resume session:', err);
      });
    }
  }


  /**
   * Get or create a conversation in storage using RolloutRecorder
   */
  private async getOrCreateConversation(): Promise<string> {
    if (!this.services?.rollout) {
      return this.conversationId;
    }

    // For RolloutRecorder, we don't need to list/find conversations
    // The conversationId is already set and RolloutRecorder handles persistence
    return this.conversationId;
  }

  /**
   * Save current session state to storage using RolloutRecorder
   */
  async saveState(): Promise<void> {
    if (!this.services?.rollout) return;

    // Record session metadata to rollout
    const sessionMetaItems: RolloutItem[] = [{
      type: 'session_meta',
      payload: {
        id: this.conversationId,
        timestamp: new Date().toISOString(),
        tabId: this.sessionState.getTabId(), // T093: Replaced cwd with tabId
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
    this.turnContext = context;
  }

  /**
   * Update turn context with new values
   */
  updateTurnContext(updates: any): void {
    if (this.turnContext && typeof this.turnContext.update === 'function') {
      this.turnContext.update(updates);
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
   * Get session metadata
   */
  getMetadata(): {
    conversationId: string;
    messageCount: number;
    startTime: number;
    currentModel: string;
  } {
    return {
      conversationId: this.conversationId,
      messageCount: this.getMessageCount(),
      startTime: this.sessionState.getConversationHistory().metadata?.startTime || Date.now(),
      currentModel: this.turnContext?.getModel?.() || 'gpt-5',
    };
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
    };
  } {
    return {
      id: this.conversationId,
      state: this.sessionState.export(),
      metadata: {
        created: this.sessionState.getConversationHistory().metadata?.startTime || Date.now(),
        lastAccessed: Date.now(),
      },
    };
  }

  /**
   * Import session from persistence
   */
  static async import(data: {
    id: string;
    state: SessionStateExport;
    metadata: {
      created: number;
      lastAccessed: number;
      messageCount?: number; // Optional for backward compatibility
    };
  }, services?: SessionServices, toolRegistry?: ToolRegistry): Promise<Session> {
    // Create session with resumed history mode (no rollout items since we're importing directly)
    const initialHistory: InitialHistory = { mode: 'new' }; // Use 'new' mode since we're setting state directly
    const session = new Session(undefined, true, services, toolRegistry, initialHistory);

    // Import SessionState
    session.sessionState = SessionState.import(data.state);

    // Set metadata
    Object.assign(session, {
      conversationId: data.id,
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
    return this.sessionState.historySnapshot().filter(item => item.role === role);
  }

  /**
   * Set event emitter for sending events to the queue
   */
  setEventEmitter(emitter: (event: Event) => Promise<void>): void {
    this.eventEmitter = emitter;
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
    return this.conversationId;
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
   * Record turn context for rollout/history
   */
  async recordTurnContext(contextItem: any): Promise<void> {
    // In a full implementation, this would persist turn context
    console.log('Recording turn context:', contextItem);
  }

  /**
   * Compact conversation history to save tokens
   */
  async compact(): Promise<void> {
    const items = this.sessionState.historySnapshot();
    const keepCount = 20;
    if (items.length > keepCount) {
      const kept = items.slice(-keepCount);
      this.sessionState = new SessionState();
      this.sessionState.recordItems(kept);
    }
  }

  /**
   * Build initial context for review mode
   */
  buildInitialContext(turnContext?: any): any[] {
    // T093: Replaced working directory with tab context
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
      const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
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
        conversationId: this.conversationId,
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
    // Clear conversation history
    this.clearHistory();

    // Create new conversation ID
    Object.assign(this, { conversationId: `conv_${uuidv4()}` });

    // Reset tab binding to -1 (unbound)
    // Tab will be auto-bound by UI when side panel reopens
    this.sessionState.setTabId(-1);
    if (this.turnContext && typeof this.turnContext.setTabId === 'function') {
      this.turnContext.setTabId(-1);
    }

    // Reinitialize with RolloutRecorder if enabled
    if (this.isPersistent && this.services?.rollout) {
      try {
        // Record session reset event
        const resetEvent: EventMsg = {
          type: 'BackgroundEvent',
          data: {
            message: `Session reset: new conversation ${this.conversationId}`
          }
        };

        const rolloutItems: RolloutItem[] = [{
          type: 'event_msg',
          payload: resetEvent
        }];

        await this.services.rollout.recordItems(rolloutItems);
      } catch (error) {
        console.error('Failed to record session reset to rollout:', error);
      }
    }

    console.log('Session reset complete:', this.conversationId);
  }

  /**
   * Close session and cleanup resources using RolloutRecorder
   */
  async close(): Promise<void> {
    if (this.services?.rollout) {
      try {
        // Record session close event
        const closeEvent: EventMsg = {
          type: 'BackgroundEvent',
          data: {
            message: `Session closed: ${this.conversationId} (${this.getMessageCount()} messages)`
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
    return this.conversationId;
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
   * Track token usage
   */
  addTokenUsage(tokens: number): void {
    this.sessionState.addTokenUsage(tokens);
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
   * Set tool registry (called by BrowserxAgent)
   */
  setToolRegistry(toolRegistry: ToolRegistry): void {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Initialize session with RolloutRecorder (replaces ConversationStore)
   */
  async initializeSession(
    mode: 'create' | 'resume',
    conversationId: string,
    config?: AgentConfig
  ): Promise<void> {
    try {
      // Strip conv_ prefix if present - RolloutRecorder expects plain UUID
      const uuid = conversationId.startsWith('conv_')
        ? conversationId.slice(5)
        : conversationId;

      if (mode === 'create') {
        // Create new rollout
        const rollout = await RolloutRecorder.create(
          {
            type: 'create',
            conversationId: uuid,
          },
          config as any
        );

        if (this.services) {
          this.services.rollout = rollout;
        }
      } else {
        // Resume from existing rollout
        const rollout = await RolloutRecorder.create(
          {
            type: 'resume',
            rolloutId: uuid,
          },
          config as any
        );

        if (this.services) {
          this.services.rollout = rollout;
        }

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
        type: 'StreamError',
        data: {
          error: message,
          retrying: false,
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
    // Get token info from SessionState
    const tokenInfo = undefined; // Would need getTokenInfo method from SessionState
    const rateLimits = undefined; // Would need getRateLimits method from SessionState

    const event: Event = {
      id: subId,
      msg: {
        type: 'TokenCount',
        data: {
          info: tokenInfo,
          rate_limits: rateLimits,
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
    // Check if task already finished
    // The AbortController will have no effect if the task already completed

    // Abort the task via AbortController
    task.abortController.abort();

    // Emit TurnAborted event
    const event: Event = {
      id: subId,
      msg: {
        type: 'TurnAborted',
        data: {
          reason,
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
    // Take all running tasks
    const tasks = this.takeAllRunningTasks();

    // Abort each task
    const abortPromises: Promise<void>[] = [];
    for (const [subId, task] of tasks) {
      abortPromises.push(this.handleTaskAbort(subId, task, reason));
    }

    // Wait for all aborts to complete (parallel execution)
    await Promise.all(abortPromises);
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
    input: InputItem[]
  ): Promise<void> {
    // Abort all existing tasks before spawning new one
    await this.abortAllTasks('UserInterrupt');

    // Create AbortController for cancellation
    const abortController = new AbortController();

    // Create promise wrapper for task execution
    const promise = (async (): Promise<string | null> => {
      try {
        // Execute task
        const result = await task.run(this, context, subId, input);
        // On success, call completion handler
        await this.onTaskFinished(subId, result);
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
      promise,
      startTime: Date.now()
    };

    // Register as new active task (creates new ActiveTurn and adds task)
    this.registerNewActiveTask(subId, runningTask);

    // Execute asynchronously (fire-and-forget, don't await)
    // The promise will handle completion/abortion internally
  }

  /**
   * Interrupt task
   *
   * Wrapper around abortAllTasks with Interrupted reason.
   * Used when user explicitly interrupts execution.
   */
  async interruptTask(): Promise<void> {
    await this.abortAllTasks('user_interrupt');
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

    try {
      await this.services.rollout.recordItems(rolloutItems);
    } catch (error) {
      console.error('Failed to persist response items to rollout:', error);
      // Non-fatal: rollout persistence failures should not break session
    }
  }

  /**
   * Record conversation items with dual persistence
   *
   * Records ResponseItems to both SessionState (in-memory history) and
   * RolloutRecorder (persistent storage).
   *
   * Enhanced with inline compression logic for DOM snapshots
   *
   * @param items Response items to record
   */
  async recordConversationItemsDual(items: ResponseItem[]): Promise<void> {
    // SessionState (in-memory)
    // If incoming items contain any DOM snapshot output, compress previous snapshot in history
    // This keeps the latest snapshot fresh for LLM reasoning
    if (items.some(item => isDOMSnapshotOutput(item))) {
      // Compress the previous DOM snapshot before recording the new one
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
    this.recordConversationItemsDual(responseItems);

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
          console.error('Failed to persist user message to rollout:', error);
        }
      }
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
      } else if (rolloutItem.type === 'compacted') {
        // Compacted history with summary
        // The compacted item should contain a summary that replaces multiple items
        const compactedData = rolloutItem.payload as any;
        if (compactedData.summary) {
          // Add summary as a system message
          responseItems.push({
            role: 'system',
            content: compactedData.summary,
            type: 'message'
          } as ResponseItem);
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
    const reason: TurnAbortReason = error?.name === 'AbortError' ? 'user_interrupt' : 'error';

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
