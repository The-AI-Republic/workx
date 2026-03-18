/**
 * Main RepublicAgent class
 * Implements the SQ/EQ (Submission Queue/Event Queue) architecture
 */

import type { Submission, Op, InputItem, AskForApproval, SandboxPolicy, ReasoningEffortConfig, ReasoningSummaryConfig, ReviewDecision } from './protocol/types';
import type { Event, EventMsg } from './protocol/events';
import type { IConfigChangeEvent, IToolsConfig, IModelConfig } from '../config/types';
import type { AgentReadyState } from './models/types/Auth';
import type { InitialHistory } from './session/state/types';
import { AgentConfig } from '../config/AgentConfig';
import { Session } from './Session';
import { TurnContext } from './TurnContext';
import { ApprovalManager } from './ApprovalManager';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ModelClientFactory } from './models/ModelClientFactory';
import { type IUserNotifier, NoOpNotifier } from './IUserNotifier';
import { v4 as uuidv4 } from 'uuid';
import { loadPrompt, loadUserInstructions, configurePromptComposer, isComposerConfigured, registerPromptExtension, unregisterPromptExtension } from './PromptLoader';
import { RegularTask } from './tasks/RegularTask';
import { registerPlatformTools } from '../tools/registerPlatformTools';
import { TabManager } from './TabManager';

/**
 * Main agent class managing the submission and event queues
 * Enhanced with AgentTask integration for coordinated task execution
 * Feature 015: Now supports agentId for multi-agent instance tracking
 */
/**
 * Event dispatcher function type
 * Used to route events to UI channels without hardcoding chrome.runtime
 */
export type EventDispatcher = (event: Event) => void | Promise<void>;

export class RepublicAgent {
  private _agentId: string;
  private nextId: number = 1;
  private submissionQueue: Submission[] = [];
  private eventQueue: Event[] = [];
  private session: Session;
  private isProcessing: boolean = false;
  private config: AgentConfig;
  private approvalManager: ApprovalManager;
  private toolRegistry: ToolRegistry;
  private modelClientFactory: ModelClientFactory;
  private userNotifier: IUserNotifier;
  private eventDispatcher: EventDispatcher | null = null;
  // Non-null signals a deferred model switch. The actual model is resolved from
  // AgentConfig.selectedModelKey (which is updated before the config-changed event
  // fires), so the stored value is only used as a "switch pending" flag.
  private pendingModelKey: string | null = null;

  constructor(config: AgentConfig, initialHistory?: InitialHistory, agentId?: string, userNotifier?: IUserNotifier) {
    // Generate or use provided agentId for multi-instance tracking (Feature 015)
    this._agentId = agentId ?? `agent_${uuidv4()}`;

    // Config must be provided (use await AgentConfig.getInstance() if needed)
    this.config = config;

    // Initialize components with config
    this.modelClientFactory = new ModelClientFactory();
    this.toolRegistry = new ToolRegistry();
    this.approvalManager = new ApprovalManager(this.config, (event) => this.emitEvent(event.msg));
    this.userNotifier = userNotifier ?? new NoOpNotifier();

    // Initialize session with config and toolRegistry
    this.session = new Session(this.config, true, undefined, this.toolRegistry, initialHistory);
    // Wire up session event emitter to RepublicAgent's event queue
    this.session.setEventEmitter(async (event: Event) => this.emitEvent(event.msg));

    // Setup event processing for notifications
    this.setupNotificationHandlers();

    // Subscribe to config changes
    this.setupConfigSubscriptions();
  }

  /**
   * Get the unique agent ID for this instance
   * Used for multi-agent instance tracking (Feature 015)
   */
  get agentId(): string {
    return this._agentId;
  }

