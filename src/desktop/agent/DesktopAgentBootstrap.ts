/**
 * Desktop Agent Bootstrap
 *
 * Initializes and wires up the PiAgent with the channel system for desktop mode.
 * In desktop mode, the agent runs directly in the WebView (same process as UI).
 *
 * Flow:
 * 1. Create ChannelManager (routes submissions to agent, events to channels)
 * 2. Create TauriChannel (receives submissions from UI, sends events to UI)
 * 3. Create PiAgent (processes submissions, emits events)
 * 4. Wire them together
 *
 * @module desktop/agent/DesktopAgentBootstrap
 */

import { TauriChannel } from '../channels/TauriChannel';
import { DesktopMessageRouter } from '../channels/DesktopMessageRouter';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import { DEFAULT_MAX_CONCURRENT } from '@/core/registry/types';
import { PiAgent } from '@/core/PiAgent';
import { MessageType } from '@/core/MessageRouter';
import { AgentConfig } from '@/config/AgentConfig';
import { configurePromptComposer, registerPromptExtension } from '@/core/PromptLoader';
import type { RuntimeContext } from '@/prompts/PromptComposer';
import { SkillRegistry } from '@/core/skills/SkillRegistry';
import { FilesystemSkillProvider } from '../storage/FilesystemSkillProvider';
import { AuthManager } from '@/core/models/types/Auth';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';
import { t } from '@/webfront/lib/i18n';
import { StaticRiskAssessor } from '@/core/approval/assessors/StaticRiskAssessor';

/**
 * Singleton instance
 */
let _instance: DesktopAgentBootstrap | null = null;

/**
 * Desktop Agent Bootstrap
 *
 * Manages the lifecycle of the agent and channel system in desktop mode.
 */
export class DesktopAgentBootstrap {
  private registry: AgentRegistry | null = null;
  private primaryAgent: PiAgent | null = null;
  private channel: TauriChannel | null = null;
  private messageRouter: DesktopMessageRouter | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private initialized = false;
  private currentAuthManager: AuthManager | null = null;

