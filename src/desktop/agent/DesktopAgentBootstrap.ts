/**
 * Desktop Agent Bootstrap
 *
 * Initializes and wires up the BrowserxAgent with the channel system for desktop mode.
 * In desktop mode, the agent runs directly in the WebView (same process as UI).
 *
 * Flow:
 * 1. Create ChannelManager (routes submissions to agent, events to channels)
 * 2. Create TauriChannel (receives submissions from UI, sends events to UI)
 * 3. Create BrowserxAgent (processes submissions, emits events)
 * 4. Wire them together
 *
 * @module desktop/agent/DesktopAgentBootstrap
 */

import { TauriChannel } from '../channels/TauriChannel';
import { DesktopMessageRouter } from '../channels/DesktopMessageRouter';
import { getChannelManager, type AgentHandler } from '@/core/channels/ChannelManager';
import { BrowserxAgent } from '@/core/BrowserxAgent';
import { MessageType } from '@/core/MessageRouter';
import { AgentConfig } from '@/config/AgentConfig';
import { AuthManager } from '@/core/models/types/Auth';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '@/core/channels/types';
import type { EventMsg } from '@/core/protocol/events';

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
  private agent: BrowserxAgent | null = null;
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
      // 1. Create the message router for BrowserxAgent
      this.messageRouter = new DesktopMessageRouter('background');

      // 2. Get agent config
      const config = await AgentConfig.getInstance();

      // 3. Create BrowserxAgent
      // BrowserxAgent expects a MessageRouter with updateState method
      // DesktopMessageRouter provides this compatibility
      this.agent = new BrowserxAgent(config, this.messageRouter as any);

      // 4. Initialize the agent (loads model client, tools, etc.)
      await this.agent.initialize();
      console.log('[DesktopAgentBootstrap] Agent initialized');

      // 4.5. Restore auth mode from keychain and listen for changes
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

      // 5. Create and initialize TauriChannel
      this.channel = new TauriChannel();

      // 6. Get the ChannelManager singleton
      const channelManager = getChannelManager();

      // 7. Set up the agent handler on ChannelManager
      // This routes submissions from channels to the agent
      const agentHandler: AgentHandler = async (op: Op, context: SubmissionContext) => {
        if (!this.agent) {
          throw new Error('Agent not initialized');
        }

        console.log('[DesktopAgentBootstrap] Processing submission:', op.type);

        // Submit the operation to the agent
        await this.agent.submitOperation(op, { tabId: context.tabId });
      };

      channelManager.setAgentHandler(agentHandler);

      // 8. Register the TauriChannel with ChannelManager
      // This sets up the submission handler and initializes the channel
      await channelManager.registerChannel(this.channel);
      console.log('[DesktopAgentBootstrap] Channel registered');

      // 9. Wire up agent events to be dispatched through the channel
      this.setupEventForwarding(channelManager);

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
   * Uses BrowserxAgent's setEventDispatcher to route events through
   * ChannelManager instead of chrome.runtime.sendMessage.
   */
  private setupEventForwarding(channelManager: ReturnType<typeof getChannelManager>): void {
    if (!this.agent || !this.channel) {
      console.warn('[DesktopAgentBootstrap] Cannot setup event forwarding: agent or channel not initialized');
      return;
    }

    // Set the event dispatcher on BrowserxAgent
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
   * Get the agent instance
   */
  getAgent(): BrowserxAgent | null {
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
        message: 'Agent not initialized',
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