  /**
   * Initialize the agent (ensures config is loaded)
   * Creates model client during initialization with nullable API key
   */
  async initialize(): Promise<void> {
    // Wait for session background initialization (memory service, rollout, etc.)
    await this.session.initialize();

    // Initialize model client factory with config
    await this.modelClientFactory.initialize(this.config);

    // Validate API key for selected model's provider (only if not using backend routing)
    const configData = this.config.getConfig();
    const selectedModelKey = configData.selectedModelKey;
    const modelData = this.config.getModelByKey(selectedModelKey);

    if (!modelData) {
      const errorMsg = `Selected model ${selectedModelKey} not found`;
      console.error('[RepublicAgent]', errorMsg);
      throw new Error(errorMsg);
    }

    // Skip API key validation if using backend routing (user is logged in)
    if (!this.modelClientFactory.isBackendRouting()) {
      const providerId = modelData.provider.id;
      const apiKey = await this.config.getProviderApiKey(providerId);

      if (!apiKey || !apiKey.trim()) {
        const warningMsg = `No API key configured for provider: ${modelData.provider.name}. Please configure API key in Settings.`;
        console.warn('[RepublicAgent]', warningMsg);

        // Emit warning event for UI
        this.emitEvent({
          type: 'BackgroundEvent',
          data: {
            message: warningMsg,
            level: 'warning',
          },
        });
      }
    }

    // Register platform tools (pass model data for feature filtering)
    await registerPlatformTools(this.toolRegistry, this.config.getToolsConfig(), {
      name: modelData.model.name,
      supportsImage: modelData.model.supportsImage
    });

    // Register/unregister memory tools based on current memory service state
    await this.syncMemoryTools();

    // Create model client and turn context during initialization
    // API key can be null - validation happens when making API requests
    // Use createClientForCurrentModel() to properly use selectedModelKey from config
    const modelClient = await this.modelClientFactory.createClientForCurrentModel();

    // Create initial TurnContext with the model client
    const taskContext = new TurnContext(modelClient, {
      sessionId: this.session.sessionId
    });

    // Configure PromptComposer for dynamic system prompt composition
    await this.configurePromptComposition();

    // Load and set instructions
    const userInstructions = await loadUserInstructions();
    taskContext.setUserInstructions(userInstructions);
    const baseInstructions = await loadPrompt();
    taskContext.setBaseInstructions(baseInstructions);

    // Set the turn context on the session
    this.session.setTurnContext(taskContext);

    console.log('[RepublicAgent] DEBUG: initialize() complete');
  }

  /**
   * Configure PromptComposer for dynamic system prompt composition.
   * Detects agent type from build mode and sets basic context.
   *
   * In desktop mode, DesktopAgentBootstrap calls configurePromptComposer()
   * with full platform context (OS, arch, shell, homeDir) BEFORE
   * agent.initialize(), so this method skips re-configuration.
   *
   * In extension mode, this configures the extension agent type.
   */
  private async configurePromptComposition(): Promise<void> {
    // Skip if already configured (desktop bootstrap provides platform context)
    if (isComposerConfigured()) {
      console.log('[RepublicAgent] PromptComposer already configured (by bootstrap)');
      return;
    }

    const agentType = (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop')
      ? 'applepi' as const
      : 'browserx' as const;

    configurePromptComposer(agentType, {
      browserConnection: agentType === 'browserx' ? 'extension' : 'mcp',
    });
    console.log(`[RepublicAgent] PromptComposer configured for agent type: ${agentType}`);
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
   * Preserves conversation history and updates the model client in-place.
   * If a task is running, defers the switch until the next user submission.
   */
  private async handleModelConfigChange(event: IConfigChangeEvent): Promise<void> {
    const oldModelId = event.oldValue;
    const newModelId = event.newValue;

    if (oldModelId === newModelId) return;

    // Check if a task is currently running
    if (this.session.getRunningTasks().size > 0) {
      // Defer the model switch until the next user submission
      this.pendingModelKey = newModelId;
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `Model switch to ${newModelId} will take effect after the current task completes.`,
          level: 'info',
        },
      });
      return;
    }

