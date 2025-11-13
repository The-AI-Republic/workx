/**
 * Main Browserx agent class
 * Implements the SQ/EQ (Submission Queue/Event Queue) architecture
 */

import type { Submission, Op, Event, InputItem, AskForApproval, SandboxPolicy, ReasoningEffortConfig, ReasoningSummaryConfig, ReviewDecision } from '../protocol/types';
import type { EventMsg } from '../protocol/events';
import type { IConfigChangeEvent, IToolsConfig, IModelConfig } from '../config/types';
import { AgentConfig } from '../config/AgentConfig';
import { Session } from './Session';
import { TurnContext } from './TurnContext';
import { ApprovalManager } from './ApprovalManager';
import { DiffTracker } from './DiffTracker';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ModelClientFactory } from '../models/ModelClientFactory';
import { UserNotifier } from './UserNotifier';
import { v4 as uuidv4 } from 'uuid';
import { loadPrompt, loadUserInstructions } from './PromptLoader';
import { RegularTask } from './tasks/RegularTask';
import { registerTools } from '../tools';
import { TabManager } from './TabManager';

/**
 * Main agent class managing the submission and event queues
 * Enhanced with AgentTask integration for coordinated task execution
 */
export class BrowserxAgent {
  private nextId: number = 1;
  private submissionQueue: Submission[] = [];
  private eventQueue: Event[] = [];
  private session: Session;
  private isProcessing: boolean = false;
  private config: AgentConfig;
  private approvalManager: ApprovalManager;
  private diffTracker: DiffTracker;
  private toolRegistry: ToolRegistry;
  private modelClientFactory: ModelClientFactory;
  private userNotifier: UserNotifier;

  constructor(config: AgentConfig) {
    // Config must be provided (use await AgentConfig.getInstance() if needed)
    this.config = config;

    // Initialize components with config
    this.modelClientFactory = new ModelClientFactory();
    this.toolRegistry = new ToolRegistry();
    this.approvalManager = new ApprovalManager(this.config);
    this.diffTracker = new DiffTracker();
    this.userNotifier = new UserNotifier();

    // Initialize session with config and toolRegistry
    this.session = new Session(this.config, true, undefined, this.toolRegistry);
    // Wire up session event emitter to BrowserxAgent's event queue
    this.session.setEventEmitter(async (event: Event) => this.emitEvent(event.msg));

    // Setup event processing for notifications
    this.setupNotificationHandlers();

    // Subscribe to config changes
    this.setupConfigSubscriptions();
  }

