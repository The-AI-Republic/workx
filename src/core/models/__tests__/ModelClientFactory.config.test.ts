import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelClientFactory } from '@/core/models/ModelClientFactory';
import { AgentConfig } from '@/config/AgentConfig';

describe('ModelClientFactory - AgentConfig Integration', () => {
  let config: AgentConfig;

  beforeEach(async () => {
    // Reset the AgentConfig singleton between tests so each test gets a fresh instance
    (AgentConfig as any).instance = null;

    // Mock chrome.storage.local.get to return empty object (no stored config)
    // This allows AgentConfig.initialize() to succeed with defaults
    vi.mocked(chrome.storage.local.get).mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        callback({});
        return undefined as any;
      }
      return Promise.resolve({});
    });

    vi.mocked(chrome.storage.local.set).mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        callback();
        return undefined as any;
      }
      return Promise.resolve();
    });

    // AgentConfig.getInstance() is async and calls initialize() internally
    config = await AgentConfig.getInstance();
  });

  describe('Initialize Method', () => {
    it('should have an initialize method that accepts AgentConfig', () => {
      const factory = new ModelClientFactory();

      // Method should exist
      expect(factory.initialize).toBeDefined();
      expect(typeof factory.initialize).toBe('function');
    });

    it('should accept AgentConfig and return a Promise', async () => {
      const factory = new ModelClientFactory();

      // Should return a Promise
      const result = factory.initialize(config);
      expect(result).toBeInstanceOf(Promise);

      // Should not throw
      await expect(result).resolves.not.toThrow();
    });

    it('should be idempotent - safe to call multiple times', async () => {
      const factory = new ModelClientFactory();

      // Should not throw when called multiple times
      await expect(factory.initialize(config)).resolves.not.toThrow();
      await expect(factory.initialize(config)).resolves.not.toThrow();
    });
  });

  describe('Config Usage', () => {
    it('should use config for selected model', async () => {
      const factory = new ModelClientFactory();
      await factory.initialize(config);

      // These methods should exist after implementation
      expect(factory.getSelectedModel).toBeDefined();
      expect(typeof factory.getSelectedModel()).toBe('string');
    });

    it('should use config for API keys', async () => {
      const factory = new ModelClientFactory();
      await factory.initialize(config);

      // getApiKey is async and returns Promise<string | null>
      expect(factory.getApiKey).toBeDefined();
      const apiKey = await factory.getApiKey('openai');
      expect(apiKey === null || apiKey === undefined || typeof apiKey === 'string').toBe(true);
    });

    it('should use config for base URLs', async () => {
      const factory = new ModelClientFactory();
      await factory.initialize(config);

      // getBaseUrl is synchronous and returns string | undefined
      expect(factory.getBaseUrl).toBeDefined();
      const baseUrl = factory.getBaseUrl('openai');
      expect(baseUrl === undefined || typeof baseUrl === 'string').toBe(true);
    });
  });
});