  /**
   * Initialize the desktop agent system
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('[DesktopAgentBootstrap] Already initialized');
      return;
    }

    console.log('[DesktopAgentBootstrap] Initializing...');

    try {
      // 1. Create the message router for PiAgent
      this.messageRouter = new DesktopMessageRouter('background');

      // 2. Get agent config and set up AgentRegistry
      const config = await AgentConfig.getInstance();
      const maxConcurrentSessions = config.getConfig().preferences?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT;
      this.registry = AgentRegistry.getInstance({ maxConcurrent: maxConcurrentSessions });
      this.registry.initialize(config, this.messageRouter as any);

      // 3. Create Primary Session
      // This instantiates the singleton fallback agent for quick backward compatibility
      const primarySession = await this.registry.createSession({ type: 'primary' });
      this.primaryAgent = primarySession.agent;

      // Listen for new sessions to automatically inject the current AuthManager
      this.registry.on((sessionEvent: any) => {
        if (sessionEvent.type === 'session:created' && this.currentAuthManager) {
          const session = this.registry?.getSession(sessionEvent.sessionId);
          if (session?.agent) {
            const factory = session.agent.getModelClientFactory();
            factory.setAuthManager(this.currentAuthManager);
          }
        }
      });

      // 4. Configure PromptComposer with platform context BEFORE agent.initialize()
      // This must happen first so PiAgent.configurePromptComposition() sees
      // the composer is already configured and skips re-configuration.
      await this.configurePromptWithPlatformInfo();

      // 5. Create TauriChannel and wire up event forwarding BEFORE agent.initialize()
      // agent.initialize() may emit warning events (e.g. "No API key configured"),
      // so the event dispatcher must be set first to avoid losing those events.
      this.channel = new TauriChannel();

      const channelManager = getChannelManager();

      // Set up the agent handler on ChannelManager
      // This routes submissions from channels to the correct session in the registry
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!this.registry) {
          throw new Error(t('Agent registry not initialized'));
        }

        console.log('[DesktopAgentBootstrap] Processing submission:', op.type, 'for session:', context.sessionId);

        // Find or create the target session
        let targetSession = null;
        if (context.sessionId) {
          targetSession = this.registry.getSession(context.sessionId);
        }

        // Fallback to primary session if no specific session is targeted or found
        if (!targetSession && this.primaryAgent) {
          targetSession = this.registry.getPrimarySession();
        }

        if (!targetSession) {
          throw new Error(t('Target session not found'));
        }

        // Submit the operation to the target agent
        if (targetSession.agent) {
          await targetSession.agent.submitOperation(op, { tabId: context.tabId });
        } else {
          throw new Error(t('Target session agent is null'));
        }
      };

      channelManager.setAgentHandler(agentHandler);

      // Register the TauriChannel with ChannelManager
      await channelManager.registerChannel(this.channel);
      console.log('[DesktopAgentBootstrap] Channel registered');

      // Wire up agent events to be dispatched through the channel
      this.setupEventForwarding(channelManager);

      // 6. Set up a polling loop to dispatch events from all active sessions
      // (This replicates the service-worker event broadcasting loop)
      this.startEventPollingLoop();

      // 6b. Initialize skills (filesystem-backed, prompt extension)
      await this.initializeSkills();

      // 7. Restore auth mode from keychain and listen for changes
      // Same business logic as extension: logged in → backend routing, not logged in → api_key
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL } = await import('../../webfront/lib/constants');
      const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);

      // Listen for auth changes (implicit login via deep link)
      // This allows the agent to switch to backend routing automatically when user logs in
      authService.onAuthChange(async () => {
        console.log('[DesktopAgentBootstrap] Auth state changed, reloading auth mode...');
        await this.restoreAuthFromKeychain(config);

        // Also notify the UI that auth has changed so it re-runs health check
        if (this.messageRouter) {
          this.messageRouter.send(MessageType.AGENT_REINITIALIZED);
        }
      });

      await this.restoreAuthFromKeychain(config);

      // 8. Set up MCP tool registration events
      await this.setupMCPToolRegistration();

      this.initialized = true;
      console.log('[DesktopAgentBootstrap] Initialization complete');

      // Also notify the UI that initialization has completed so it re-runs its health check
      // This is crucial because the UI may have mounted and run checkConnection()
      // BEFORE the async keychain access from restoreAuthFromKeychain() finished.
      if (this.messageRouter) {
        this.messageRouter.send(MessageType.AGENT_REINITIALIZED);
      }
    } catch (error) {
      console.error('[DesktopAgentBootstrap] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Set up event forwarding from agent to channel
   *
   * Uses AgentRegistry's event stream. Wait, actually AgentRegistry events are distinct
   * from PiAgent's regular events. `AgentRegistry` events are system-level. Let's just
   * keep this empty or hook into registry events if needed. In Desktop mode, we'll
   * use the polling loop below (startEventPollingLoop) to extract and forward PiAgent events.
   */
  private setupEventForwarding(channelManager: ReturnType<typeof getChannelManager>): void {
    if (!this.registry || !this.channel) {
      console.warn('[DesktopAgentBootstrap] Cannot setup event forwarding: registry or channel not initialized');
      return;
    }
  }

  /**
   * Set up a polling loop to extract events out of all active background
   * sessions and dispatch them to the MessageRouter.
   * This is equivalent to service-worker.ts's `setInterval()` loop.
   */
  private startEventPollingLoop(): void {
    setInterval(async () => {
      if (!this.messageRouter || !this.registry) return;

      for (const sessionMeta of this.registry.listSessions()) {
        const session = this.registry.getSession(sessionMeta.sessionId);
        if (session?.agent) {
          const event = await session.agent.getNextEvent();
          if (event) {
            // Forward event using DesktopMessageRouter. This matches the extension's
            // routing pattern by packing the sessionId directly into the payload.
            await this.messageRouter.send(MessageType.EVENT, {
              ...event,
              sessionId: sessionMeta.sessionId
            });
          }
        }
      }
    }, 100);
  }

