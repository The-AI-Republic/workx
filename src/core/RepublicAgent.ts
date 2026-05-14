/**
 * Main RepublicAgent class
 * Thin orchestration wrapper over RepublicAgentEngine.
 * Handles platform-specific concerns (tab binding, config subscriptions, model hot-swap)
 * and delegates all execution to the engine's single SQ/EQ loop.
 */

import type { Op, ReviewDecision, InputItem as ProtocolInputItem } from './protocol/types';
import type { Event, EventMsg } from './protocol/events';
import type { IConfigChangeEvent } from '../config/types';
import type { AgentReadyState } from './models/types/Auth';
import type { InitialHistory } from './session/state/types';
import type { EngineEvent, EngineOp, InputItem as EngineInputItem } from './engine/RepublicAgentEngineConfig';
import { AgentConfig } from '../config/AgentConfig';
import { Session } from './Session';
import { TurnContext } from './TurnContext';
import { ApprovalManager } from './ApprovalManager';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ModelClientFactory } from './models/ModelClientFactory';
import { RepublicAgentEngine } from './engine/RepublicAgentEngine';
import { type IUserNotifier, NoOpNotifier } from './IUserNotifier';
import { v4 as uuidv4 } from 'uuid';
import { loadPrompt, loadUserInstructions, configurePromptComposer, isComposerConfigured, registerPromptExtension, unregisterPromptExtension } from './PromptLoader';
import { HookRegistry } from './hooks/HookRegistry';
import { HookExecutor } from './hooks/HookExecutor';
import { HookDispatcher } from './hooks/HookDispatcher';
import { ConfigHookLoader } from './hooks/loaders/ConfigHookLoader';
import type { HookInput } from './hooks/types';
import type { IPlatformAdapter } from './platform/IPlatformAdapter';

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
  // Hook system
  private hookRegistry: HookRegistry;
  private hookExecutor: HookExecutor;
  private hookDispatcher: HookDispatcher;

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

    // Initialize hook system
    this.hookRegistry = new HookRegistry();
    this.hookExecutor = new HookExecutor();
    this.hookDispatcher = new HookDispatcher(this.hookRegistry, this.hookExecutor);
    this.hookDispatcher.setEventEmitter((msg) => this.emitEvent(msg));
    this.session.setHookDispatcher(this.hookDispatcher);

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

    // Register platform tools via adapter (replaces __BUILD_MODE__-based detection)
    await this.platformAdapter.registerPlatformTools(this.toolRegistry, this.config.getToolsConfig(), {
      supportsImage: modelData.model.supportsImage ?? false
    });

    // Wire tool context for adapters that need lazy browser connection (desktop MCP)
    if (this.platformAdapter.setToolContext) {
      this.platformAdapter.setToolContext(
        this.toolRegistry,
        (msg: { type: string; data: Record<string, unknown> }) => this.emitEvent(msg as EventMsg),
      );
    }

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

    // Load hooks from config and watch for changes
    ConfigHookLoader.load(this.config, this.hookRegistry);
    ConfigHookLoader.watch(this.config, this.hookRegistry);

    // Fire SessionStart hooks (non-blocking)
    this.hookDispatcher.fire('SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: this.session.sessionId,
      session_start_source: 'startup',
    }).catch((err) => {
      console.warn('[RepublicAgent] SessionStart hook failed:', err);
    });

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

    // initialization complete
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
      return;
    }

    const agentType = this.platformAdapter.platformId === 'desktop'
      ? 'applepi' as const
      : 'browserx' as const;

    configurePromptComposer(agentType, {
      browserConnection: this.platformAdapter.platformId === 'extension' ? 'extension' : 'mcp',
    });
    // PromptComposer configured
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

      // Update session with new turn context first so the memory service has
      // a target to attach to.
      this.session.setTurnContext(taskContext);

      // Refresh memory state (service + tool registry + prompt extension) BEFORE
      // loading the prompt, so the freshly composed prompt reflects the new state.
      await this.session.refreshMemoryService(this.config);
      await this.syncMemoryTools();

      const baseInstructions = await loadPrompt();
      taskContext.setBaseInstructions(baseInstructions);
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

    // Refresh memory state (service + tool registry + prompt extension) BEFORE
    // composing the prompt, otherwise enabling memory yields a prompt without
    // the memory extension and disabling it leaves stale memory text behind.
    await this.session.refreshMemoryService(this.config);
    await this.syncMemoryTools();

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
      // Guard: engine must be initialized before forwarding execution ops
      const requireEngine = () => {
        if (!this.engine) {
          throw new Error('RepublicAgent not initialized. Call initialize() before submitOperation().');
        }
        return this.engine;
      };

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
        // Return the engine's submission ID so callers can correlate with lifecycle events
        case 'UserInput':
        case 'UserTurn': {
          const shouldContinue = await this.preSubmitHooks(op, context);
          if (!shouldContinue) {
            // UserPromptSubmit hook blocked — return local id without engine submission
            return id;
          }
          return requireEngine().submitOperation(this.toEngineOp(op));
        }

        // === Forward execution ops to engine ===
        case 'ExecApproval':
          requireEngine().submitOperation({
            type: 'ExecApproval',
            callId: op.id,
            decision: op.decision,
            remember: op.remember,
            alternativeText: op.alternativeText,
          });
          break;

        case 'PatchApproval':
          requireEngine().submitOperation({
            type: 'PatchApproval',
            patchId: op.id,
            decision: op.decision,
          });
          break;

        case 'Interrupt':
          await this.userNotifier.notifyWarning(
            'Task Interrupted',
            'The current task has been interrupted by user request'
          );
          requireEngine().submitOperation({ type: 'Interrupt', reason: 'user_interrupt' });
          break;

        case 'Compact':
          requireEngine().submitOperation({ type: 'Compact', mode: 'auto' });
          break;

        case 'ManualCompact':
          requireEngine().submitOperation({ type: 'ManualCompact' });
          break;

        case 'AddToHistory':
          requireEngine().submitOperation({ type: 'AddToHistory', text: op.text });
          break;

        case 'Shutdown':
          // Cleanly tear down the engine. dispose() is idempotent and emits
          // EngineDisposed, which is the canonical "we're done" signal. Do
          // NOT also submit a Shutdown op — that double-handles teardown and
          // races the dispose path.
          await requireEngine().dispose();
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
   * Pre-submit hooks: UserPromptSubmit hook + tab binding + pending model switch.
   * Run before forwarding UserInput/UserTurn to the engine.
   *
   * Returns `false` if a UserPromptSubmit hook blocked the operation, in which
   * case the caller must skip engine submission.
   */
  private async preSubmitHooks(
    op: Extract<Op, { type: 'UserInput' }> | Extract<Op, { type: 'UserTurn' }>,
    context?: { tabId?: number }
  ): Promise<boolean> {
    // Fire UserPromptSubmit hooks before any work
    const textContent = (op.items ?? [])
      .filter((i: any) => i.type === 'text')
      .map((i: any) => i.text ?? '')
      .join('\n');

    if (textContent) {
      const hookInput: HookInput = {
        hook_event_name: 'UserPromptSubmit',
        session_id: this.session.sessionId,
        user_prompt: textContent,
      };
      const hookResult = await this.hookDispatcher.fire('UserPromptSubmit', hookInput);
      if (!hookResult.shouldContinue) {
        this.emitEvent({
          type: 'Error',
          data: {
            message: hookResult.stopReason ?? 'UserPromptSubmit hook blocked this input',
          },
        });
        return false;
      }
    }

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
    return true;
  }

  /**
   * Convert a protocol InputItem to an engine InputItem.
   * Protocol types: text, image (image_url), clipboard (content), context (path)
   * Engine types:   text (text), image (data, mimeType), file (path)
   */
  private static convertInputItem(item: ProtocolInputItem): EngineInputItem {
    switch (item.type) {
      case 'text':
        return { type: 'text', text: item.text };
      case 'image': {
        // Protocol uses image_url (data URI), engine expects data + mimeType
        const dataUri = item.image_url;
        const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return { type: 'image', data: match[2], mimeType: match[1] };
        }
        // Fallback: pass the whole URI as data
        return { type: 'image', data: dataUri, mimeType: 'image/png' };
      }
      case 'clipboard':
        // Clipboard content is text-like; convert to text item
        return { type: 'text', text: item.content ?? '' };
      case 'context':
        // Context with a path maps to the engine's file type
        return { type: 'file', path: item.path };
      default:
        // Exhaustiveness guard — treat unknown types as text
        return { type: 'text', text: '' };
    }
  }

  /**
   * Convert a RepublicAgent Op to an EngineOp for forwarding to the engine.
   */
  private toEngineOp(op: Extract<Op, { type: 'UserInput' }> | Extract<Op, { type: 'UserTurn' }>): EngineOp {
    const items = op.items.map(RepublicAgent.convertInputItem);

    if (op.type === 'UserInput') {
      return { type: 'UserInput', items };
    }
    // UserTurn with context overrides — only include defined values
    // to avoid overwriting existing context with undefined
    const overrides: Record<string, unknown> = {};
    if (op.approval_policy !== undefined) overrides.approval_policy = op.approval_policy;
    if (op.sandbox_policy !== undefined) overrides.sandbox_policy = op.sandbox_policy;
    if (op.model !== undefined) overrides.model = op.model;
    if (op.effort !== undefined) overrides.effort = op.effort;
    if (op.summary !== undefined) overrides.summary = op.summary;

    return {
      type: 'UserTurn',
      items,
      contextOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    };
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
        // Lazy browser setup (e.g., desktop MCP connection)
        await this.platformAdapter.ensureBrowserReady?.();

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
   * Wire engine events to the RepublicAgent's eventDispatcher.
   * The engine emits EngineEvents; we convert and dispatch them to the UI.
   */
  /**
   * Engine-only event types that don't originate from session's event emitter.
   * These need to be forwarded explicitly to the RepublicAgent event system.
   */
  private static readonly ENGINE_ONLY_EVENTS = new Set([
    'ShutdownComplete',
    'EngineDisposed',
    'TaskStarted',
    'CompactionCompleted',
    'TurnAborted',
    'HistoryCleared',
    'BackgroundEvent',
    'Error',
    'SubAgentStart',
    'SubAgentComplete',
    'SubAgentError',
  ]);

  private wireEngineEvents(): void {
    if (!this.engine) return;
    this.engine.onEvent((engineEvent: EngineEvent) => {
      // Session-originated events are already dispatched via the session's emitter
      // (wired in the constructor). Only forward engine-only events that don't
      // originate from session to avoid duplicate dispatching.
      if (RepublicAgent.ENGINE_ONLY_EVENTS.has(engineEvent.msg.type)) {
        this.emitEvent(engineEvent.msg as EventMsg);
      }
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
   * Get the hook dispatcher.
   *
   * Exposed so platform bootstraps (extension/desktop/server) can wire the
   * dispatcher into the ApprovalGate they construct, which is required for
   * PermissionRequest and PermissionDenied hooks to fire.
   */
  getHookDispatcher(): HookDispatcher {
    return this.hookDispatcher;
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
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Fire SessionEnd hooks with short timeout (1.5s) before tearing things down.
    // Failures here must not block shutdown.
    try {
      await this.hookDispatcher.fire(
        'SessionEnd',
        {
          hook_event_name: 'SessionEnd',
          session_id: this.session.sessionId,
          session_end_reason: 'shutdown',
        },
        { timeoutOverride: 1.5 },
      );
    } catch (err) {
      console.warn('[RepublicAgent] SessionEnd hook failed during cleanup:', err);
    }

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
