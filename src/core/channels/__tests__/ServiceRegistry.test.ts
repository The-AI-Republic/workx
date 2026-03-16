import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceRegistry } from '../ServiceRegistry';
import type { SubmissionContext } from '../types';

function makeContext(): SubmissionContext {
  return {
    channelId: 'test-channel',
    channelType: 'sidepanel',
  } as SubmissionContext;
}

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  describe('register + handle', () => {
    it('registers and handles a service successfully', async () => {
      const handler = vi.fn().mockResolvedValue({ servers: [] });
      registry.register('mcp.getServers', handler);

      const result = await registry.handle('mcp.getServers', {}, makeContext());

      expect(result).toEqual({ servers: [] });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('returns the handler result', async () => {
      registry.register('vault.status', async () => ({ locked: false }));

      const result = await registry.handle('vault.status', {}, makeContext());

      expect(result).toEqual({ locked: false });
    });

    it('passes params and context to the handler', async () => {
      const handler = vi.fn().mockResolvedValue('ok');
      registry.register('storage.get', handler);

      const params = { key: 'theme' };
      const ctx = makeContext();
      await registry.handle('storage.get', params, ctx);

      expect(handler).toHaveBeenCalledWith(params, ctx);
    });
  });

  describe('handle errors', () => {
    it('throws for an unregistered service', async () => {
      await expect(
        registry.handle('nonexistent.service', {}, makeContext())
      ).rejects.toThrow('Unknown service: nonexistent.service');
    });

    it('propagates handler errors', async () => {
      registry.register('failing.service', async () => {
        throw new Error('handler failed');
      });

      await expect(
        registry.handle('failing.service', {}, makeContext())
      ).rejects.toThrow('handler failed');
    });
  });

  describe('unregister', () => {
    it('removes a registered handler', async () => {
      registry.register('temp.service', async () => 'value');
      registry.unregister('temp.service');

      expect(registry.has('temp.service')).toBe(false);
      await expect(
        registry.handle('temp.service', {}, makeContext())
      ).rejects.toThrow('Unknown service: temp.service');
    });

    it('does not throw when unregistering a non-existent service', () => {
      expect(() => registry.unregister('no.such')).not.toThrow();
    });
  });

  describe('has', () => {
    it('returns true for registered services', () => {
      registry.register('a.b', async () => null);
      expect(registry.has('a.b')).toBe(true);
    });

    it('returns false for unregistered services', () => {
      expect(registry.has('x.y')).toBe(false);
    });
  });

  describe('listServices', () => {
    it('returns all registered service paths', () => {
      registry.register('mcp.getServers', async () => null);
      registry.register('vault.status', async () => null);
      registry.register('skills.list', async () => null);

      const services = registry.listServices();

      expect(services).toHaveLength(3);
      expect(services).toContain('mcp.getServers');
      expect(services).toContain('vault.status');
      expect(services).toContain('skills.list');
    });

    it('returns empty array when no services registered', () => {
      expect(registry.listServices()).toEqual([]);
    });
  });
});