  /**
   * Set up MCP tool registration events for desktop.
   * Subscribes to MCPManager 'tools-updated' events so tools are
   * auto-registered/unregistered when MCP servers connect/disconnect.
   */
  private async setupMCPToolRegistration(): Promise<void> {
    if (!this.primaryAgent) { // Changed from this.agent
      return;
    }

    try {
      const { MCPManager } = await import('../../core/mcp/MCPManager');
      const { registerMCPTools, unregisterMCPTools } = await import('../../core/mcp/MCPToolAdapter');
      const mcpManager = await MCPManager.getInstance('desktop');
      const registry = this.primaryAgent.getToolRegistry(); // Changed from this.agent

      // Track registered tools per server so we can unregister them on disconnect.
      // MCPManager clears connection.tools before emitting the event, so we
      // can't read them from the connection at unregister time.
      const registeredToolsByServer = new Map<string, import('../../core/mcp/types').IMCPTool[]>();

      mcpManager.on('event', (event) => {
        if (event.type !== 'tools-updated') return;

        const config = mcpManager.getServer(event.configId);
        if (!config) return;

        // Unregister previously registered tools first (handles both disconnect and reconnect)
        const previousTools = registeredToolsByServer.get(event.configId);
        if (previousTools && previousTools.length > 0) {
          unregisterMCPTools(config.name, previousTools, registry).catch((error) => {
            console.error('[DesktopAgentBootstrap] Failed to unregister MCP tools:', error);
          });
          registeredToolsByServer.delete(event.configId);
        }

        if (event.tools.length > 0) {
          // Tools discovered — register them and track for later unregistration
          registerMCPTools(mcpManager, config.name, event.tools, registry).catch((error) => {
            console.error('[DesktopAgentBootstrap] Failed to register MCP tools:', error);
          });
          registeredToolsByServer.set(event.configId, event.tools);
        }
      });
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not set up MCP tool registration:', error);
    }
  }

  /**
   * Initialize the skill registry with filesystem-backed provider.
   * Discovers existing skills and registers a prompt extension for auto-invocable skills.
   */
  private async initializeSkills(): Promise<void> {
    try {
      const provider = new FilesystemSkillProvider();
      await provider.initialize();

      this.skillRegistry = new SkillRegistry(provider);
      await this.skillRegistry.discover();

      registerPromptExtension(() => this.skillRegistry!.buildSkillsSystemPrompt());

      // Register use_skill tool if there are any skills
      const allSkills = this.skillRegistry.getSkillMetas();
      if (allSkills.length > 0 && this.agent) {
        const registry = this.agent.getToolRegistry();

        await registry.register(
          {
            type: 'function',
            function: {
              name: 'use_skill',
              description: 'Invoke a user-defined skill by name. When the user types /skill-name, call this tool with that name. Also use proactively when an auto-invocable skill is relevant. Returns the skill body with instructions to follow.',
              strict: false,
              parameters: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'The skill name to invoke' },
                  arguments: { type: 'string', description: 'Optional space-separated arguments for the skill' },
                },
                required: ['name'],
              },
            },
          },
          async (params) => {
            const skillName = params.name as string;
            const args = params.arguments as string | undefined;

            const knownNames = new Set(this.skillRegistry!.getSkillMetas().map((s) => s.name));
            if (!knownNames.has(skillName)) {
              return { error: `Skill "${skillName}" not found. Available skills: ${[...knownNames].join(', ')}` };
            }

            const body = await this.skillRegistry!.invoke(skillName, args ? args.split(/\s+/) : []);
            if (!body) {
              return { error: `Failed to load skill "${skillName}"` };
            }

            return body;
          },
          new StaticRiskAssessor(0)
        );

