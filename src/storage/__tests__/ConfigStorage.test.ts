import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// These imports will initially fail because the implementations don't exist yet
import { ConfigStorage } from '@/storage/ConfigStorage';
import type { AgentConfigData, ConfigProfile } from '@/config/types';

// Mock Chrome storage API
const mockStorageLocal = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  onChanged: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn()
  }
};

const mockStorageSync = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  onChanged: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn()
  }
};

// @ts-ignore - Mock Chrome API
global.chrome = {
  storage: {
    local: mockStorageLocal,
    sync: mockStorageSync
  }
};

describe('ConfigStorage', () => {
  let storage: ConfigStorage;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    storage = new ConfigStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Configuration Persistence', () => {
    it('should save configuration to Chrome storage', async () => {
      const config: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' },
        cwd: '/workspace'
      };

      mockStorageSync.set.mockResolvedValue(undefined);

      await storage.saveConfig(config);

      expect(mockStorageSync.set).toHaveBeenCalledWith({
        'browserx-agent-config': config
      });
    });

    it('should load configuration from Chrome storage', async () => {
      const expectedConfig: AgentConfigData = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never',
        sandbox_policy: { mode: 'workspace-write', network_access: true }
      };

      mockStorageSync.get.mockResolvedValue({
        'browserx-agent-config': expectedConfig
      });

      const config = await storage.loadConfig();

      expect(mockStorageSync.get).toHaveBeenCalledWith('browserx-agent-config');
      expect(config).toEqual(expectedConfig);
    });

    it('should return default configuration when none exists', async () => {
      mockStorageSync.get.mockResolvedValue({});

      const config = await storage.loadConfig();

      expect(config).toEqual(storage.getDefaultConfig());
    });

    it('should handle Chrome storage errors gracefully', async () => {
      const storageError = new Error('Chrome storage unavailable');
      mockStorageSync.get.mockRejectedValue(storageError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = await storage.loadConfig();

      expect(config).toEqual(storage.getDefaultConfig());
      expect(consoleSpy).toHaveBeenCalledWith('Failed to load config from storage:', storageError);

      consoleSpy.mockRestore();
    });

    it('should validate loaded configuration', async () => {
      const invalidConfig = {
        model: 'invalid-model',
        approval_policy: 'invalid-policy'
      };

      mockStorageSync.get.mockResolvedValue({
        'browserx-agent-config': invalidConfig
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config = await storage.loadConfig();

      expect(config).toEqual(storage.getDefaultConfig());
      expect(consoleSpy).toHaveBeenCalledWith('Invalid config loaded from storage, using defaults');

      consoleSpy.mockRestore();
    });
  });

  describe('Profile Management', () => {
    it('should save configuration profiles', async () => {
      const profiles: Record<string, ConfigProfile> = {
        default: {
          name: 'default',
          config: {
            model: 'claude-3-5-sonnet-20241022',
            approval_policy: 'on-request',
            sandbox_policy: { mode: 'read-only' }
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        development: {
          name: 'development',
          config: {
            model: 'claude-3-haiku-20240307',
            approval_policy: 'never',
            sandbox_policy: { mode: 'workspace-write' }
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      };

      mockStorageLocal.set.mockResolvedValue(undefined);

      await storage.saveProfiles(profiles);

      expect(mockStorageLocal.set).toHaveBeenCalledWith({
        'browserx-config-profiles': profiles
      });
    });

    it('should load configuration profiles', async () => {
      const profiles: Record<string, ConfigProfile> = {
        default: {
          name: 'default',
          config: {
            model: 'claude-3-5-sonnet-20241022',
            approval_policy: 'on-request',
            sandbox_policy: { mode: 'read-only' }
          },
          createdAt: 1640995200000,
          updatedAt: 1640995200000
        }
      };

      mockStorageLocal.get.mockResolvedValue({
        'browserx-config-profiles': profiles
      });

      const loadedProfiles = await storage.loadProfiles();

      expect(mockStorageLocal.get).toHaveBeenCalledWith('browserx-config-profiles');
      expect(loadedProfiles).toEqual(profiles);
    });

    it('should return default profile when none exist', async () => {
      mockStorageLocal.get.mockResolvedValue({});

      const profiles = await storage.loadProfiles();

      expect(profiles).toHaveProperty('default');
      expect(profiles.default.name).toBe('default');
      expect(profiles.default.config).toEqual(storage.getDefaultConfig());
    });

    it('should save active profile selection', async () => {
      mockStorageLocal.set.mockResolvedValue(undefined);

      await storage.saveActiveProfile('development');

      expect(mockStorageLocal.set).toHaveBeenCalledWith({
        'browserx-active-profile': 'development'
      });
    });

    it('should load active profile selection', async () => {
      mockStorageLocal.get.mockResolvedValue({
        'browserx-active-profile': 'development'
      });

      const activeProfile = await storage.loadActiveProfile();

      expect(mockStorageLocal.get).toHaveBeenCalledWith('browserx-active-profile');
      expect(activeProfile).toBe('development');
    });

    it('should default to "default" profile when none selected', async () => {
      mockStorageLocal.get.mockResolvedValue({});

      const activeProfile = await storage.loadActiveProfile();

      expect(activeProfile).toBe('default');
    });
  });

  describe('Storage Events', () => {
    it('should listen for storage changes', () => {
      const callback = vi.fn();

      storage.onConfigChanged(callback);

      expect(mockStorageSync.onChanged.addListener).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('should notify callback when config changes', async () => {
      const callback = vi.fn();
      let storageListener: Function;

      mockStorageSync.onChanged.addListener.mockImplementation((listener) => {
        storageListener = listener;
      });

      storage.onConfigChanged(callback);

      // Simulate storage change
      const changes = {
        'browserx-agent-config': {
          newValue: {
            model: 'claude-3-haiku-20240307',
            approval_policy: 'never'
          },
          oldValue: {
            model: 'claude-3-5-sonnet-20241022',
            approval_policy: 'on-request'
          }
        }
      };

      storageListener!(changes, 'sync');

      expect(callback).toHaveBeenCalledWith(changes['browserx-agent-config'].newValue);
    });

    it('should not notify for non-config storage changes', async () => {
      const callback = vi.fn();
      let storageListener: Function;

      mockStorageSync.onChanged.addListener.mockImplementation((listener) => {
        storageListener = listener;
      });

      storage.onConfigChanged(callback);

      // Simulate non-config storage change
      const changes = {
        'some-other-key': {
          newValue: 'new-value',
          oldValue: 'old-value'
        }
      };

      storageListener!(changes, 'sync');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should remove storage change listener', () => {
      const callback = vi.fn();

      storage.onConfigChanged(callback);
      storage.removeConfigListener(callback);

      expect(mockStorageSync.onChanged.removeListener).toHaveBeenCalled();
    });
  });

  describe('Storage Quota and Limits', () => {
    it('should handle storage quota exceeded errors', async () => {
      const config: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' }
      };

      const quotaError = new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      mockStorageSync.set.mockRejectedValue(quotaError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(storage.saveConfig(config)).rejects.toThrow('QUOTA_BYTES_PER_ITEM quota exceeded');

      consoleSpy.mockRestore();
    });

    it('should calculate storage usage', async () => {
      const config: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' }
      };

      const storageSize = await storage.getStorageSize(config);

      expect(typeof storageSize).toBe('number');
      expect(storageSize).toBeGreaterThan(0);
    });

    it('should warn when approaching storage limits', async () => {
      const largeConfig = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' },
        // Add large data to simulate approaching limits
        largeData: 'x'.repeat(7000) // Chrome sync storage has 8KB item limit
      };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await storage.saveConfig(largeConfig as any);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Config size approaching storage limit')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Migration and Compatibility', () => {
    it('should migrate old config format', async () => {
      const oldConfig = {
        // Old format without proper typing
        model: 'claude-3-5-sonnet-20241022',
        approvalPolicy: 'on-request', // Old camelCase
        sandboxMode: 'read-only' // Old simplified format
      };

      mockStorageSync.get.mockResolvedValue({
        'browserx-agent-config': oldConfig
      });

      const config = await storage.loadConfig();

      expect(config).toEqual({
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' }
      });
    });

    it('should handle version compatibility', async () => {
      const configWithVersion = {
        version: '1.0.0',
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' }
      };

      mockStorageSync.get.mockResolvedValue({
        'browserx-agent-config': configWithVersion
      });

      const config = await storage.loadConfig();

      expect(config.version).toBe('1.0.0');
    });

    it('should clear corrupted storage data', async () => {
      const corruptedData = 'invalid-json-string';

      mockStorageSync.get.mockResolvedValue({
        'browserx-agent-config': corruptedData
      });

      mockStorageSync.remove.mockResolvedValue(undefined);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = await storage.loadConfig();

      expect(config).toEqual(storage.getDefaultConfig());
      expect(mockStorageSync.remove).toHaveBeenCalledWith('browserx-agent-config');

      consoleSpy.mockRestore();
    });
  });
});