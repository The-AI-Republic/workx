/**
 * Main RepublicAgent class
 * Thin orchestration wrapper over RepublicAgentEngine.
 * Handles platform-specific concerns (tab binding, config subscriptions, model hot-swap)
 * and delegates all execution to the engine's single SQ/EQ loop.
 */

import type { Submission, Op, InputItem, AskForApproval, SandboxPolicy, ReasoningEffortConfig, ReasoningSummaryConfig, ReviewDecision } from './protocol/types';
import type { Event, EventMsg } from './protocol/events';
import type { IConfigChangeEvent, IToolsConfig, IModelConfig } from '../config/types';
import type { AgentReadyState } from './models/types/Auth';
import type { InitialHistory } from './session/state/types';
import type { EngineEvent, EngineOp } from './engine/RepublicAgentEngineConfig';
import { AgentConfig } from '../config/AgentConfig';
import { Session } from './Session';
import { TurnContext } from './TurnContext';
import { ApprovalManager } from './ApprovalManager';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ModelClientFactory } from './models/ModelClientFactory';
import { RepublicAgentEngine } from './engine/RepublicAgentEngine';
import { type IUserNotifier, NoOpNotifier } from './IUserNotifier';
import { v4 as uuidv4 } from 'uuid';
import { loadPrompt, loadUserInstructions, configurePromptComposer, isComposerConfigured } from './PromptLoader';
import { RegularTask } from './tasks/RegularTask';
import type { IPlatformAdapter } from './platform/IPlatformAdapter';
import type { DesktopPlatformAdapter } from '../desktop/platform/DesktopPlatformAdapter';

/**
 * Event dispatcher function type
 * Used to route events to UI channels without hardcoding chrome.runtime
 */
export type EventDispatcher = (event: Event) => void | Promise<void>;

export class RepublicAgent {
  private _agentId: string;
  private nextId: number = 1;
  private session: Session;
  private config: AgentConfig;
  private approvalManager: ApprovalManager;
  private toolRegistry: ToolRegistry;
  private modelClientFactory: ModelClientFactory;
  private platformAdapter: IPlatformAdapter;
  private userNotifier: IUserNotifier;
  private eventDispatcher: EventDispatcher | null = null;
  private eventQueue: Event[] = [];
  private engine: RepublicAgentEngine | null = null;
  // Non-null signals a deferred model switch. The actual model is resolved from
  // AgentConfig.selectedModelKey (which is updated before the config-changed event
  // fires), so the stored value is only used as a "switch pending" flag.
  private pendingModelKey: string | null = null;