        console.log('[DesktopAgentBootstrap] use_skill tool registered for', allSkills.length, 'skills');
      }

      console.log('[DesktopAgentBootstrap] Skills initialized, found', this.skillRegistry.getSkillMetas().length, 'skills');
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not initialize skills:', error);
    }
  }

  /**
   * Get the skill registry instance (null if not yet initialized)
   */
  getSkillRegistry(): SkillRegistry | null {
    return this.skillRegistry;
  }

  /**
   * Collect platform info from Tauri and configure PromptComposer for Pi agent.
   * Called before agent.initialize() so the dynamic prompt includes OS/arch/shell.
   */
  private async configurePromptWithPlatformInfo(): Promise<void> {
    const staticContext: Partial<RuntimeContext> = {
      browserConnection: 'mcp',
    };

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platformInfo = await invoke<{ os: string; arch: string; version: string }>('get_platform_info');
      staticContext.os = platformInfo.os;
      staticContext.arch = platformInfo.arch;
      staticContext.osVersion = platformInfo.version;
      // TODO: Heuristic-based shell detection — assumes default shell per OS.
      // Actual shell detection requires a Rust-side Tauri command (out of scope).
      staticContext.shell = platformInfo.os === 'macos' ? 'zsh'
        : platformInfo.os === 'windows' ? 'powershell' : 'bash';

      const { homeDir } = await import('@tauri-apps/api/path');
      staticContext.homeDir = await homeDir();
    } catch (e) {
      console.warn('[DesktopAgentBootstrap] Could not fetch platform info:', e);
    }

    configurePromptComposer('pi', staticContext);
    console.log('[DesktopAgentBootstrap] PromptComposer configured for pi with platform context');
  }

  /**
   * Get the agent instance
   */
  getAgent(): PiAgent | null {
    return this.primaryAgent;
  }

  /**
   * Get the active registry
   */
  getRegistry(): AgentRegistry | null {
    return this.registry;
  }

  /**
   * Handle config update notification
   * Called when settings are changed in the UI
   */
  async handleConfigUpdate(): Promise<void> {
    if (!this.primaryAgent) { // Changed from this.agent
      console.warn('[DesktopAgentBootstrap] Cannot handle config update: primary agent not initialized');
      return;
    }

    try {
      console.log('[DesktopAgentBootstrap] Handling config update...');

      // Refresh the model client with new config
      await this.primaryAgent.refreshModelClient(); // Changed from this.agent

      console.log('[DesktopAgentBootstrap] Config update handled successfully');
    } catch (error) {
      console.error('[DesktopAgentBootstrap] Failed to handle config update:', error);
    }
  }

  /**
   * Restore auth mode from keychain during initialization.
   * If the user has a valid token in keychain → backend routing.
   * Otherwise → api_key mode (user must configure their own key).
   */
  private async restoreAuthFromKeychain(config: AgentConfig): Promise<void> {
    if (!this.primaryAgent) {
      console.warn('[DesktopAgentBootstrap] Cannot restore auth: primary agent not initialized');
      return;
    }

    console.log('[DesktopAgentBootstrap] Restoring auth from keychain...');
    try {
      // 1. Check if user is logged in
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL, LLM_API_URL } = await import('../../webfront/lib/constants');
      // Note: do NOT call authService.initialize() here — this function only reads
      // tokens from the keychain and does not need the deep-link listener.
      // initialize() is called once by App.svelte and UserLoginStatus.svelte.
      const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);

      const hasToken = await authService.hasValidToken();

      if (hasToken) {
        // User is logged in → backend routing (pass token getter for Bearer auth)
        const tokenGetter = () => authService.getAccessToken();
        await this.setAuthMode(false, LLM_API_URL, tokenGetter);

        // Update all active sessions
        if (this.registry) {
          for (const sessionMeta of this.registry.listSessions()) {
            const session = this.registry.getSession(sessionMeta.sessionId);
            if (session?.agent) {
              await session.agent.refreshModelClient();
            }
          }
        }

        // Persist preference if not already set
        const agentConfig = config.getConfig();
        if (agentConfig.preferences?.useOwnApiKey === undefined) {
          await config.updateConfig({
            preferences: { ...agentConfig.preferences, useOwnApiKey: false },
          });
        }

        console.log('[DesktopAgentBootstrap] Auth restored from keychain → backend routing');
      } else {
        console.log('[DesktopAgentBootstrap] No valid token in keychain → api_key mode');
      }
    } catch (error) {
      console.warn('[DesktopAgentBootstrap] Could not restore auth from keychain:', error);
    }
  }

  /**
   * Set the authentication mode on the agent's ModelClientFactory.
   * Called directly by UI code after login or on startup.
   * @param tokenGetter - Optional async function to retrieve access token (desktop keychain)
   */
  async setAuthMode(useOwnApiKey: boolean, backendBaseUrl: string | null, tokenGetter?: () => Promise<string | null>): Promise<void> {
    const shouldUseBackend = !useOwnApiKey;
    this.currentAuthManager = new AuthManager(shouldUseBackend, shouldUseBackend ? backendBaseUrl : null, tokenGetter);

    console.log('[DesktopAgentBootstrap] Auth mode set, isBackendRouting:', shouldUseBackend);

    if (this.registry) {
      for (const sessionMeta of this.registry.listSessions()) {
        const session = this.registry.getSession(sessionMeta.sessionId);
        if (session?.agent) {
          const factory = session.agent.getModelClientFactory();
          factory.setAuthManager(this.currentAuthManager);
          await session.agent.refreshModelClient();
        }
      }
    }
  }

  /**
   * Get the channel instance
   */
  getChannel(): TauriChannel | null {
    return this.channel;
  }

  /**
   * Check if the agent is ready
   */
  async isReady(): Promise<boolean> {
    if (!this.primaryAgent) { // Changed from this.agent
      return false;
    }
    const readyState = await this.primaryAgent.isReady(); // Changed from this.agent
    return readyState.ready;
  }

  /**
   * Get agent ready state with details
   */
  async getReadyState() {
    if (!this.primaryAgent) { // Changed from this.agent
      return {
        ready: false,
        message: t('Agent not initialized'),
        authMode: 'none' as const,
      };
    }
    return await this.primaryAgent.isReady(); // Changed from this.agent
  }

  /**
   * Shutdown the agent system
   */
  async shutdown(): Promise<void> {
    console.log('[DesktopAgentBootstrap] Shutting down...');

    // Shutdown channel manager (which shuts down all channels)
    const channelManager = getChannelManager();
    await channelManager.shutdown();

    // Cleanup agent
    if (this.primaryAgent) { // Changed from this.agent
      await this.primaryAgent.cleanup(); // Changed from this.agent
      this.primaryAgent = null; // Changed from this.agent
    }

    // Cleanup message router
    if (this.messageRouter) {
      this.messageRouter.destroy();
      this.messageRouter = null;
    }

    this.channel = null;
    this.initialized = false;

    console.log('[DesktopAgentBootstrap] Shutdown complete');
  }
}

/**
 * Get or create the singleton instance
 */
export function getDesktopAgentBootstrap(): DesktopAgentBootstrap {
  if (!_instance) {
    _instance = new DesktopAgentBootstrap();
  }
  return _instance;
}

/**
 * Initialize the desktop agent system
 * Convenience function that gets the singleton and initializes it
 */
export async function initializeDesktopAgent(): Promise<DesktopAgentBootstrap> {
  const bootstrap = getDesktopAgentBootstrap();
  await bootstrap.initialize();
  return bootstrap;
}