  /**
   * Initialize the agent (ensures config is loaded)
   * Creates model client during initialization with nullable API key
   */
  async initialize(): Promise<void> {

    // Initialize model client factory with config
    await this.modelClientFactory.initialize(this.config);

    // Validate API key for selected model's provider
    const configData = this.config.getConfig();
    const selectedModelId = configData.selectedModelId;
    const modelData = this.config.getModelById(selectedModelId);

    if (!modelData) {
      const errorMsg = `Selected model ${selectedModelId} not found in registry`;
      console.error('[BrowserxAgent]', errorMsg);
      throw new Error(errorMsg);
    }

    const providerId = modelData.provider.id;
    const apiKey = await this.config.getProviderApiKey(providerId);

    if (!apiKey || !apiKey.trim()) {
      const warningMsg = `No API key configured for provider: ${modelData.provider.name}. Please configure API key in Settings.`;
      console.warn('[BrowserxAgent]', warningMsg);

      // Emit warning event for UI
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: warningMsg,
          level: 'warning',
        },
      });
    }

    // Register browser automation tools (pass model data for feature filtering)
    await registerTools(this.toolRegistry, this.config.getToolsConfig(), {
      name: modelData.model.name,
      supportsImage: modelData.model.supportsImage
    });

    // Create model client and turn context during initialization
    // API key can be null - validation happens when making API requests
    // Use createClientForCurrentModel() to properly use selectedModelId from config
    const modelClient = await this.modelClientFactory.createClientForCurrentModel();

    // Create initial TurnContext with the model client
    const taskContext = new TurnContext(modelClient, {});

    // Load and set instructions
    const userInstructions = await loadUserInstructions();
    taskContext.setUserInstructions(userInstructions);
    const baseInstructions = await loadPrompt();
    taskContext.setBaseInstructions(baseInstructions);

    // Set the turn context on the session
    this.session.setTurnContext(taskContext);

    // Setup tab closure detection (User Story 2)
    this.setupTabClosureHandler();

    console.log('Agent initialized successfully with model client');
  }

  /**
   * Setup tab closure event handler
   * User Story 2: Detect tab closure and stop execution
   */
  private setupTabClosureHandler(): void {
    const tabBindingManager = TabManager.getInstance();

    // Handle actual tab closure (tab is closed in browser)
    tabBindingManager.onTabClosed(async (sessionId: string, tabId: number) => {
      console.log(`[BrowserxAgent] Tab ${tabId} closed for session ${sessionId}`);

      // Reset session's tabId to -1
      if (this.session && this.session.getId() === sessionId) {
        // Reset tabId using public Session API
        this.session.setTabId(-1);
        console.log(`[BrowserxAgent] Reset tabId to -1 for session ${sessionId}`);

        // Abort all running tasks
        await this.session.abortAllTasks('TabClosed');

        // Show notification to user
        await this.userNotifier.notifyWarning(
          'Tab Closed',
          'The tab was closed. All tasks have been stopped.'
        );

        console.log(`[BrowserxAgent] Stopped tasks and notified user for session ${sessionId}`);
      }
    });

    // Handle tab unbinding (session loses tab, but tab is still open)
    tabBindingManager.onTabUnbound(async (sessionId: string, tabId: number, reason: 'rebind' | 'manual') => {
      console.log(`[BrowserxAgent] Tab ${tabId} unbound from session ${sessionId} (reason: ${reason})`);

      if (this.session && this.session.getId() === sessionId) {
        // Reset tabId using public Session API
        this.session.setTabId(-1);
        console.log(`[BrowserxAgent] Reset tabId to -1 for session ${sessionId}`);

        // Abort all running tasks (tab is no longer accessible to this session)
        await this.session.abortAllTasks('TabClosed');

        // Show different notification based on reason
        if (reason === 'rebind') {
          await this.userNotifier.notifyInfo(
            'Tab Reassigned',
            'The tab was reassigned to another session. Tasks have been stopped.'
          );
        } else {
          await this.userNotifier.notifyInfo(
            'Tab Changed',
            'The session is no longer bound to a tab. Tasks have been stopped.'
          );
        }

        console.log(`[BrowserxAgent] Stopped tasks and notified user for session ${sessionId} (tab unbound)`);
      }
    });
  }

  /**
   * Setup config change subscriptions
   */
  private setupConfigSubscriptions(): void {
    // Subscribe to model config changes
    this.config.on('config-changed', (event: IConfigChangeEvent) => {
      if (event.section === 'model') {
        this.handleModelConfigChange(event);
      }
    });
  }

  /**
   * Handle model configuration changes
   * Reinitializes session when model changes
   */
  private async handleModelConfigChange(event: IConfigChangeEvent): Promise<void> {
    const oldModelId = event.oldValue;
    const newModelId = event.newValue;

    // Reinitialize session when model changes
    if (oldModelId !== newModelId) {
      try {
        // Shutdown existing session
        await this.session.shutdown();

        // Clear conversation history
        this.session.clearHistory();

        // Create new model client for the selected model
        const modelClient = await this.modelClientFactory.createClientForCurrentModel();

        // Create new TurnContext with updated model
        const taskContext = new TurnContext(modelClient, {});
        const userInstructions = await loadUserInstructions();
        taskContext.setUserInstructions(userInstructions);
        const baseInstructions = await loadPrompt();
        taskContext.setBaseInstructions(baseInstructions);

        // Update session with new turn context
        this.session.setTurnContext(taskContext);

        // Reinitialize session
        await this.session.initializeSession('create', this.session.conversationId, this.config);
      } catch (error) {
        console.error('Failed to reinitialize session after model change:', error);
      }
    }

    // Note: UI update is handled by Settings.svelte success message
  }

  /**
   * Submit an operation to the agent
   * Returns the submission ID
   */
  async submitOperation(op: Op): Promise<string> {
    const id = `sub_${this.nextId++}`;
    const submission: Submission = { id, op };

    this.submissionQueue.push(submission);

    // Start processing if not already running
    if (!this.isProcessing) {
      this.processSubmissionQueue();
    }

    return id;
  }

  /**
   * Get the next event from the event queue
   */
  async getNextEvent(): Promise<Event | null> {
    return this.eventQueue.shift() || null;
  }

  /**
   * Process submissions from the queue
   */
  private async processSubmissionQueue(): Promise<void> {
    this.isProcessing = true;

    while (this.submissionQueue.length > 0) {
      const submission = this.submissionQueue.shift()!;

      try {
        await this.handleSubmission(submission);
      } catch (error) {
        this.emitEvent({
          type: 'Error',
          data: {
            message: error instanceof Error ? error.message : 'Unknown error occurred',
          },
        });
      }
    }

    this.isProcessing = false;
  }

  /**
   * Handle a single submission
   */
  private async handleSubmission(submission: Submission): Promise<void> {
    // Emit TaskStarted event
    this.emitEvent({
      type: 'TaskStarted',
      data: {
        model_context_window: undefined, // Will be set when model is connected
      },
    });

    try {
      switch (submission.op.type) {
        case 'Interrupt':
          await this.handleInterrupt();
          break;

        case 'UserInput':
          await this.handleUserInput(submission.op);
          break;

        case 'UserTurn':
          await this.handleUserTurn(submission.op);
          break;

        case 'OverrideTurnContext':
          await this.handleOverrideTurnContext(submission.op);
          break;

        case 'ExecApproval':
          await this.handleExecApproval(submission.op);
          break;

        case 'PatchApproval':
          await this.handlePatchApproval(submission.op);
          break;

        case 'AddToHistory':
          await this.handleAddToHistory(submission.op);
          break;

        case 'GetPath':
          await this.handleGetPath();
          break;

        case 'Compact':
          await this.handleCompact();
          break;

        case 'GetHistoryEntryRequest':
          await this.handleGetHistoryEntryRequest(submission.op);
          break;

        case 'Shutdown':
          await this.handleShutdown();
          break;

        default:
          // Handle other op types
          this.emitEvent({
            type: 'AgentMessage',
            data: {
              message: `Operation type ${(submission.op as any).type} not yet implemented`,
            },
          });
      }
    } catch (error) {
      // Emit TurnAborted event on error
      this.emitEvent({
        type: 'TurnAborted',
        data: {
          reason: 'error',
          submission_id: submission.id,
        },
      });
      throw error;
    }
  }

  /**
   * Handle interrupt operation
   * Updated (Feature 012): Delegate to Session.abortAllTasks()
   */
  private async handleInterrupt(): Promise<void> {
    // Set interrupt flag in session
    this.session.requestInterrupt();

    // Clear the submission queue
    this.submissionQueue = [];

    // Notify user about interruption
    await this.userNotifier.notifyWarning(
      'Task Interrupted',
      'The current task has been interrupted by user request'
    );

    this.emitEvent({
      type: 'TurnAborted',
      data: {
        reason: 'user_interrupt',
      },
    });

    // Delegate to Session.abortAllTasks() (Feature 012: Session task management)
    // Session will abort all tasks and emit TurnAborted events
    await this.session.abortAllTasks('UserInterrupt');

    // Clear interrupt flag after handling
    this.session.clearInterrupt();
  }

  /**
   * Process user input with SessionTask
   * Common method for handling both handleUserInput and handleUserTurn
   * Updated (Feature 012): Use RegularTask and delegate to Session.spawnTask()
   */
  private async processUserInputWithTask(
    items: Array<any>,
    contextOverrides?: {
      cwd?: string;
      approval_policy?: AskForApproval;
      sandbox_policy?: SandboxPolicy;
      model?: string;
      effort?: ReasoningEffortConfig;
      summary?: ReasoningSummaryConfig;
      final_output_json_schema?: any;
    },
    newTask: boolean = false
  ): Promise<void> {
    try {
      // T045-T049: User Story 2 - Automatic tab creation on first message
      // Check if session has no tab bound (tabId = -1) and create one
      const currentTabId = this.session.getTabId();
      if (currentTabId === -1) {
        console.log('[BrowserxAgent] No tab bound to session, creating new tab');
        try {
          // T046: Call TabManager.createAndBindTab() with about:blank URL
          const tabManager = TabManager.getInstance();
          const newTabId = await tabManager.createAndBindTab(this.session.getId(), {
            url: 'about:blank',
            active: false,
          });

          if (newTabId) {
            // T047: Update session's tabId after successful tab creation
            this.session.setTabId(newTabId);
            console.log(`[BrowserxAgent] Created and bound new tab ${newTabId} to session ${this.session.getId()}`);
            // T049: Tab is automatically added to "browserx" group by TabManager.createAndBindTab
          } else {
            // T048: Add error handling for tab creation failures
            const errorMsg = 'Failed to create tab for session: tab creation returned null';
            console.error(`[BrowserxAgent] ${errorMsg}`);
            await this.userNotifier.notifyError(
              'Tab Creation Failed',
              'Could not create a browser tab for this session. Please try again or manually create a tab.'
            );
            throw new Error(errorMsg);
          }
        } catch (error) {
          // T048: Handle any errors during tab creation
          const errorMsg = error instanceof Error ? error.message : 'Unknown error during tab creation';
          console.error('[BrowserxAgent] Error creating tab:', errorMsg);
          await this.userNotifier.notifyError(
            'Tab Creation Failed',
            `Failed to create browser tab: ${errorMsg}`
          );
          throw error;
        }
      }

      // Convert input items to InputItem format for SessionTask
      const inputItems: InputItem[] = items.map(item => ({
        type: item.type || 'text',
        text: item.type === 'text' ? item.text || '' : undefined,
      }));

      // Get existing turn context (created during initialize())
      let taskContext = this.session.getTurnContext();

      // If context overrides are provided, update the turn context
      if (contextOverrides) {
        if (taskContext) {
          // Update existing context with overrides
          // Note: model override is no longer supported - use AgentConfig.selectModel() instead
          this.session.updateTurnContext(contextOverrides);
        }
      }

      if (!taskContext) {
        throw new Error('Turn context not initialized');
      }

      // Create RegularTask instance (Feature 011 architecture)
      // RegularTask will delegate to AgentTask → TaskRunner
      const task = new RegularTask();

      // Generate submission ID
      const submissionId = uuidv4();

      // Delegate to Session.spawnTask() (Feature 012: Session task management)
      // Session will manage task lifecycle, emit events, and handle abortion
      await this.session.spawnTask(task, taskContext, submissionId, inputItems);

      // Note: Session.spawnTask() is fire-and-forget
      // Task completion/abortion events are emitted by Session via eventEmitter
      // We don't need to wait for completion or manually manage activeTask

    } catch (error) {
      console.error('Error processing user input:', error);

      // Check if this is an API key error and emit appropriate event
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred during task execution';
      const isApiKeyError = errorMessage.includes('No API key configured');

      // Get provider name for better error message
      let providerName = 'the selected provider';
      try {
        const configData = this.config.getConfig();
        const modelData = this.config.getModelById(configData.selectedModelId);
        if (modelData) {
          providerName = modelData.provider.name;
        }
      } catch (e) {
        // Ignore error getting provider name
      }

      const userFriendlyMessage = isApiKeyError
        ? `Cannot execute task: No API key configured for ${providerName}. Please go to Settings → Model Configuration and add your API key.`
        : errorMessage;

      this.emitEvent({
        type: 'Error',
        data: {
          message: userFriendlyMessage,
          code: isApiKeyError ? 'API_KEY_REQUIRED' : undefined,
        },
      });

      throw error;
    }
  }

  /**
   * Handle user input
   * Uses the current persistent TurnContext
   */
  private async handleUserInput(op: Extract<Op, { type: 'UserInput' }>): Promise<void> {
    this.session.addPendingInput(op.items);
    await this.processUserInputWithTask(op.items, undefined, true);
  }

  /**
   * Handle user turn with full context using AgentTask
   * Allows per-turn overrides of the context
   */
  private async handleUserTurn(op: Extract<Op, { type: 'UserTurn' }>): Promise<void> {
    await this.processUserInputWithTask(op.items, {
      tabId: op.tabId, // T093: Replaced cwd with tabId
      approval_policy: op.approval_policy,
      sandbox_policy: op.sandbox_policy,
      model: op.model,
      effort: op.effort,
      summary: op.summary,
    });
  }

  /**
   * Cancel a running task
   * Updated (Feature 012): Use Session.abortAllTasks()
   */
  async cancelTask(submissionId: string): Promise<void> {
    // Check if task is running in Session
    if (this.session.hasRunningTask(submissionId)) {
      // Abort the specific task (currently aborts all tasks)
      await this.session.abortAllTasks('UserInterrupt');
    }
  }

  /**
   * Handle override turn context
   */
  private async handleOverrideTurnContext(
    op: Extract<Op, { type: 'OverrideTurnContext' }>
  ): Promise<void> {
    // Partial update of turn context
    const updates: any = {};

    if (op.tabId !== undefined) updates.tabId = op.tabId; // T093: Replaced cwd with tabId
    if (op.approval_policy !== undefined) updates.approval_policy = op.approval_policy;
    if (op.sandbox_policy !== undefined) updates.sandbox_policy = op.sandbox_policy;
    if (op.model !== undefined) updates.model = op.model;
    if (op.effort !== undefined) updates.effort = op.effort;
    if (op.summary !== undefined) updates.summary = op.summary;

    this.session.updateTurnContext(updates);
  }

  /**
   * Handle exec approval
   */
  private async handleExecApproval(op: Extract<Op, { type: 'ExecApproval' }>): Promise<void> {
    // Resolve the pending approval through Session
    await this.session.notifyApproval(op.id, op.decision);

    // Emit event
    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Execution ${op.decision === 'approve' ? 'approved' : 'rejected'}: ${op.id}`,
        level: 'info',
      },
    });
  }

  /**
   * Handle patch approval
   */
  private async handlePatchApproval(op: Extract<Op, { type: 'PatchApproval' }>): Promise<void> {
    // Resolve the pending approval through Session
    await this.session.notifyApproval(op.id, op.decision);

    // Emit event
    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Patch ${op.decision === 'approve' ? 'approved' : 'rejected'}: ${op.id}`,
        level: 'info',
      },
    });
  }

  /**
   * Handle add to history
   */
  private async handleAddToHistory(op: Extract<Op, { type: 'AddToHistory' }>): Promise<void> {
    this.session.addToHistory({
      timestamp: Date.now(),
      text: op.text,
      type: 'user',
    });
  }

  /**
   * Handle get path request
   */
  private async handleGetPath(): Promise<void> {
    const conversationHistory = this.session.getConversationHistory();
    this.emitEvent({
      type: 'ConversationPath',
      data: {
        path: this.session.conversationId,
        messages_count: conversationHistory.items.length,
      },
    });
  }

  /**
   * Handle shutdown
   */
  private async handleShutdown(): Promise<void> {
    // Clean up and emit shutdown complete
    this.submissionQueue = [];
    this.eventQueue = [];

    this.emitEvent({
      type: 'ShutdownComplete',
    });
  }

  /**
   * Handle compact operation
   * Triggers conversation history compaction to reduce token usage
   */
  private async handleCompact(): Promise<void> {
    try {
      // Emit background event indicating compaction started
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: 'History compaction started',
          level: 'info',
        },
      });

      // Get history size before compaction
      const historyBefore = this.session.getConversationHistory().items.length;

      // Perform compaction
      await this.session.compact();

      // Get history size after compaction
      const historyAfter = this.session.getConversationHistory().items.length;

      // Emit background event indicating compaction completed
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `History compaction completed: ${historyBefore} → ${historyAfter} items`,
          level: 'info',
        },
      });
    } catch (error) {
      this.emitEvent({
        type: 'Error',
        data: {
          message: `History compaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      });
      throw error;
    }
  }

  /**
   * Handle get history entry request
   * Returns a specific entry from the conversation history
   */
  private async handleGetHistoryEntryRequest(
    op: Extract<Op, { type: 'GetHistoryEntryRequest' }>
  ): Promise<void> {
    try {
      const entry = this.session.getHistoryEntry(op.index);

      if (entry) {
        // Emit event with the history entry
        this.emitEvent({
          type: 'BackgroundEvent',
          data: {
            message: `History entry ${op.index}: ${JSON.stringify(entry).substring(0, 100)}...`,
            level: 'info',
          },
        });
      } else {
        // Emit error if entry not found
        this.emitEvent({
          type: 'Error',
          data: {
            message: `History entry ${op.index} not found`,
          },
        });
      }
    } catch (error) {
      this.emitEvent({
        type: 'Error',
        data: {
          message: `Failed to get history entry: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      });
      throw error;
    }
  }

  /**
   * Emit an event to the event queue
   */
  private emitEvent(msg: EventMsg): void {
    const event: Event = {
      id: `evt_${this.nextId++}`,
      msg,
    };

    this.eventQueue.push(event);

    // Process event for user notifications
    this.userNotifier.processEvent(event);

    // Notify listeners via Chrome runtime if available
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'EVENT',
        payload: event,
      }).catch(() => {
        // Ignore errors if no listeners
      });
    }
  }

  /**
   * Get the current session
   */
  getSession(): Session {
    return this.session;
  }


  /**
   * Get the model client factory
   */
  getModelClientFactory(): ModelClientFactory {
    return this.modelClientFactory;
  }

  /**
   * Get the tool registry
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Get the approval manager
   */
  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  /**
   * Get the diff tracker
   */
  getDiffTracker(): DiffTracker {
    return this.diffTracker;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await this.toolRegistry.cleanup();
    this.toolRegistry.clear();
    this.submissionQueue = [];
    this.eventQueue = [];
    await this.userNotifier.clearAll();
  }

  /**
   * Setup notification handlers
   */
  private setupNotificationHandlers(): void {
    // Register notification callback for UI updates
    this.userNotifier.onNotification((notification) => {
      // Emit notification event for UI
      this.emitEvent({
        type: 'Notification',
        data: {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          timestamp: notification.timestamp,
        },
      });
    });
  }

  /**
   * Handle approval decision
   */
  private async handleApprovalDecision(
    approvalId: string,
    decision: 'approve' | 'reject'
  ): Promise<void> {
    // Process the approval decision
    const pendingApproval = this.approvalManager.getApproval(approvalId);
    if (!pendingApproval) return;

    const approval = pendingApproval.request;

    // Submit the decision as an operation based on approval type
    const reviewDecision: ReviewDecision = decision === 'approve'
      ? 'approve'
      : 'reject';

    const op: Op = approval.type === 'command'
      ? {
          type: 'ExecApproval',
          id: approvalId,
          decision: reviewDecision,
        }
      : {
          type: 'PatchApproval',
          id: approvalId,
          decision: reviewDecision,
        };

    await this.submitOperation(op);
  }

  /**
   * Get user notifier
   */
  getUserNotifier(): UserNotifier {
    return this.userNotifier;
  }

  /**
   * Check if agent is ready to accept commands
   * Returns true if API key is configured for the selected model's provider
   */
  async isReady(): Promise<{ ready: boolean; message?: string; provider?: string; model?: string }> {
    try {
      const configData = this.config.getConfig();
      const selectedModelId = configData.selectedModelId;
      const modelData = this.config.getModelById(selectedModelId);

      if (!modelData) {
        return {
          ready: false,
          message: `Selected model ${selectedModelId} not found in registry`,
        };
      }

      const providerId = modelData.provider.id;
      const apiKey = await this.config.getProviderApiKey(providerId);

      if (!apiKey || !apiKey.trim()) {
        return {
          ready: false,
          message: `No API key configured for ${modelData.provider.name}`,
          provider: modelData.provider.name,
          model: modelData.model.name,
        };
      }

      return {
        ready: true,
        provider: modelData.provider.name,
        model: modelData.model.name,
      };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : 'Unknown error checking agent status',
      };
    }
  }

  /**
   * Handle interruption
   */
  async interrupt(): Promise<void> {
    // Request interrupt on session
    this.session.requestInterrupt();

    // Notify user
    await this.userNotifier.notifyInfo(
      'Interruption Requested',
      'The current task will be interrupted'
    );

    // Submit interrupt operation
    await this.submitOperation({ type: 'Interrupt' });
  }

  /**
   * Show progress notification
   */
  async showProgress(
    title: string,
    message: string,
    current: number,
    total: number
  ): Promise<string> {
    return this.userNotifier.notifyProgress(title, message, current, total);
  }

  /**
   * Update progress notification
   */
  async updateProgress(
    notificationId: string,
    current: number,
    total: number
  ): Promise<void> {
    await this.userNotifier.updateProgress(notificationId, current, total);
  }
}