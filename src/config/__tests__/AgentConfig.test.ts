import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// These imports will initially fail because the implementations don't exist yet
import { AgentConfig } from '@/config/AgentConfig';
import type { AgentConfigData, ConfigProfile } from '@/config/types';

describe('AgentConfig', () => {
  let config: AgentConfig;

  beforeEach(() => {
    // Clear any existing singleton instance
    AgentConfig.resetInstance?.();
  });

  afterEach(() => {
    // Clean up after each test
    AgentConfig.resetInstance?.();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance when called multiple times', () => {
      const config1 = AgentConfig.getInstance();
      const config2 = AgentConfig.getInstance();

      expect(config1).toBe(config2);
      expect(config1).toBeInstanceOf(AgentConfig);
    });

    it('should not allow direct instantiation', () => {
      expect(() => new AgentConfig()).toThrow('Use AgentConfig.getInstance()');
    });

    it('should provide resetInstance method for testing', () => {
      const config1 = AgentConfig.getInstance();
      AgentConfig.resetInstance();
      const config2 = AgentConfig.getInstance();

      expect(config1).not.toBe(config2);
    });
  });

  describe('Configuration Management', () => {
    beforeEach(() => {
      config = AgentConfig.getInstance();
    });

    it('should initialize with default configuration', async () => {
      await config.initialize();

      const currentConfig = config.getConfig();
      expect(currentConfig).toBeDefined();
      expect(currentConfig.model).toBe('claude-3-5-sonnet-20241022');
      expect(currentConfig.approval_policy).toBe('on-request');
      expect(currentConfig.sandbox_policy.mode).toBe('read-only');
    });

    it('should update configuration values', async () => {
      await config.initialize();

      await config.updateConfig({
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      });

      const currentConfig = config.getConfig();
      expect(currentConfig.model).toBe('claude-3-haiku-20240307');
      expect(currentConfig.approval_policy).toBe('never');
    });

    it('should validate configuration before updating', async () => {
      await config.initialize();

      await expect(
        config.updateConfig({ model: 'invalid-model' })
      ).rejects.toThrow('Invalid model');
    });

    it('should persist configuration changes to storage', async () => {
      await config.initialize();

      const updateSpy = vi.spyOn(config, 'updateConfig');

      await config.updateConfig({ model: 'claude-3-opus-20240229' });

      expect(updateSpy).toHaveBeenCalled();
      // Storage persistence will be tested separately
    });
  });

  describe('Event System', () => {
    beforeEach(async () => {
      config = AgentConfig.getInstance();
      await config.initialize();
    });

    it('should allow subscribing to configuration changes', () => {
      const callback = vi.fn();

      config.subscribe(callback);

      expect(config.getSubscribers()).toContain(callback);
    });

    it('should notify subscribers when configuration changes', async () => {
      const callback = vi.fn();
      config.subscribe(callback);

      const newConfig = { model: 'claude-3-haiku-20240307' };
      await config.updateConfig(newConfig);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining(newConfig),
        expect.any(Object) // previous config
      );
    });

    it('should allow unsubscribing from configuration changes', () => {
      const callback = vi.fn();

      config.subscribe(callback);
      expect(config.getSubscribers()).toContain(callback);

      config.unsubscribe(callback);
      expect(config.getSubscribers()).not.toContain(callback);
    });

    it('should not notify unsubscribed callbacks', async () => {
      const callback = vi.fn();

      config.subscribe(callback);
      config.unsubscribe(callback);

      await config.updateConfig({ model: 'claude-3-haiku-20240307' });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Profile Management', () => {
    beforeEach(async () => {
      config = AgentConfig.getInstance();
      await config.initialize();
    });

    it('should start with default profile', () => {
      const activeProfile = config.getActiveProfile();
      expect(activeProfile).toBe('default');
    });

    it('should create new configuration profiles', async () => {
      const profileConfig: Partial<AgentConfigData> = {
        model: 'claude-3-opus-20240229',
        approval_policy: 'never'
      };

      await config.createProfile('development', profileConfig);

      const profiles = config.getProfiles();
      expect(profiles).toHaveProperty('development');
    });

    it('should switch between configuration profiles', async () => {
      const devConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      };

      await config.createProfile('development', devConfig);
      await config.switchProfile('development');

      expect(config.getActiveProfile()).toBe('development');
      expect(config.getConfig().model).toBe('claude-3-haiku-20240307');
    });

    it('should delete configuration profiles', async () => {
      await config.createProfile('temp', { model: 'claude-3-haiku-20240307' });
      expect(config.getProfiles()).toHaveProperty('temp');

      await config.deleteProfile('temp');
      expect(config.getProfiles()).not.toHaveProperty('temp');
    });

    it('should not allow deleting the default profile', async () => {
      await expect(config.deleteProfile('default')).rejects.toThrow('Cannot delete default profile');
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      config = AgentConfig.getInstance();
      await config.initialize();
    });

    it('should handle storage errors gracefully', async () => {
      // Mock storage failure
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // This should not throw, but log error and continue with defaults
      await config.updateConfig({ model: 'claude-3-haiku-20240307' });

      consoleSpy.mockRestore();
    });

    it('should validate profile names', async () => {
      await expect(config.createProfile('', {})).rejects.toThrow('Invalid profile name');
      await expect(config.createProfile('invalid/name', {})).rejects.toThrow('Invalid profile name');
    });

    it('should handle switching to non-existent profile', async () => {
      await expect(config.switchProfile('non-existent')).rejects.toThrow('Profile not found');
    });
  });

  describe('Context Isolation', () => {
    beforeEach(async () => {
      config = AgentConfig.getInstance();
      await config.initialize();
    });

    it('should maintain separate instances for different contexts', () => {
      // This will be important for background/content/sidepanel contexts
      const backgroundInstance = AgentConfig.getInstance('background');
      const contentInstance = AgentConfig.getInstance('content');

      expect(backgroundInstance).not.toBe(contentInstance);
    });

    it('should sync configuration across contexts via messaging', async () => {
      const backgroundInstance = AgentConfig.getInstance('background');
      const contentInstance = AgentConfig.getInstance('content');

      await backgroundInstance.initialize();
      await contentInstance.initialize();

      await backgroundInstance.updateConfig({ model: 'claude-3-haiku-20240307' });

      // Should eventually sync to content instance
      // This will require implementing message passing
      expect(contentInstance.getConfig().model).toBe('claude-3-haiku-20240307');
    });
  });
});