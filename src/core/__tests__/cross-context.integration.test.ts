import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// These imports will initially fail because the implementations don't exist yet
import { AgentConfig } from '@/config/AgentConfig';
import { ConfigMessenger } from '@/messaging/ConfigMessenger';
import { createConfigMessage, isConfigMessage } from '@/protocol/config-messages';
import type { AgentConfigData, ConfigMessage } from '@/config/types';

// Mock Chrome extension contexts
const mockBackgroundPort = {
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() }
};

const mockContentPort = {
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() }
};

const mockSidepanelPort = {
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() }
};

const mockChromeRuntime = {
  connect: vi.fn((connectInfo: any) => {
    switch (connectInfo?.name) {
      case 'background':
        return mockBackgroundPort;
      case 'content':
        return mockContentPort;
      case 'sidepanel':
        return mockSidepanelPort;
      default:
        return mockBackgroundPort;
    }
  }),
  sendMessage: vi.fn(),
  onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  onConnect: { addListener: vi.fn() }
};

const mockChromeStorage = {
  get: vi.fn(),
  set: vi.fn(),
  onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
};

// @ts-ignore
global.chrome = {
  runtime: mockChromeRuntime,
  storage: {
    sync: mockChromeStorage,
    local: mockChromeStorage
  }
};

describe('Cross-Context Configuration Sync', () => {
  let backgroundConfig: AgentConfig;
  let contentConfig: AgentConfig;
  let sidepanelConfig: AgentConfig;
  let backgroundMessenger: ConfigMessenger;
  let contentMessenger: ConfigMessenger;
  let sidepanelMessenger: ConfigMessenger;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset all singleton instances
    AgentConfig.resetInstance?.();

    // Create context-specific instances
    backgroundConfig = AgentConfig.getInstance('background');
    contentConfig = AgentConfig.getInstance('content');
    sidepanelConfig = AgentConfig.getInstance('sidepanel');

    // Create messengers for each context
    backgroundMessenger = new ConfigMessenger('background');
    contentMessenger = new ConfigMessenger('content');
    sidepanelMessenger = new ConfigMessenger('sidepanel');

    // Initialize configurations
    await backgroundConfig.initialize();
    await contentConfig.initialize();
    await sidepanelConfig.initialize();
  });

  afterEach(() => {
    AgentConfig.resetInstance?.();
  });

  describe('Configuration Synchronization', () => {
    it('should sync config from background to content script', async () => {
      // Simulate message passing setup
      let contentMessageListener: Function;
      mockContentPort.onMessage.addListener.mockImplementation((listener) => {
        contentMessageListener = listener;
      });

      // Setup content script to listen for config messages
      contentMessenger.startListening();

      // Update configuration in background
      const newConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      };

      await backgroundConfig.updateConfig(newConfig);

      // Simulate message from background to content
      const configMessage = createConfigMessage('CONFIG_UPDATE', newConfig, 'background');
      contentMessageListener!(configMessage);

      // Content script should have updated configuration
      const contentConfigData = contentConfig.getConfig();
      expect(contentConfigData.model).toBe('claude-3-haiku-20240307');
      expect(contentConfigData.approval_policy).toBe('never');
    });

    it('should sync config from sidepanel to background', async () => {
      let backgroundMessageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        backgroundMessageListener = listener;
      });

      backgroundMessenger.startListening();

      // Update configuration in sidepanel
      const newConfig: Partial<AgentConfigData> = {
        model: 'claude-3-opus-20240229',
        sandbox_policy: { mode: 'workspace-write', network_access: true }
      };

      await sidepanelConfig.updateConfig(newConfig);

      // Simulate message from sidepanel to background
      const configMessage = createConfigMessage('CONFIG_UPDATE', newConfig, 'sidepanel');
      backgroundMessageListener!(configMessage);

      // Background should have updated configuration
      const backgroundConfigData = backgroundConfig.getConfig();
      expect(backgroundConfigData.model).toBe('claude-3-opus-20240229');
      expect(backgroundConfigData.sandbox_policy.mode).toBe('workspace-write');
    });

    it('should handle bidirectional sync requests', async () => {
      let backgroundMessageListener: Function;
      let contentMessageListener: Function;

      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        backgroundMessageListener = listener;
      });
      mockContentPort.onMessage.addListener.mockImplementation((listener) => {
        contentMessageListener = listener;
      });

      backgroundMessenger.startListening();
      contentMessenger.startListening();

      // Content requests current config from background
      const syncRequest = createConfigMessage('SYNC_REQUEST', { requestId: 'sync-001' }, 'content');
      backgroundMessageListener!(syncRequest);

      // Background should respond with current config
      const currentConfig = backgroundConfig.getConfig();
      const syncResponse = createConfigMessage('SYNC_RESPONSE', {
        requestId: 'sync-001',
        config: currentConfig,
        activeProfile: backgroundConfig.getActiveProfile()
      }, 'background');

      contentMessageListener!(syncResponse);

      // Content should now have same config as background
      expect(contentConfig.getConfig()).toEqual(currentConfig);
    });
  });

  describe('Profile Synchronization', () => {
    it('should sync profile creation across contexts', async () => {
      let contentMessageListener: Function;
      mockContentPort.onMessage.addListener.mockImplementation((listener) => {
        contentMessageListener = listener;
      });

      contentMessenger.startListening();

      // Create profile in background
      const profileConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'untrusted'
      };

      await backgroundConfig.createProfile('development', profileConfig);

      // Simulate profile creation message
      const profileMessage = createConfigMessage('PROFILE_CREATED', {
        profileName: 'development',
        profile: {
          name: 'development',
          config: profileConfig,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }, 'background');

      contentMessageListener!(profileMessage);

      // Content should have the new profile
      const contentProfiles = contentConfig.getProfiles();
      expect(contentProfiles).toHaveProperty('development');
      expect(contentProfiles.development.config.model).toBe('claude-3-haiku-20240307');
    });

    it('should sync profile switching across contexts', async () => {
      let backgroundMessageListener: Function;
      let contentMessageListener: Function;

      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        backgroundMessageListener = listener;
      });
      mockContentPort.onMessage.addListener.mockImplementation((listener) => {
        contentMessageListener = listener;
      });

      backgroundMessenger.startListening();
      contentMessenger.startListening();

      // Create development profile in both contexts
      const devConfig = { model: 'claude-3-haiku-20240307', approval_policy: 'never' as const };
      await backgroundConfig.createProfile('development', devConfig);
      await contentConfig.createProfile('development', devConfig);

      // Switch profile in background
      await backgroundConfig.switchProfile('development');

      // Simulate profile switch message to content
      const switchMessage = createConfigMessage('PROFILE_SWITCH', {
        profileName: 'development'
      }, 'background');

      contentMessageListener!(switchMessage);

      // Content should switch to same profile
      expect(contentConfig.getActiveProfile()).toBe('development');
      expect(contentConfig.getConfig().model).toBe('claude-3-haiku-20240307');
    });

    it('should handle profile deletion sync', async () => {
      let sidepanelMessageListener: Function;
      mockSidepanelPort.onMessage.addListener.mockImplementation((listener) => {
        sidepanelMessageListener = listener;
      });

      sidepanelMessenger.startListening();

      // Create and switch to temp profile in sidepanel
      await sidepanelConfig.createProfile('temp', { model: 'claude-3-haiku-20240307' });
      await sidepanelConfig.switchProfile('temp');

      // Delete profile in background (simulated)
      const deleteMessage = createConfigMessage('PROFILE_DELETED', {
        profileName: 'temp',
        switchedToProfile: 'default'
      }, 'background');

      sidepanelMessageListener!(deleteMessage);

      // Sidepanel should no longer have temp profile and switch to default
      const profiles = sidepanelConfig.getProfiles();
      expect(profiles).not.toHaveProperty('temp');
      expect(sidepanelConfig.getActiveProfile()).toBe('default');
    });
  });

  describe('Message Routing and Filtering', () => {
    it('should route messages to appropriate handlers', async () => {
      const backgroundHandlers = {
        onConfigUpdate: vi.fn(),
        onProfileSwitch: vi.fn(),
        onSyncRequest: vi.fn()
      };

      backgroundMessenger.setHandlers(backgroundHandlers);

      let messageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      backgroundMessenger.startListening();

      // Send different message types
      const updateMessage = createConfigMessage('CONFIG_UPDATE', { model: 'claude-3-haiku-20240307' });
      const profileMessage = createConfigMessage('PROFILE_SWITCH', { profileName: 'development' });
      const syncMessage = createConfigMessage('SYNC_REQUEST', { requestId: 'req-123' });

      messageListener!(updateMessage);
      messageListener!(profileMessage);
      messageListener!(syncMessage);

      // Each handler should be called appropriately
      expect(backgroundHandlers.onConfigUpdate).toHaveBeenCalledWith(
        updateMessage.payload, updateMessage
      );
      expect(backgroundHandlers.onProfileSwitch).toHaveBeenCalledWith(
        profileMessage.payload, profileMessage
      );
      expect(backgroundHandlers.onSyncRequest).toHaveBeenCalledWith(
        syncMessage.payload, syncMessage
      );
    });

    it('should filter messages by context', async () => {
      const contentHandler = vi.fn();

      let messageListener: Function;
      mockContentPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      contentMessenger.onConfigMessage(contentHandler);

      // Send messages from different contexts
      const backgroundMessage = createConfigMessage('CONFIG_UPDATE', {}, 'background');
      const sidepanelMessage = createConfigMessage('CONFIG_UPDATE', {}, 'sidepanel');
      const contentMessage = createConfigMessage('CONFIG_UPDATE', {}, 'content');

      messageListener!(backgroundMessage);
      messageListener!(sidepanelMessage);
      messageListener!(contentMessage);

      // Content should process all messages except its own
      expect(contentHandler).toHaveBeenCalledTimes(2);
    });

    it('should handle message validation', async () => {
      let messageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      backgroundMessenger.startListening();

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send invalid message
      const invalidMessage = { type: 'INVALID_MESSAGE' };
      messageListener!(invalidMessage);

      // Should log warning and not crash
      expect(consoleSpy).toHaveBeenCalledWith(
        'Received non-config message:', invalidMessage
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Connection Management', () => {
    it('should handle connection failures gracefully', async () => {
      // Mock connection failure
      mockChromeRuntime.connect.mockImplementation(() => {
        throw new Error('Connection failed');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const failingMessenger = new ConfigMessenger('failing-context');

      // Should not throw, but log error
      expect(() => failingMessenger.startListening()).not.toThrow();

      consoleSpy.mockRestore();
    });

    it('should reconnect on port disconnect', async () => {
      let disconnectListener: Function;
      mockBackgroundPort.onDisconnect.addListener.mockImplementation((listener) => {
        disconnectListener = listener;
      });

      backgroundMessenger.startListening();

      const connectSpy = vi.spyOn(mockChromeRuntime, 'connect');

      // Simulate port disconnect
      disconnectListener!();

      // Should attempt to reconnect
      expect(connectSpy).toHaveBeenCalledTimes(2); // Initial + reconnect
    });

    it('should handle multiple connection attempts', async () => {
      const messenger = new ConfigMessenger('multi-connect');

      // Multiple start listening calls should not create multiple connections
      messenger.startListening();
      messenger.startListening();
      messenger.startListening();

      expect(mockChromeRuntime.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Sync Conflict Resolution', () => {
    it('should resolve concurrent config updates', async () => {
      let backgroundMessageListener: Function;
      let contentMessageListener: Function;

      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        backgroundMessageListener = listener;
      });
      mockContentPort.onMessage.addListener.mockImplementation((listener) => {
        contentMessageListener = listener;
      });

      backgroundMessenger.startListening();
      contentMessenger.startListening();

      // Concurrent updates from different contexts
      const backgroundUpdate = createConfigMessage('CONFIG_UPDATE', {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      }, 'background');

      const contentUpdate = createConfigMessage('CONFIG_UPDATE', {
        model: 'claude-3-opus-20240229',
        sandbox_policy: { mode: 'workspace-write' }
      }, 'content');

      // Simulate near-simultaneous updates
      backgroundMessageListener!(contentUpdate);
      contentMessageListener!(backgroundUpdate);

      // Last update should win (timestamp-based resolution)
      const backgroundFinalConfig = backgroundConfig.getConfig();
      const contentFinalConfig = contentConfig.getConfig();

      expect(backgroundFinalConfig).toEqual(contentFinalConfig);
    });

    it('should handle profile switch conflicts', async () => {
      let messageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      backgroundMessenger.startListening();

      // Create profiles
      await backgroundConfig.createProfile('dev', { model: 'claude-3-haiku-20240307' });
      await backgroundConfig.createProfile('prod', { model: 'claude-3-opus-20240229' });

      // Simulate conflicting profile switches
      const devSwitch = createConfigMessage('PROFILE_SWITCH', { profileName: 'dev' }, 'content');
      const prodSwitch = createConfigMessage('PROFILE_SWITCH', { profileName: 'prod' }, 'sidepanel');

      messageListener!(devSwitch);
      messageListener!(prodSwitch);

      // Should settle on one profile (latest timestamp wins)
      const activeProfile = backgroundConfig.getActiveProfile();
      expect(['dev', 'prod']).toContain(activeProfile);
    });

    it('should handle storage conflicts during sync', async () => {
      // Mock storage conflict (version mismatch)
      mockChromeStorage.get.mockResolvedValue({
        'browserx-agent-config': {
          version: '1.0.0',
          model: 'claude-3-haiku-20240307',
          lastModified: Date.now() + 1000 // Newer than current
        }
      });

      let messageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      backgroundMessenger.startListening();

      // Simulate config update from another context
      const updateMessage = createConfigMessage('CONFIG_UPDATE', {
        model: 'claude-3-opus-20240229',
        lastModified: Date.now()
      }, 'content');

      messageListener!(updateMessage);

      // Should resolve conflict in favor of newer storage version
      const finalConfig = backgroundConfig.getConfig();
      expect(finalConfig.model).toBe('claude-3-haiku-20240307');
    });
  });

  describe('Performance and Optimization', () => {
    it('should debounce rapid cross-context updates', async () => {
      let messageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      const updateSpy = vi.spyOn(backgroundConfig, 'updateConfig');
      backgroundMessenger.startListening();

      // Send rapid updates
      const updates = [
        createConfigMessage('CONFIG_UPDATE', { model: 'claude-3-haiku-20240307' }),
        createConfigMessage('CONFIG_UPDATE', { approval_policy: 'never' }),
        createConfigMessage('CONFIG_UPDATE', { cwd: '/new/workspace' })
      ];

      updates.forEach(update => messageListener!(update));

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have batched updates
      expect(updateSpy.mock.calls.length).toBeLessThan(3);
    });

    it('should handle high message volume efficiently', async () => {
      let messageListener: Function;
      mockBackgroundPort.onMessage.addListener.mockImplementation((listener) => {
        messageListener = listener;
      });

      backgroundMessenger.startListening();

      const start = Date.now();

      // Send many messages
      for (let i = 0; i < 100; i++) {
        const message = createConfigMessage('CONFIG_UPDATE', { cwd: `/workspace-${i}` });
        messageListener!(message);
      }

      const end = Date.now();

      // Should process messages efficiently
      expect(end - start).toBeLessThan(500); // Less than 500ms for 100 messages
    });

    it('should cleanup resources on context shutdown', () => {
      backgroundMessenger.startListening();

      const disconnectSpy = vi.fn();
      mockBackgroundPort.disconnect = disconnectSpy;

      backgroundMessenger.shutdown();

      expect(disconnectSpy).toHaveBeenCalled();
      expect(mockBackgroundPort.onMessage.removeListener).toHaveBeenCalled();
    });
  });
});