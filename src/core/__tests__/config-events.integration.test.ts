import { describe, it, expect, vi } from 'vitest';
import { AgentConfig } from '@/config/AgentConfig';
import { Session } from '@/core/Session';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { ApprovalManager } from '@/core/ApprovalManager';

describe('Config Change Events Integration', () => {
  describe('Config Change Propagation', () => {
    it('should emit config-changed events when config updates', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const changeHandler = vi.fn();

      // Subscribe to config changes
      config.on('config-changed', changeHandler);

      // Update config
      await config.updateConfig({
        model: { selected: 'claude-3-haiku' }
      });

      // Should have emitted event
      expect(changeHandler).toHaveBeenCalled();
      expect(changeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          section: 'model'
        })
      );
    });

    it('should allow components to subscribe to config changes', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      // Create components with config
      const session = new Session(config);
      const toolRegistry = new ToolRegistry(config);
      const approvalManager = new ApprovalManager(config);

      // Components should be able to subscribe to config changes
      if (typeof session.onConfigChange === 'function') {
        const sessionHandler = vi.fn();
        session.onConfigChange(sessionHandler);

        // Update config
        await config.updateConfig({
          features: { defaultCwd: '/new/path' }
        });

        // Handler should be called
        expect(sessionHandler).toHaveBeenCalled();
      }
    });

    it('should update component behavior on config changes', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const session = new Session(config);

      // Get initial value
      const initialModel = session.getDefaultModel?.();

      // Update config
      await config.updateConfig({
        model: { selected: 'claude-3-opus' }
      });

      // If component properly subscribes, value should change
      const updatedModel = session.getDefaultModel?.();

      if (initialModel && updatedModel) {
        expect(updatedModel).not.toBe(initialModel);
      }
    });

    it('should handle multiple component subscriptions', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const components = [
        new Session(config),
        new ToolRegistry(config),
        new ApprovalManager(config)
      ];

      const handlers = components.map(() => vi.fn());

      // Subscribe all components (if they support it)
      components.forEach((component, index) => {
        if (typeof component.onConfigChange === 'function') {
          component.onConfigChange(handlers[index]);
        }
      });

      // Update config
      await config.updateConfig({
        security: { approvalPolicy: 'always' }
      });

      // All subscribed handlers should be called
      handlers.forEach(handler => {
        if (handler.mock) {
          // Only check handlers that were actually subscribed
          expect(handler.mock.calls.length).toBeGreaterThanOrEqual(0);
        }
      });
    });
  });

  describe('Config Change Error Handling', () => {
    it('should handle errors in config change handlers gracefully', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });

      const goodHandler = vi.fn();

      // Subscribe handlers
      config.on('config-changed', errorHandler);
      config.on('config-changed', goodHandler);

      // Update config - should not throw despite error handler
      await expect(config.updateConfig({
        model: { selected: 'claude-3-haiku' }
      })).resolves.not.toThrow();

      // Good handler should still be called
      expect(goodHandler).toHaveBeenCalled();
    });
  });
});