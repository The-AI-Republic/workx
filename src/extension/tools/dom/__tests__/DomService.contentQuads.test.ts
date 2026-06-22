import { describe, it, expect, vi } from 'vitest';
import { DomService } from '../DomService';
import type { DebuggerClient } from '../../../../core/tools/browser/DebuggerClient';

/**
 * Unit tests for the `useContentQuads` click-targeting path (design §3.4 / T07):
 * viewport-relative quads, click the center of the quad∩viewport intersection,
 * scroll-and-retry when off-screen. The helpers are exercised directly to avoid
 * standing up a full snapshot.
 */

function mockClient(sendImpl: (method: string, params?: any) => any): DebuggerClient {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(true),
    sendCommand: vi.fn(sendImpl),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    enableDomain: vi.fn().mockResolvedValue(undefined),
    disableDomain: vi.fn().mockResolvedValue(undefined),
    getTargetInfo: vi.fn().mockReturnValue(null),
    getTabId: vi.fn().mockReturnValue(null),
  } as unknown as DebuggerClient;
}

async function makeService(key: string, send: (method: string, params?: any) => any): Promise<any> {
  const client = mockClient(send);
  return DomService.forClient(client, key, { useContentQuads: true });
}

describe('DomService getContentQuads targeting', () => {
  describe('pickVisibleQuadCenter', () => {
    it('returns the center of a fully-visible quad', async () => {
      const service = await makeService('cq-1', () => ({}));
      const point = service.pickVisibleQuadCenter(
        [[10, 20, 110, 20, 110, 70, 10, 70]],
        { width: 1000, height: 1000 }
      );
      expect(point).toEqual({ x: 60, y: 45 });
    });

    it('clips to the viewport center for a partially-scrolled element', async () => {
      const service = await makeService('cq-2', () => ({}));
      // Quad spans y = -40..60; viewport height 100 → visible band 0..60 → center y 30.
      const point = service.pickVisibleQuadCenter(
        [[0, -40, 100, -40, 100, 60, 0, 60]],
        { width: 1000, height: 100 }
      );
      expect(point).toEqual({ x: 50, y: 30 });
    });

    it('returns null when no quad intersects the viewport', async () => {
      const service = await makeService('cq-3', () => ({}));
      const point = service.pickVisibleQuadCenter(
        [[2000, 2000, 2100, 2000, 2100, 2100, 2000, 2100]],
        { width: 1000, height: 1000 }
      );
      expect(point).toBeNull();
    });

    it('picks the largest visible quad', async () => {
      const service = await makeService('cq-4', () => ({}));
      const small = [0, 0, 10, 0, 10, 10, 0, 10]; // area 100
      const large = [0, 0, 100, 0, 100, 100, 0, 100]; // area 10000
      const point = service.pickVisibleQuadCenter([small, large], { width: 1000, height: 1000 });
      expect(point).toEqual({ x: 50, y: 50 });
    });
  });

  describe('resolveClickPointViaContentQuads', () => {
    it('uses getContentQuads + viewport intersection (no scroll offsets)', async () => {
      const service = await makeService('cq-5', (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: { width: 800, height: 600 } } };
        if (method === 'DOM.getContentQuads') return { quads: [[100, 100, 200, 100, 200, 150, 100, 150]] };
        return {};
      });
      const point = await service.resolveClickPointViaContentQuads(42);
      expect(point).toEqual({ x: 150, y: 125 });
    });

    it('scrolls into view and retries when the element is off-screen', async () => {
      let quadCall = 0;
      const send = vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') return { result: { value: { width: 800, height: 600 } } };
        if (method === 'DOM.getContentQuads') {
          quadCall++;
          return quadCall === 1
            ? { quads: [[100, 2000, 200, 2000, 200, 2050, 100, 2050]] } // off-screen
            : { quads: [[100, 100, 200, 100, 200, 150, 100, 150]] }; // after scroll
        }
        return {};
      });
      const service = await makeService('cq-6', send as any);
      const point = await service.resolveClickPointViaContentQuads(42);
      expect(send).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', { backendNodeId: 42 });
      expect(point).toEqual({ x: 150, y: 125 });
    });

    it('throws ELEMENT_NOT_VISIBLE when there are no quads', async () => {
      const service = await makeService('cq-7', (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: { width: 800, height: 600 } } };
        if (method === 'DOM.getContentQuads') return { quads: [] };
        return {};
      });
      await expect(service.resolveClickPointViaContentQuads(42)).rejects.toThrow('ELEMENT_NOT_VISIBLE');
    });
  });
});
