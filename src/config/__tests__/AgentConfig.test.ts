import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../../__test-utils__/chrome-storage-mock';
import { AgentConfig } from '@/config/AgentConfig';
import type { IProfileConfig, IConfigChangeEvent } from '@/config/types';

// Mock CredentialStore (not initialized in tests)
vi.mock('@/core/storage/CredentialStore', () => ({
  isCredentialStoreInitialized: vi.fn(() => false),
  getCredentialStore: vi.fn(() => null),
}));

// Force ConfigStorageProvider to not-initialized so ConfigStorage falls back to chrome.storage.local
vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => false),
  getConfigStorage: vi.fn(() => {
    throw new Error('Not initialized');
  }),
}));

describe('AgentConfig', () => {
  let config: AgentConfig;

  beforeEach(async () => {
    // Reset singleton between tests
    (AgentConfig as any).instance = null;
    await chrome.storage.local.clear();
  });

  afterEach(() => {
    (AgentConfig as any).instance = null;
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance when called multiple times', async () => {
      const config1 = await AgentConfig.getInstance();
      const config2 = await AgentConfig.getInstance();
      expect(config1).toBe(config2);
    });

    it('should be an instance of AgentConfig', async () => {
      const instance = await AgentConfig.getInstance();
      expect(instance).toBeInstanceOf(AgentConfig);
    });

    it('should return different instances after resetting singleton', async () => {
      const config1 = await AgentConfig.getInstance();
      (AgentConfig as any).instance = null;
      const config2 = await AgentConfig.getInstance();
      expect(config1).not.toBe(config2);
    });
  });

  describe('Configuration Management', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should return default configuration after initialization', () => {
      const currentConfig = config.getConfig();
      expect(currentConfig).toBeDefined();
      expect(currentConfig.version).toBe('2.1.0');
      expect(currentConfig.selectedModelKey).toContain(':');
      expect(currentConfig.providers).toBeDefined();
      expect(currentConfig.preferences).toBeDefined();
      expect(currentConfig.cache).toBeDefined();
      expect(currentConfig.extension).toBeDefined();
    });

    it('should return a copy from getConfig, not the internal object', () => {
      const config1 = config.getConfig();
      const config2 = config.getConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });

    it('should update configuration values', () => {
      const currentConfig = config.getConfig();
      const updated = config.updateConfig({
        preferences: { ...currentConfig.preferences, theme: 'dark' },
      });
      expect(updated.preferences.theme).toBe('dark');
    });

    it('should throw ConfigValidationError on invalid version format', () => {
      expect(() => {
        config.updateConfig({ version: 'invalid' });
      }).toThrow();
    });

    it('should reset configuration to defaults', () => {
      const reset = config.resetConfig();
      expect(reset.version).toBe('2.1.0');
      expect(reset.preferences).toBeDefined();
    });

    it('should preserve API keys when resetting with preserveApiKeys=true', () => {
      // Get a provider and set a fake API key
      const providers = config.getProviders();
      const firstProviderId = Object.keys(providers)[0];
      if (firstProviderId) {
        const updatedProviders = { ...providers };
        updatedProviders[firstProviderId] = {
          ...updatedProviders[firstProviderId],
          apiKey: 'test-key-123',
        };
        config.updateConfig({ providers: updatedProviders });

        const reset = config.resetConfig(true);
        expect(reset.providers[firstProviderId].apiKey).toBe('test-key-123');
      }
    });

    it('should have a reload method', () => {
      expect(typeof config.reload).toBe('function');
    });
  });

  describe('Event System', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should notify handlers on model change via updateConfig', () => {
      const handler = vi.fn();
      config.on('config-changed', handler);

      const allModels = config.getAllModels();
      const currentKey = config.getConfig().selectedModelKey;
      const otherModel = allModels.find(
        m => `${m.providerId}:${m.model.modelKey}` !== currentKey
      );

      if (otherModel) {
        const newKey = `${otherModel.providerId}:${otherModel.model.modelKey}`;
        config.updateConfig({ selectedModelKey: newKey });

        expect(handler).toHaveBeenCalledTimes(1);
        const event: IConfigChangeEvent = handler.mock.calls[0][0];
        expect(event.type).toBe('config-changed');
        expect(event.section).toBe('model');
        expect(event.oldValue).toBe(currentKey);
        expect(event.newValue).toBe(newKey);
      }
    });

    it('should not notify handler after off()', () => {
      const handler = vi.fn();
      config.on('config-changed', handler);
      config.off('config-changed', handler);

      // updateConfig only emits when selectedModelKey changes
      const allModels = config.getAllModels();
      const currentKey = config.getConfig().selectedModelKey;
      const otherModel = allModels.find(
        m => `${m.providerId}:${m.model.modelKey}` !== currentKey
      );

      if (otherModel) {
        const newKey = `${otherModel.providerId}:${otherModel.model.modelKey}`;
        config.updateConfig({ selectedModelKey: newKey });
        expect(handler).not.toHaveBeenCalled();
      }
    });

    it('should notify handlers on profile creation', () => {
      const handler = vi.fn();
      config.on('config-changed', handler);

      config.createProfile({
        name: 'event-test',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      });

      expect(handler).toHaveBeenCalled();
      const event: IConfigChangeEvent = handler.mock.calls[0][0];
      expect(event.section).toBe('profile');
    });

    it('should notify handlers on provider change', () => {
      const handler = vi.fn();
      config.on('config-changed', handler);

      const providers = config.getProviders();
      const firstId = Object.keys(providers)[0];
      if (firstId) {
        config.updateProvider(firstId, { timeout: 45000 });
        expect(handler).toHaveBeenCalled();
        const event: IConfigChangeEvent = handler.mock.calls[0][0];
        expect(event.section).toBe('provider');
      }
    });
  });

  describe('Profile Management', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should start with empty profiles by default', () => {
      const profiles = config.getProfiles();
      expect(Object.keys(profiles).length).toBe(0);
    });

    it('should create a new profile', () => {
      const profile: IProfileConfig = {
        name: 'development',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      };

      const created = config.createProfile(profile);
      expect(created.name).toBe('development');

      const profiles = config.getProfiles();
      expect(profiles['development']).toBeDefined();
      expect(profiles['development'].model).toBe('gpt-4');
    });

    it('should throw when creating a duplicate profile', () => {
      const profile: IProfileConfig = {
        name: 'dup-test',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      };

      config.createProfile(profile);
      expect(() => config.createProfile(profile)).toThrow('Profile already exists');
    });

    it('should get a profile by name', () => {
      config.createProfile({
        name: 'get-test',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      });

      const retrieved = config.getProfile('get-test');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('get-test');
    });

    it('should return null for non-existent profile', () => {
      expect(config.getProfile('nonexistent')).toBeNull();
    });

    it('should update an existing profile', () => {
      config.createProfile({
        name: 'update-test',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      });

      const updated = config.updateProfile('update-test', { description: 'Updated description' });
      expect(updated.description).toBe('Updated description');
      expect(updated.name).toBe('update-test');
    });

    it('should throw when updating non-existent profile', () => {
      expect(() => config.updateProfile('nonexistent', {})).toThrow('Profile not found');
    });

    it('should delete a profile', () => {
      config.createProfile({
        name: 'delete-test',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      });

      config.deleteProfile('delete-test');
      expect(config.getProfile('delete-test')).toBeNull();
    });

    it('should not allow deleting the active profile', () => {
      config.createProfile({
        name: 'active-del-test',
        model: 'gpt-4',
        provider: 'openai',
        created: Date.now(),
      });

      config.activateProfile('active-del-test');
      expect(() => config.deleteProfile('active-del-test')).toThrow('Cannot delete active profile');
    });

    it('should activate a profile and update lastUsed', () => {
      const before = Date.now();
      config.createProfile({
        name: 'activate-test',
        model: 'gpt-4',
        provider: 'openai',
        created: before,
      });

      config.activateProfile('activate-test');

      expect(config.getConfig().activeProfile).toBe('activate-test');
      const profile = config.getProfile('activate-test');
      expect(profile!.lastUsed).toBeGreaterThanOrEqual(before);
    });

    it('should throw when activating non-existent profile', () => {
      expect(() => config.activateProfile('nonexistent')).toThrow('Profile not found');
    });
  });

  describe('Provider Management', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should return providers from default config', () => {
      const providers = config.getProviders();
      expect(Object.keys(providers).length).toBeGreaterThan(0);
    });

    it('should get a specific provider by id', () => {
      const providers = config.getProviders();
      const firstId = Object.keys(providers)[0];
      const provider = config.getProvider(firstId);
      expect(provider).not.toBeNull();
      expect(provider!.id).toBe(firstId);
      expect(provider!.name).toBeDefined();
    });

    it('should return null for non-existent provider', () => {
      expect(config.getProvider('nonexistent-provider')).toBeNull();
    });

    it('should get configured providers (with API keys)', () => {
      const configured = config.getConfiguredProviders();
      expect(Array.isArray(configured)).toBe(true);
    });

    it('should update a provider', () => {
      const providers = config.getProviders();
      const firstId = Object.keys(providers)[0];
      const updated = config.updateProvider(firstId, { timeout: 50000 });
      expect(updated.timeout).toBe(50000);
    });

    it('should throw when updating non-existent provider', () => {
      expect(() => config.updateProvider('nonexistent', {})).toThrow('Provider not found');
    });

    it('should not allow deleting provider hosting the selected model', () => {
      const selectedKey = config.getConfig().selectedModelKey;
      const providerId = selectedKey.split(':')[0];
      expect(() => config.deleteProvider(providerId)).toThrow(
        'Cannot delete provider that hosts the currently selected model'
      );
    });
  });

  describe('Model Operations', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should get current model configuration', () => {
      const modelConfig = config.getModelConfig();
      expect(modelConfig).toBeDefined();
      expect(modelConfig.modelKey).toBeDefined();
      expect(modelConfig.name).toBeDefined();
      expect(typeof modelConfig.contextWindow).toBe('number');
    });

    it('should get all models across providers', () => {
      const allModels = config.getAllModels();
      expect(allModels.length).toBeGreaterThan(0);

      for (const entry of allModels) {
        expect(entry).toHaveProperty('model');
        expect(entry).toHaveProperty('providerId');
        expect(entry).toHaveProperty('providerName');
        expect(entry.model.modelKey).toBeDefined();
      }
    });

    it('should get model by composite key', () => {
      const allModels = config.getAllModels();
      const first = allModels[0];
      const compositeKey = `${first.providerId}:${first.model.modelKey}`;

      const result = config.getModelByKey(compositeKey);
      expect(result).not.toBeNull();
      expect(result!.model.modelKey).toBe(first.model.modelKey);
      expect(result!.provider).toBeDefined();
    });

    it('should return null for invalid composite key formats', () => {
      expect(config.getModelByKey('no-colon')).toBeNull();
      expect(config.getModelByKey('')).toBeNull();
    });

    it('should return null for non-existent model key', () => {
      expect(config.getModelByKey('fake-provider:fake-model')).toBeNull();
    });

    it('should create composite model key via static method', () => {
      const key = AgentConfig.createModelKey('openai', 'gpt-5.1');
      expect(key).toBe('openai:gpt-5.1');
    });

    it('should set selected model via setSelectedModel', async () => {
      const allModels = config.getAllModels();
      if (allModels.length >= 2) {
        const currentKey = config.getConfig().selectedModelKey;
        const otherModel = allModels.find(
          m => `${m.providerId}:${m.model.modelKey}` !== currentKey
        );
        if (otherModel) {
          const newKey = `${otherModel.providerId}:${otherModel.model.modelKey}`;
          await config.setSelectedModel(newKey);
          expect(config.getConfig().selectedModelKey).toBe(newKey);
        }
      }
    });

    it('should throw on invalid model key format for setSelectedModel', async () => {
      await expect(config.setSelectedModel('no-colon')).rejects.toThrow('Invalid model key format');
    });

    it('should throw on non-existent model for setSelectedModel', async () => {
      await expect(config.setSelectedModel('fake:nonexistent')).rejects.toThrow('Model not found');
    });
  });

  describe('Tool Configuration', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should get tools configuration', () => {
      const tools = config.getToolsConfig();
      expect(tools).toBeDefined();
    });

    it('should update tools configuration', () => {
      const updated = config.updateToolsConfig({ timeout: 120000 });
      expect(updated.timeout).toBe(120000);
    });

    it('should get enabled tools list', () => {
      const enabled = config.getEnabledTools();
      expect(Array.isArray(enabled)).toBe(true);
    });

    it('should enable a tool', () => {
      config.enableTool('custom-test-tool');
      const enabled = config.getEnabledTools();
      expect(enabled).toContain('custom-test-tool');
    });

    it('should disable a tool', () => {
      config.enableTool('removable-tool');
      config.disableTool('removable-tool');
      const enabled = config.getEnabledTools();
      expect(enabled).not.toContain('removable-tool');
    });

    it('should get tool timeout', () => {
      const timeout = config.getToolTimeout();
      expect(typeof timeout).toBe('number');
      expect(timeout).toBeGreaterThan(0);
    });

    it('should get tool sandbox policy', () => {
      const policy = config.getToolSandboxPolicy();
      expect(policy).toBeDefined();
      expect(policy.mode).toBeDefined();
    });
  });

  describe('Import/Export', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should export configuration with metadata', () => {
      const exported = config.exportConfig();
      expect(exported.version).toBeDefined();
      expect(exported.exportDate).toBeGreaterThan(0);
      expect(exported.config).toBeDefined();
      expect(exported.config.providers).toBeDefined();
    });

    it('should redact API keys when exporting without includeApiKeys', () => {
      const exported = config.exportConfig(false);
      for (const provider of Object.values(exported.config.providers)) {
        expect(provider.apiKey).toBe('[REDACTED]');
      }
    });

    it('should include API keys when exporting with includeApiKeys=true', () => {
      // Set a fake key first
      const providers = config.getProviders();
      const firstId = Object.keys(providers)[0];
      if (firstId) {
        config.updateConfig({
          providers: {
            ...providers,
            [firstId]: { ...providers[firstId], apiKey: 'real-key' },
          },
        });

        const exported = config.exportConfig(true);
        expect(exported.config.providers[firstId].apiKey).toBe('real-key');
      }
    });

    it('should import valid configuration', () => {
      const exported = config.exportConfig(true);
      const imported = config.importConfig(exported);
      expect(imported.version).toBe(exported.config.version);
      expect(imported.selectedModelKey).toBe(exported.config.selectedModelKey);
    });
  });

  describe('Provider Key Detection', () => {
    beforeEach(async () => {
      config = await AgentConfig.getInstance();
    });

    it('should detect OpenAI keys', async () => {
      expect(await config.detectProviderFromKey('sk-proj-abc123')).toBe('openai');
    });

    it('should detect xAI keys', async () => {
      expect(await config.detectProviderFromKey('xai-abc123')).toBe('xai');
    });

    it('should detect Anthropic keys', async () => {
      expect(await config.detectProviderFromKey('sk-ant-abc123')).toBe('anthropic');
    });

    it('should detect Fireworks keys', async () => {
      expect(await config.detectProviderFromKey('fw-abc123')).toBe('fireworks');
    });

    it('should detect Google AI Studio keys', async () => {
      expect(await config.detectProviderFromKey('AIzaSyAbc123')).toBe('google-ai-studio');
    });

    it('should return unknown for unrecognized keys', async () => {
      expect(await config.detectProviderFromKey('unknown-format')).toBe('unknown');
    });

    it('should return unknown for empty string', async () => {
      expect(await config.detectProviderFromKey('')).toBe('unknown');
    });
  });
});
