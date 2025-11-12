import { describe, it, expect } from 'vitest';
import { ModelClientFactory } from '../../src/models/ModelClientFactory';
import { AgentConfig } from '../../src/config/AgentConfig';

describe('ModelClientFactory - AgentConfig Integration', () => {
  describe('Initialize Method', () => {
    it('should have an initialize method that accepts AgentConfig', () => {
      const factory = new ModelClientFactory();

      // Method should exist
      expect(factory.initialize).toBeDefined();
      expect(typeof factory.initialize).toBe('function');
    });

    it('should accept AgentConfig and return a Promise', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const factory = new ModelClientFactory();

      // Should return a Promise
      const result = factory.initialize(config);
      expect(result).toBeInstanceOf(Promise);

      // Should not throw
      await expect(result).resolves.not.toThrow();
    });

    it('should be idempotent - safe to call multiple times', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const factory = new ModelClientFactory();

      // Should not throw when called multiple times
      await expect(factory.initialize(config)).resolves.not.toThrow();
      await expect(factory.initialize(config)).resolves.not.toThrow();
    });
  });

  describe('Config Usage', () => {
    it('should use config for selected model', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const factory = new ModelClientFactory();
      await factory.initialize(config);

      // These methods should exist after implementation
      expect(factory.getSelectedModel).toBeDefined();
      expect(typeof factory.getSelectedModel()).toBe('string');
    });

    it('should use config for API keys', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const factory = new ModelClientFactory();
      await factory.initialize(config);

      // These methods should exist after implementation
      expect(factory.getApiKey).toBeDefined();
      const apiKey = factory.getApiKey('openai');
      expect(apiKey === undefined || typeof apiKey === 'string').toBe(true);
    });

    it('should use config for base URLs', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const factory = new ModelClientFactory();
      await factory.initialize(config);

      // These methods should exist after implementation
      expect(factory.getBaseUrl).toBeDefined();
      const baseUrl = factory.getBaseUrl('openai');
      expect(baseUrl === undefined || typeof baseUrl === 'string').toBe(true);
    });
  });
});