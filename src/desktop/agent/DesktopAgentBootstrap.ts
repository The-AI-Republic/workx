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
import { PiAgent } from '@/core/PiAgent';
import { MessageType } from '@/core/MessageRouter';
import { AgentConfig } from '@/config/AgentConfig';
import { configurePromptComposer } from '@/core/PromptLoader';
import type { RuntimeContext } from '@/prompts/PromptComposer';
import { AuthManager } from '@/core/models/types/Auth';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';
import { t } from '@/extension/sidepanel/lib/i18n';

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
  private agent: PiAgent | null = null;
  private channel: TauriChannel | null = null;
  private messageRouter: DesktopMessageRouter | null = null;
  private initialized = false;

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

      // 2. Get agent config
      const config = await AgentConfig.getInstance();

      // 3. Create PiAgent
      // PiAgent expects a MessageRouter with updateState method
      // DesktopMessageRouter provides this compatibility
      this.agent = new PiAgent(config, this.messageRouter as any);

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
      // This routes submissions from channels to the agent
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!this.agent) {
          throw new Error(t('Agent not initialized'));
        }

        console.log('[DesktopAgentBootstrap] Processing submission:', op.type);

        // Submit the operation to the agent
        await this.agent.submitOperation(op, { tabId: context.tabId });
      };

      channelManager.setAgentHandler(agentHandler);

      // Register the TauriChannel with ChannelManager
      await channelManager.registerChannel(this.channel);
      console.log('[DesktopAgentBootstrap] Channel registered');

      // Wire up agent events to be dispatched through the channel
      this.setupEventForwarding(channelManager);

      // 6. Initialize the agent (loads model client, tools, etc.)
      // Event dispatcher is already set, so any warning events reach the channel.
      await this.agent.initialize();
      console.log('[DesktopAgentBootstrap] Agent initialized');

      // 7. Restore auth mode from keychain and listen for changes
      // Same business logic as extension: logged in → backend routing, not logged in → api_key
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL } = await import('@/extension/sidepanel/lib/constants');
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
    } catch (error) {
      console.error('[DesktopAgentBootstrap] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Set up event forwarding from agent to channel
   *
   * Uses PiAgent's setEventDispatcher to route events through
   * ChannelManager instead of chrome.runtime.sendMessage.
   */
  private setupEventForwarding(channelManager: ReturnType<typeof getChannelManager>): void {
    if (!this.agent || !this.channel) {
      console.warn('[DesktopAgentBootstrap] Cannot setup event forwarding: agent or channel not initialized');
      return;
    }

    // Set the event dispatcher on PiAgent
    // Events will be routed through ChannelManager to TauriChannel
    this.agent.setEventDispatcher((event) => {
      // Dispatch event to the Tauri channel
      channelManager.dispatchEvent(event.msg, this.channel!.channelId).catch((error) => {
        console.error('[DesktopAgentBootstrap] Failed to dispatch event:', error);
      });
    });

    console.log('[DesktopAgentBootstrap] Event forwarding configured via ChannelManager');
  }

  /**
   * Set up MCP tool registration events for desktop.
   * Subscribes to MCPManager 'tools-updated' events so tools are
   * auto-registered/unregistered when MCP servers connect/disconnect.
   */
  private async setupMCPToolRegistration(): Promise<void> {
    if (!this.agent) {
      return;
    }

    try {
      const { MCPManager } = await import('@/core/mcp/MCPManager');
      const { registerMCPTools, unregisterMCPTools } = await import('@/core/mcp/MCPToolAdapter');
      const mcpManager = await MCPManager.getInstance('desktop');
      const registry = this.agent.getToolRegistry();

      // Track registered tools per server so we can unregister them on disconnect.
      // MCPManager clears connection.tools before emitting the event, so we
      // can't read them from the connection at unregister time.
      const registeredToolsByServer = new Map<string, import('@/core/mcp/types').IMCPTool[]>();

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
    return this.agent;
  }

  /**
   * Handle config update notification
   * Called when settings are changed in the UI
   */
  async handleConfigUpdate(): Promise<void> {
    if (!this.agent) {
      console.warn('[DesktopAgentBootstrap] Cannot handle config update: agent not initialized');
      return;
    }

    try {
      console.log('[DesktopAgentBootstrap] Handling config update...');

      // Refresh the model client with new config
      await this.agent.refreshModelClient();

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
    try {
      const { getDesktopAuthService } = await import('../auth/DesktopAuthService');
      const { HOME_PAGE_BASE_URL, LLM_API_URL } = await import('@/extension/sidepanel/lib/constants');
      const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);
      await authService.initialize();

      const hasToken = await authService.hasValidToken();

      if (hasToken) {
        // User is logged in → backend routing (pass token getter for Bearer auth)
        const tokenGetter = () => authService.getAccessToken();
        await this.setAuthMode(false, LLM_API_URL, tokenGetter);

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
    if (!this.agent) {
      console.warn('[DesktopAgentBootstrap] Cannot set auth mode: agent not initialized');
      return;
    }

    const shouldUseBackend = !useOwnApiKey;
    const authManager = new AuthManager(shouldUseBackend, shouldUseBackend ? backendBaseUrl : null, tokenGetter);

    const factory = this.agent.getModelClientFactory();
    factory.setAuthManager(authManager);

    console.log('[DesktopAgentBootstrap] Auth mode set, isBackendRouting:', factory.isBackendRouting());

    await this.agent.refreshModelClient();
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
    if (!this.agent) {
      return false;
    }
    const readyState = await this.agent.isReady();
    return readyState.ready;
  }

  /**
   * Get agent ready state with details
   */
  async getReadyState() {
    if (!this.agent) {
      return {
        ready: false,
        message: t('Agent not initialized'),
        authMode: 'none' as const,
      };
    }
    return await this.agent.isReady();
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
    if (this.agent) {
      await this.agent.cleanup();
      this.agent = null;
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