    // No task running — apply model switch immediately
    // Clear any stale pending key from a prior deferred switch
    this.pendingModelKey = null;
    try {
      const modelClient = await this.modelClientFactory.createClientForCurrentModel();
      const turnCtx = this.session.getTurnContext();
      turnCtx.setModelClient(modelClient);
      turnCtx.setSelectedModelKey(newModelId);
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `Model switched to ${newModelId}. Conversation preserved.`,
          level: 'info',
        },
      });
    } catch (error) {
      console.error('Failed to switch model:', error);
      this.emitEvent({
        type: 'Error',
        data: {
          message: `Failed to switch model: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      });
    }
  }

  /**
   * Sync memory tools in the ToolRegistry with the current memory service state.
   * Registers tools if memory is enabled, unregisters if disabled.
   * Safe to call repeatedly — idempotent.
   */
  private static readonly MEMORY_TOOL_NAMES = ['save_memory', 'search_memory', 'forget_memory'];
  private static readonly MEMORY_PROMPT_EXTENSION = 'memory';

  private async syncMemoryTools(): Promise<void> {
    const ms = this.session.getMemoryService();

    if (ms) {
      // Register tools if not already present
      const hasMemoryTools = this.toolRegistry.getTool('save_memory') !== null;
      if (!hasMemoryTools) {
        const { registerMemoryTools } = await import('../tools/MemoryTools');
        await registerMemoryTools(this.toolRegistry, () => this.session.getMemoryService());
      }

      // Register prompt extension for core memory injection
      registerPromptExtension(RepublicAgent.MEMORY_PROMPT_EXTENSION, () => {
        const svc = this.session.getMemoryService();
        return svc ? svc.getCachedGlobalContext() : '';
      });
    } else {
      // Unregister tools
      for (const name of RepublicAgent.MEMORY_TOOL_NAMES) {
        if (this.toolRegistry.getTool(name) !== null) {
          await this.toolRegistry.unregister(name);
        }
      }

      // Unregister prompt extension
      unregisterPromptExtension(RepublicAgent.MEMORY_PROMPT_EXTENSION);
    }
  }

  /**
   * Refresh the model client when auth state changes
   * Called when INIT_AUTH is received to update the client with new routing
   */
  async refreshModelClient(): Promise<void> {
    try {
      // Create new model client with current auth state
      const modelClient = await this.modelClientFactory.createClientForCurrentModel();

      // Create new TurnContext with updated model client
      const taskContext = new TurnContext(modelClient, {});
      const userInstructions = await loadUserInstructions();
      taskContext.setUserInstructions(userInstructions);
      const baseInstructions = await loadPrompt();
      taskContext.setBaseInstructions(baseInstructions);

      // Update session with new turn context
      this.session.setTurnContext(taskContext);
      await this.session.refreshMemoryService(this.config);
      await this.syncMemoryTools();
    } catch (error) {
      console.error('[RepublicAgent] Failed to refresh model client:', error);
    }
  }

  /**
   * Hot-swap the model client in-place on the existing TurnContext.
   * Preserves conversation history and agent run state.
   * Used by desktop CONFIG_UPDATE to apply settings without reinitializing.
   */
  async hotSwapModelClient(): Promise<void> {
    // Clear cached clients so the factory creates fresh ones with updated config
    this.modelClientFactory.clearCache();

    const modelClient = await this.modelClientFactory.createClientForCurrentModel();
    const turnCtx = this.session.getTurnContext();
    const newModelKey = this.config.getConfig().selectedModelKey;

    turnCtx.setModelClient(modelClient);
    turnCtx.setSelectedModelKey(newModelKey);

    // Reload instructions so prompt-relevant config changes take effect
    const userInstructions = await loadUserInstructions();
    turnCtx.setUserInstructions(userInstructions);
    const baseInstructions = await loadPrompt();
    turnCtx.setBaseInstructions(baseInstructions);
    await this.session.refreshMemoryService(this.config);
    await this.syncMemoryTools();
  }

  /**
   * Submit an operation to the agent
   * Returns the submission ID
   */
  async submitOperation(op: Op, context?: { tabId?: number }): Promise<string> {
    const id = `sub_${this.nextId++}`;
    const submission: Submission = { id, op, context };

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
    try {
      switch (submission.op.type) {
        case 'Interrupt':
          await this.handleInterrupt();
          break;

        case 'UserInput':
          await this.handleUserInput(submission.op, submission.context);
          break;

        case 'UserTurn':
          await this.handleUserTurn(submission.op, submission.context);
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
          await this.handleCompact('auto');
          break;

        case 'ManualCompact':
          await this.handleCompact('manual');
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
   * Handle tab binding/creation/switching based on session state and context
   * @param submissionContext - Context containing optional tabId
   */
  private async handleTabBinding(submissionContext?: { tabId?: number }): Promise<void> {
    const currentTabId = this.session.getTabId();
    const newTabId = submissionContext?.tabId ?? -1; // Default to -1 if not provided

    const tabManager = TabManager.getInstance();

    // ================================================================
    // CASE 1: newTabId is -1 → Create a new tab
    // ================================================================
    if (newTabId === -1) {
      try {
        // Server mode: no real tabs — use sentinel tabId
        if (__BUILD_MODE__ === 'server') {
          this.session.setTabId(1);
          this.emitEvent({
            type: 'StateUpdate',
            data: { sessionId: this.session.getId(), tabId: 1 },
          });
        }
        // Desktop mode: ensure chrome-devtools-mcp is connected.
        // chrome-devtools-mcp launches Chrome with a default page — no need to
        // call new_page. The agent will use navigate_page to go where it needs.
        else if (__BUILD_MODE__ === 'desktop') {
          try {
            const { MCPManager } = await import('./mcp/MCPManager');
            const { registerMCPTools } = await import('./mcp/MCPToolAdapter');
            const mcpManager = await MCPManager.getInstance('desktop');
            const browserServer = mcpManager.getServerByName('browser');
            if (browserServer) {
              await mcpManager.connect(browserServer.id);

              // Verify tools were actually discovered
              const connection = mcpManager.getConnection(browserServer.id);
              if (connection && connection.tools.length > 0) {
                // Lazily register tools if they weren't registered at startup
                if (!this.toolRegistry.getTool(`browser__${connection.tools[0].name}`)) {
                  const { McpBrowserRiskAssessor } = await import('./approval/assessors/McpBrowserRiskAssessor');
                  await registerMCPTools(mcpManager, 'browser', connection.tools, this.toolRegistry, new McpBrowserRiskAssessor());
                }
              } else {
                const warnMsg = 'Browser MCP server connected but no tools were discovered. Browser automation will not work.';
                console.warn(`[RepublicAgent] ${warnMsg}`);
                this.emitEvent({
                  type: 'BackgroundEvent',
                  data: { message: warnMsg, level: 'warning' },
                });
              }
            } else {
              const warnMsg = 'Builtin browser server not found in MCPManager. Browser tools will be unavailable.';
              console.warn(`[RepublicAgent] ${warnMsg}`);
              this.emitEvent({
                type: 'BackgroundEvent',
                data: { message: warnMsg, level: 'warning' },
              });
            }
          } catch (mcpError) {
            const errorMsg = mcpError instanceof Error ? mcpError.message : String(mcpError);
            console.error(`[RepublicAgent] Desktop mode: browser MCP server connection failed: ${errorMsg}`);
            this.emitEvent({
              type: 'BackgroundEvent',
              data: {
                message: `Browser tools unavailable: ${errorMsg}`,
                level: 'warning',
              },
            });
            // Don't fail the submission — tools will return errors to the LLM
          }

          // Use sentinel tabId=1 since MCP manages page state internally
          const createdTabId = 1;

          this.session.setTabId(createdTabId);

          this.emitEvent({
            type: 'StateUpdate',
            data: { sessionId: this.session.getId(), tabId: createdTabId },
          });
        } else {
          // Extension mode: use Chrome extension TabManager
          const createdTabId = await tabManager.createTab({
            url: 'about:blank',
            active: false,
          });
          const oldTabId = currentTabId;
          if (oldTabId !== -1) {
            await tabManager.clearAllTabsFromGroup();
          }

          if (createdTabId) {
            // Update session's tabId (SessionState is the source of truth)
            this.session.setTabId(createdTabId);

            // Add tab to ApplePi group
            await tabManager.addTabToGroup(createdTabId);

            // Notify UI of tab binding update
            this.emitEvent({
              type: 'StateUpdate',
              data: { sessionId: this.session.getId(), tabId: createdTabId },
            });
          } else {
            const errorMsg = 'Failed to create tab for session: tab creation returned null';

            // Emit error to chat UI
            this.emitEvent({
              type: 'Error',
              data: {
                message: 'Failed to create a new tab. Please try again.',
              },
            });

            throw new Error(errorMsg);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error during tab creation';

        // Emit error to chat UI
        this.emitEvent({
          type: 'Error',
          data: {
            message: `Failed to create browser tab: ${errorMsg}`,
          },
        });

        throw error;
      }
    }
    // ================================================================
    // CASE 2: newTabId === currentTabId → Check health, don't rebind
    // ================================================================
    else if (newTabId === currentTabId) {

      // Desktop/server mode: tab health is not managed by Chrome extension TabManager
      if (__BUILD_MODE__ !== 'desktop' && __BUILD_MODE__ !== 'server') {
        const validation = await tabManager.validateTab(currentTabId);

        if (validation.status === 'invalid') {
          const errorMsg = `Current tab ${currentTabId} is not healthy. Reason: ${validation.reason}`;

          // Emit error to chat UI
          this.emitEvent({
            type: 'Error',
            data: {
              message: `The current tab is not valid (${validation.reason}). Please select a valid tab.`,
            },
          });

          throw new Error(errorMsg);
        }
      }

    }
    // ================================================================
    // CASE 3: newTabId !== currentTabId → Switch to new tab
    // ================================================================
    else {

      if (__BUILD_MODE__ === 'desktop' || __BUILD_MODE__ === 'server') {
        // Desktop/server mode: just update session tabId (no tab groups, no extension validation)
        this.session.setTabId(newTabId);
      } else {
        // Extension mode: validate tab and manage tab groups
        const validation = await tabManager.validateTab(newTabId);

        if (validation.status !== 'valid') {
          const errorMsg = validation.status === 'invalid'
            ? `Tab ${newTabId} is not valid. Reason: ${validation.reason}`
            : `Tab ${newTabId} validation is still in progress`;

          // Emit error to chat UI
          this.emitEvent({
            type: 'Error',
            data: {
              message: validation.status === 'invalid'
                ? `The selected tab (ID: ${newTabId}) is not valid (${validation.reason}). Please select a valid tab and try again.`
                : `Unable to validate tab ${newTabId}. Please try again.`,
            },
          });

          throw new Error(errorMsg);
        }

        // Tab is valid, proceed with switching
        try {
          // Clear all tabs from group if it exists
          if (currentTabId !== -1) {
            await tabManager.clearAllTabsFromGroup();
          }

          // Update session's tabId (SessionState is the source of truth)
          this.session.setTabId(newTabId);

          // Add new tab to ApplePi group
          await tabManager.addTabToGroup(newTabId);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error during tab switching';

          // Emit error to chat UI
          this.emitEvent({
            type: 'Error',
            data: {
              message: `Failed to switch to tab ${newTabId}: ${errorMsg}`,
            },
          });

          throw error;
        }
      }
    }


    // Emit state update event to notify UI of tab binding change
    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Tab binding updated: session ${this.session.getId()} now bound to tab ${this.session.getTabId()}`,
        level: 'info',
      },
    });
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
    newTask: boolean = false,
    submissionContext?: { tabId?: number }
  ): Promise<void> {
    try {

      // Handle tab binding/creation/switching
      await this.handleTabBinding(submissionContext);

      // Apply pending model switch before processing the new submission
      if (this.pendingModelKey !== null) {
        const deferredKey = this.pendingModelKey;
        this.pendingModelKey = null;
        try {
          const newClient = await this.modelClientFactory.createClientForCurrentModel();
          const turnCtx = this.session.getTurnContext();
          turnCtx.setModelClient(newClient);
          turnCtx.setSelectedModelKey(deferredKey);
        } catch (error) {
          console.error('Failed to apply pending model switch:', error);
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
        const modelData = this.config.getModelByKey(configData.selectedModelKey);
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
        },
      });

      throw error;
    }
  }

  /**
   * Handle user input
   * Uses the current persistent TurnContext
   */
  private async handleUserInput(
    op: Extract<Op, { type: 'UserInput' }>,
    context?: { tabId?: number }
  ): Promise<void> {

    this.session.addPendingInput(op.items);
    await this.processUserInputWithTask(op.items, undefined, true, context);

  }

  /**
   * Handle user turn with full context using AgentTask
   * Allows per-turn overrides of the context
   */
  private async handleUserTurn(
    op: Extract<Op, { type: 'UserTurn' }>,
    context?: { tabId?: number }
  ): Promise<void> {
    await this.processUserInputWithTask(op.items, {
      approval_policy: op.approval_policy,
      sandbox_policy: op.sandbox_policy,
      model: op.model,
      effort: op.effort,
      summary: op.summary,
    }, true, { tabId: op.tabId });
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

    if (op.tabId !== undefined) updates.tabId = op.tabId; // Replaced cwd with tabId
    if (op.approval_policy !== undefined) updates.approval_policy = op.approval_policy;
    if (op.sandbox_policy !== undefined) updates.sandbox_policy = op.sandbox_policy;
    if (op.model !== undefined) updates.model = op.model;
    if (op.effort !== undefined) updates.effort = op.effort;
    if (op.summary !== undefined) updates.summary = op.summary;

    this.session.updateTurnContext(updates);
  }

  /**
   * Handle exec approval
   * Unified handler for both extension and desktop platforms.
   * Routes decisions to ApprovalManager (risk-based approvals) and Session (protocol-level).
   */
  private async handleExecApproval(op: Extract<Op, { type: 'ExecApproval' }>): Promise<void> {
    const decision = op.decision === 'approve' ? 'approve' : 'reject';

    // Capture pending approval data before handleDecision removes it
    let toolName = '';
    let params: Record<string, any> = {};
    let domain: string | undefined;
    let riskScore: number | undefined;
    if (op.remember) {
      const pending = this.approvalManager.getApproval(op.id);
      if (pending) {
        toolName = pending.request?.metadata?.toolName || '';
        params = pending.request?.details?.parameters || {};
        domain = pending.request?.metadata?.domain;
        riskScore = pending.request?.metadata?.riskScore;
      } else {
        console.warn(`[RepublicAgent] Cannot remember decision - no pending approval for id: ${op.id}`);
      }
    }

    // Resolve through both approval paths. Either or both may have a pending
    // request for this ID depending on which subsystem initiated the approval.
    // Use try-catch to ensure one path's failure doesn't block the other.

    let riskBasedResolved = false;
    try {
      await this.approvalManager.handleDecision({
        id: op.id,
        decision,
        timestamp: Date.now(),
        reason: op.alternativeText || (decision === 'reject' ? 'Denied by user' : undefined),
      });
      riskBasedResolved = true;
    } catch (error) {
      console.warn(`[RepublicAgent] ApprovalManager.handleDecision failed for ${op.id}:`, error);
    }

    let protocolResolved = false;
    try {
      await this.session.notifyApproval(op.id, op.decision);
      protocolResolved = true;
    } catch (error) {
      console.warn(`[RepublicAgent] Session.notifyApproval failed for ${op.id}:`, error);
    }

    if (!riskBasedResolved && !protocolResolved) {
      console.error(`[RepublicAgent] Approval decision could not be routed for id: ${op.id} — no pending request found in either subsystem`);
    }

    // Remember decision for this session if requested
    if (op.remember && toolName) {
      const approvalGate = this.toolRegistry.getApprovalGate();
      if (approvalGate) {
        approvalGate.rememberDecision(
          toolName,
          params,
          decision === 'approve' ? 'auto_approve' : 'deny',
          domain,
          riskScore,
        );
      }
    }

    // Emit event
    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Execution ${decision === 'approve' ? 'approved' : 'rejected'}: ${op.id}`,
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
        path: this.session.sessionId,
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
   * @param trigger - What triggered this compaction ('auto' | 'manual')
   */
  private async handleCompact(trigger: 'auto' | 'manual' = 'auto'): Promise<void> {
    try {
      // Emit background event indicating compaction started
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `History compaction started (${trigger})`,
          level: 'info',
        },
      });

      // Get history size before compaction
      const historyBefore = this.session.getConversationHistory().items.length;

      // Get model client for LLM-based summarization
      const modelClient = await this.modelClientFactory.createClientForCurrentModel();

      // Perform compaction with LLM-based summarization
      const result = await this.session.compact(trigger, modelClient);

      // Get history size after compaction
      const historyAfter = this.session.getConversationHistory().items.length;

      // Emit CompactionCompleted event for UI notification (T036)
      this.emitEvent({
        type: 'CompactionCompleted',
        data: {
          success: result.success,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          itemsTrimmed: result.itemsTrimmed,
          compactionCount: this.session.getCompactionCount(),
          triggerReason: trigger,
          error: result.error,
        },
      });

      // Emit background event indicating compaction completed
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `History compaction completed: ${historyBefore} → ${historyAfter} items (saved ~${result.tokensBefore - result.tokensAfter} tokens)`,
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
      const entry = this.session.getHistoryEntry(op.offset);

      if (entry) {
        // Emit event with the history entry
        this.emitEvent({
          type: 'BackgroundEvent',
          data: {
            message: `History entry ${op.offset}: ${JSON.stringify(entry).substring(0, 100)}...`,
            level: 'info',
          },
        });
      } else {
        // Emit error if entry not found
        this.emitEvent({
          type: 'Error',
          data: {
            message: `History entry ${op.offset} not found`,
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
   * Set the event dispatcher
   *
   * This MUST be called before using the agent. The dispatcher routes events
   * to UI channels via ChannelManager. This makes RepublicAgent platform-agnostic.
   *
   * @param dispatcher - Function to dispatch events to UI channels
   */
  setEventDispatcher(dispatcher: EventDispatcher): void {
    this.eventDispatcher = dispatcher;
  }

  /**
   * Emit an event to the event queue
   *
   * Events are routed through the injected event dispatcher to ChannelManager,
   * which then dispatches to the appropriate channel (extension, desktop, etc.)
   */
  private emitEvent(msg: EventMsg): void {
    const event: Event = {
      id: `evt_${this.nextId++}`,
      msg,
    };

    this.eventQueue.push(event);

    // Process event for user notifications
    this.userNotifier.processEvent(event);

    // Dispatch event through the channel system
    if (this.eventDispatcher) {
      try {
        this.eventDispatcher(event);
      } catch (error) {
        console.error('[RepublicAgent] Event dispatcher error:', error);
      }
    } else {
      console.warn('[RepublicAgent] No event dispatcher set - event not delivered to UI');
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
  getUserNotifier(): IUserNotifier {
    return this.userNotifier;
  }

  /**
   * Check if agent is ready to accept commands
   * Returns true if user is logged in (backend routing) OR API key is configured
   */
  async isReady(): Promise<AgentReadyState> {
    try {
      const configData = this.config.getConfig();
      const selectedModelKey = configData.selectedModelKey;
      const modelData = this.config.getModelByKey(selectedModelKey);

      if (!modelData) {
        return {
          ready: false,
          message: `Selected model ${selectedModelKey} not found`,
          authMode: 'none',
        };
      }

      const providerId = modelData.provider.id;

      // Check if using backend routing (user is logged in)
      if (this.modelClientFactory.isBackendRouting()) {
        return {
          ready: true,
          provider: modelData.provider.name,
          model: modelData.model.name,
          authMode: 'login',
        };
      }

      // Fall back to API key mode
      const apiKey = await this.config.getProviderApiKey(providerId);

      if (!apiKey || !apiKey.trim()) {
        return {
          ready: false,
          message: `No API key configured for ${modelData.provider.name}`,
          provider: modelData.provider.name,
          model: modelData.model.name,
          authMode: 'api_key',
        };
      }

      return {
        ready: true,
        provider: modelData.provider.name,
        model: modelData.model.name,
        authMode: 'api_key',
      };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : 'Unknown error checking agent status',
        authMode: 'none',
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
