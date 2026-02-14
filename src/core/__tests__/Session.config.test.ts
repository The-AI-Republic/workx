import { describe, it, expect } from 'vitest';
import { Session } from '@/core/Session';
import { AgentConfig } from '@/config/AgentConfig';

describe('Session - AgentConfig Integration', () => {
  describe('Constructor', () => {
    it('should accept optional AgentConfig parameter as first argument', () => {
      const config = AgentConfig.getInstance();

      // This should not throw
      expect(() => new Session(config)).not.toThrow();
      expect(() => new Session(config, true)).not.toThrow();
      expect(() => new Session(config, false)).not.toThrow();
    });

    it('should work without config (backward compatibility)', () => {
      expect(() => new Session()).not.toThrow();
      expect(() => new Session(undefined, true)).not.toThrow();
      expect(() => new Session(undefined, false)).not.toThrow();
    });

    it('should store config reference when provided', () => {
      const config = AgentConfig.getInstance();
      const session = new Session(config);

      // @ts-expect-error - accessing private property for testing
      expect(session.config).toBe(config);
    });
  });

  describe('Config Usage', () => {
    it('should use config for default model', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const session = new Session(config);

      // These methods should exist after implementation
      expect(session.getDefaultModel).toBeDefined();
      expect(typeof session.getDefaultModel()).toBe('string');
    });

    it('should use config for default cwd', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const session = new Session(config);

      // These methods should exist after implementation
      expect(session.getDefaultCwd).toBeDefined();
      expect(typeof session.getDefaultCwd()).toBe('string');
    });

    it('should use config for storage enabled', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const session = new Session(config);

      // These methods should exist after implementation
      expect(session.isStorageEnabled).toBeDefined();
      expect(typeof session.isStorageEnabled()).toBe('boolean');
    });
  });
});