  constructor(config: AgentConfig, platformAdapter: IPlatformAdapter, initialHistory?: InitialHistory, agentId?: string, userNotifier?: IUserNotifier) {
    // Generate or use provided agentId for multi-instance tracking (Feature 015)
    this._agentId = agentId ?? `agent_${uuidv4()}`;

    // Config must be provided (use await AgentConfig.getInstance() if needed)
    this.config = config;
    this.platformAdapter = platformAdapter;

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

    // Register platform tools via adapter (replaces __BUILD_MODE__-based detection)
    await this.platformAdapter.registerPlatformTools(this.toolRegistry, this.config.getToolsConfig(), {
      supportsImage: modelData.model.supportsImage
    });

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

    // Create and initialize the engine with the shared session
    this.engine = new RepublicAgentEngine({
      agentConfig: this.config,
      modelClientFactory: this.modelClientFactory,
      toolRegistry: this.toolRegistry,
      systemPrompt: baseInstructions,
      userInstructions,
      session: this.session,
      ownsSession: false,
      approvalGate: this.toolRegistry.getApprovalGate() ?? undefined,
      approvalManager: this.approvalManager,
    });
    await this.engine.initialize();

    // Bridge engine events to the RepublicAgent event system
    this.wireEngineEvents();

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

    const agentType = this.platformAdapter.platformId === 'desktop'
      ? 'applepi' as const
      : 'browserx' as const;

    configurePromptComposer(agentType, {
      browserConnection: this.platformAdapter.platformId === 'extension' ? 'extension' : 'mcp',
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
  }

  /**
   * Submit an operation to the agent.
   * Orchestration-only ops are handled locally.
   * Execution ops are forwarded to the engine after pre-submit hooks.
   * Returns a submission ID.
   */
  async submitOperation(op: Op, context?: { tabId?: number }): Promise<string> {
    const id = `sub_${this.nextId++}`;

    try {
      switch (op.type) {
        // === Orchestration-only ops (handled locally, no engine involvement) ===
        case 'GetPath':
          await this.handleGetPath();
          break;

        case 'OverrideTurnContext':
          await this.handleOverrideTurnContext(op);
          break;

        case 'GetHistoryEntryRequest':
          await this.handleGetHistoryEntryRequest(op);
          break;

        // === UserInput/UserTurn: run pre-submit hooks, then delegate to engine ===
        case 'UserInput':
        case 'UserTurn': {
          await this.preSubmitHooks(op, context);
          const engineOp = this.toEngineOp(op);
          if (this.engine) {
            this.engine.submitOperation(engineOp);
          } else {
            // Fallback: direct execution if engine not yet initialized
            await this.fallbackSubmit(op, context);
          }
          break;
        }

        // === Forward execution ops to engine ===
        case 'ExecApproval':
          if (this.engine) {
            this.engine.submitOperation({
              type: 'ExecApproval',
              callId: op.id,
              approved: op.decision === 'approve',
              remember: op.remember,
            });
          } else {
            await this.handleExecApproval(op);
          }
          break;

        case 'PatchApproval':
          if (this.engine) {
            this.engine.submitOperation({
              type: 'PatchApproval',
              patchId: op.id,
              approved: op.decision === 'approve',
            });
          } else {
            await this.handlePatchApproval(op);
          }
          break;

        case 'Interrupt':
          if (this.engine) {
            await this.userNotifier.notifyWarning(
              'Task Interrupted',
              'The current task has been interrupted by user request'
            );
            this.engine.submitOperation({ type: 'Interrupt', reason: 'user_interrupt' });
          } else {
            await this.handleInterrupt();
          }
          break;

        case 'Compact':
          if (this.engine) {
            this.engine.submitOperation({ type: 'Compact', mode: 'auto' });
          } else {
            await this.handleCompact('auto');
          }
          break;

        case 'ManualCompact':
          if (this.engine) {
            this.engine.submitOperation({ type: 'ManualCompact' });
          } else {
            await this.handleCompact('manual');
          }
          break;

        case 'AddToHistory':
          if (this.engine) {
            this.engine.submitOperation({ type: 'AddToHistory', text: op.text });
          } else {
            await this.handleAddToHistory(op);
          }
          break;

        case 'Shutdown':
          if (this.engine) {
            this.engine.submitOperation({ type: 'Shutdown' });
            await this.engine.dispose();
          } else {
            await this.handleShutdown();
          }
          break;

        default:
          this.emitEvent({
            type: 'AgentMessage',
            data: {
              message: `Operation type ${(op as any).type} not yet implemented`,
            },
          });
      }
    } catch (error) {
      // Emit TurnAborted event on error
      this.emitEvent({
        type: 'TurnAborted',
        data: {
          reason: 'error',
          submission_id: id,
        },
      });
      this.emitEvent({
        type: 'Error',
        data: {
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      });
    }

    return id;
  }

  /**
   * Pre-submit hooks: tab binding + pending model switch.
   * Run before forwarding UserInput/UserTurn to the engine.
   */
  private async preSubmitHooks(
    op: Extract<Op, { type: 'UserInput' }> | Extract<Op, { type: 'UserTurn' }>,
    context?: { tabId?: number }
  ): Promise<void> {
    // Tab binding (platform adapter concern)
    const tabContext = op.type === 'UserTurn' && op.tabId !== undefined
      ? { tabId: op.tabId }
      : context;
    await this.handleTabBinding(tabContext);

    // Apply pending model switch
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
  }

  /**
   * Convert a RepublicAgent Op to an EngineOp for forwarding to the engine.
   */
  private toEngineOp(op: Extract<Op, { type: 'UserInput' }> | Extract<Op, { type: 'UserTurn' }>): EngineOp {
    if (op.type === 'UserInput') {
      return {
        type: 'UserInput',
        items: op.items as any,
      };
    }
    // UserTurn with context overrides
    return {
      type: 'UserTurn',
      items: op.items as any,
      contextOverrides: {
        approval_policy: op.approval_policy,
        sandbox_policy: op.sandbox_policy,
        model: op.model,
        effort: op.effort,
        summary: op.summary,
      },
    };
  }

  /**
   * Fallback submission path when engine is not initialized.
   * Uses the old direct-to-session approach for backward compatibility.
   */
  private async fallbackSubmit(op: Op, context?: { tabId?: number }): Promise<string> {
    const id = `sub_${this.nextId++}`;
    try {
      if (op.type === 'UserInput') {
        this.session.addPendingInput(op.items);
        await this.processUserInputWithTask(op.items, undefined, true, context);
      } else if (op.type === 'UserTurn') {
        await this.processUserInputWithTask(op.items, {
          approval_policy: op.approval_policy,
          sandbox_policy: op.sandbox_policy,
          model: op.model,
          effort: op.effort,
          summary: op.summary,
        }, true, { tabId: op.tabId });
      }
    } catch (error) {
      this.emitEvent({
        type: 'Error',
        data: { message: error instanceof Error ? error.message : 'Unknown error' },
      });
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
   * Handle tab binding/creation/switching based on session state and context
   * @param submissionContext - Context containing optional tabId
   */
  private async handleTabBinding(submissionContext?: { tabId?: number }): Promise<void> {
    const currentTabId = this.session.getTabId();
    const newTabId = submissionContext?.tabId ?? -1;

    // ================================================================
    // CASE 1: newTabId is -1 → Create a new tab
    // ================================================================
    if (newTabId === -1) {
      try {
        // Desktop: ensure MCP browser connection before first use
        if (this.platformAdapter.platformId === 'desktop') {
          await (this.platformAdapter as DesktopPlatformAdapter).ensureBrowserConnection(
            this.toolRegistry,
            (msg) => this.emitEvent(msg as EventMsg),
          );
        }

        // Extension: clear old tab group before creating new tab
        if (this.platformAdapter.hasRealTabs && currentTabId !== -1) {
          await this.platformAdapter.switchTab(currentTabId, -1);
        }

        const createdTabId = await this.platformAdapter.createTab({
          url: 'about:blank',
          active: false,
        });

        this.session.setTabId(createdTabId);

        this.emitEvent({
          type: 'StateUpdate',
          data: { sessionId: this.session.getId(), tabId: createdTabId },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error during tab creation';

        this.emitEvent({
          type: 'Error',
          data: { message: `Failed to create browser tab: ${errorMsg}` },
        });

        throw error;
      }
    }
    // ================================================================
    // CASE 2: newTabId === currentTabId → Check health, don't rebind
    // ================================================================
    else if (newTabId === currentTabId) {
      if (this.platformAdapter.hasRealTabs) {
        const validation = await this.platformAdapter.validateTab(currentTabId);

        if (!validation.valid) {
          const errorMsg = `Current tab ${currentTabId} is not healthy. Reason: ${validation.reason}`;

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
      if (!this.platformAdapter.hasRealTabs) {
        // Desktop/server: just update session tabId
        this.session.setTabId(newTabId);
      } else {
        // Extension: validate tab before switching
        const validation = await this.platformAdapter.validateTab(newTabId);

        if (!validation.valid) {
          this.emitEvent({
            type: 'Error',
            data: {
              message: `The selected tab (ID: ${newTabId}) is not valid (${validation.reason}). Please select a valid tab and try again.`,
            },
          });

          throw new Error(`Tab ${newTabId} is not valid. Reason: ${validation.reason}`);
        }

        try {
          await this.platformAdapter.switchTab(currentTabId, newTabId);
          this.session.setTabId(newTabId);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error during tab switching';

          this.emitEvent({
            type: 'Error',
            data: { message: `Failed to switch to tab ${newTabId}: ${errorMsg}` },
          });

          throw error;
        }
      }
    }

    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Tab binding updated: session ${this.session.getId()} now bound to tab ${this.session.getTabId()}`,
        level: 'info',
      },
    });
  }

  /**
   * Process user input with SessionTask (fallback path when engine not available)
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
          this.session.updateTurnContext(contextOverrides);
        }
      }

      if (!taskContext) {
        throw new Error('Turn context not initialized');
      }

      // Create RegularTask instance
      const task = new RegularTask();

      // Generate submission ID
      const submissionId = uuidv4();

      // Delegate to Session.spawnTask()
      await this.session.spawnTask(task, taskContext, submissionId, inputItems);

    } catch (error) {
      console.error('Error processing user input:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred during task execution';
      const isApiKeyError = errorMessage.includes('No API key configured');

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
   * Cancel a running task
   */
  async cancelTask(submissionId: string): Promise<void> {
    if (this.session.hasRunningTask(submissionId)) {
      await this.session.abortAllTasks('UserInterrupt');
    }
  }

  /**
   * Handle override turn context
   */
  private async handleOverrideTurnContext(
    op: Extract<Op, { type: 'OverrideTurnContext' }>
  ): Promise<void> {
    const updates: any = {};

    if (op.tabId !== undefined) updates.tabId = op.tabId;
    if (op.approval_policy !== undefined) updates.approval_policy = op.approval_policy;
    if (op.sandbox_policy !== undefined) updates.sandbox_policy = op.sandbox_policy;
    if (op.model !== undefined) updates.model = op.model;
    if (op.effort !== undefined) updates.effort = op.effort;
    if (op.summary !== undefined) updates.summary = op.summary;

    this.session.updateTurnContext(updates);
  }

  /**
   * Handle exec approval (fallback when engine not available)
   */
  private async handleExecApproval(op: Extract<Op, { type: 'ExecApproval' }>): Promise<void> {
    const decision = op.decision === 'approve' ? 'approve' : 'reject';

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

    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Execution ${decision === 'approve' ? 'approved' : 'rejected'}: ${op.id}`,
        level: 'info',
      },
    });
  }

  /**
   * Handle patch approval (fallback when engine not available)
   */
  private async handlePatchApproval(op: Extract<Op, { type: 'PatchApproval' }>): Promise<void> {
    await this.session.notifyApproval(op.id, op.decision);

    this.emitEvent({
      type: 'BackgroundEvent',
      data: {
        message: `Patch ${op.decision === 'approve' ? 'approved' : 'rejected'}: ${op.id}`,
        level: 'info',
      },
    });
  }

  /**
   * Handle add to history (fallback when engine not available)
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
   * Handle shutdown (fallback when engine not available)
   */
  private async handleShutdown(): Promise<void> {
    this.emitEvent({
      type: 'ShutdownComplete',
    });
  }

  /**
   * Handle compact operation (fallback when engine not available)
   */
  private async handleCompact(trigger: 'auto' | 'manual' = 'auto'): Promise<void> {
    try {
      this.emitEvent({
        type: 'BackgroundEvent',
        data: {
          message: `History compaction started (${trigger})`,
          level: 'info',
        },
      });

      const historyBefore = this.session.getConversationHistory().items.length;
      const modelClient = await this.modelClientFactory.createClientForCurrentModel();
      const result = await this.session.compact(trigger, modelClient);
      const historyAfter = this.session.getConversationHistory().items.length;

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
   */
  private async handleGetHistoryEntryRequest(
    op: Extract<Op, { type: 'GetHistoryEntryRequest' }>
  ): Promise<void> {
    try {
      const entry = this.session.getHistoryEntry(op.offset);

      if (entry) {
        this.emitEvent({
          type: 'BackgroundEvent',
          data: {
            message: `History entry ${op.offset}: ${JSON.stringify(entry).substring(0, 100)}...`,
            level: 'info',
          },
        });
      } else {
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
   * Handle interrupt (fallback when engine not available)
   */
  private async handleInterrupt(): Promise<void> {
    this.session.requestInterrupt();

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

    await this.session.abortAllTasks('UserInterrupt');
    this.session.clearInterrupt();
  }

  /**
   * Wire engine events to the RepublicAgent's eventDispatcher.
   * The engine emits EngineEvents; we convert and dispatch them to the UI.
   */
  private wireEngineEvents(): void {
    if (!this.engine) return;
    this.engine.onEvent((engineEvent: EngineEvent) => {
      // Engine events already flow through session's event emitter
      // which is wired to emitEvent() in the constructor.
      // The onEvent listener here is for any engine-only events
      // that don't originate from session (e.g., ShutdownComplete, EngineDisposed).
      // Session-originated events are already dispatched via the session's emitter.
    });
  }

  /**
   * Set the event dispatcher
   */
  setEventDispatcher(dispatcher: EventDispatcher): void {
    this.eventDispatcher = dispatcher;
  }

  /**
   * Emit an event to the event queue and dispatch to UI
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
   * Get the platform adapter
   */
  getPlatformAdapter(): IPlatformAdapter {
    return this.platformAdapter;
  }

  /**
   * Get the engine instance
   */
  getEngine(): RepublicAgentEngine | null {
    return this.engine;
  }

  /**
   * Create a child RepublicAgentEngine for sub-agents.
   * The child engine shares the parent's model client factory and config
   * but gets its own tool registry (optionally restricted) and session.
   */
  createChildEngine(config: {
    toolRegistry?: ToolRegistry;
    systemPrompt?: string;
    model?: string;
    maxTurns?: number;
  }): RepublicAgentEngine {
    return new RepublicAgentEngine({
      agentConfig: this.config,
      modelClientFactory: this.modelClientFactory,
      toolRegistry: config.toolRegistry ?? new ToolRegistry(),
      systemPrompt: config.systemPrompt ?? '',
      model: config.model,
      maxTurns: config.maxTurns,
      persistent: false,
    });
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.engine) {
      await this.engine.dispose();
    }
    await this.toolRegistry.cleanup();
    this.toolRegistry.clear();
    this.eventQueue = [];
    await this.userNotifier.clearAll();
    await this.platformAdapter.dispose();
  }

  /**
   * Setup notification handlers
   */
  private setupNotificationHandlers(): void {
    this.userNotifier.onNotification((notification) => {
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
    const pendingApproval = this.approvalManager.getApproval(approvalId);
    if (!pendingApproval) return;

    const approval = pendingApproval.request;

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

      if (this.modelClientFactory.isBackendRouting()) {
        return {
          ready: true,
          provider: modelData.provider.name,
          model: modelData.model.name,
          authMode: 'login',
        };
      }

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
    this.session.requestInterrupt();

    await this.userNotifier.notifyInfo(
      'Interruption Requested',
      'The current task will be interrupted'
    );

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
