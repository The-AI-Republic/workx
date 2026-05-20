/**
 * Memory Service Handlers
 *
 * Path-free UI access to the active session's MemoryService.
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface MemoryServiceDeps {
  registry: {
    getSession(sessionId: string): any;
    listSessions(): Array<{ sessionId: string; state?: string }>;
  };
}

function resolveMemoryService(deps: MemoryServiceDeps, sessionId?: string): any | null {
  const sessionIds = sessionId
    ? [sessionId]
    : deps.registry
        .listSessions()
        .filter(s => s.state !== 'terminated')
        .map(s => s.sessionId);

  for (const id of sessionIds) {
    const agent = deps.registry.getSession(id)?.agent;
    const service = agent?.getSession?.()?.getMemoryService?.();
    if (service) return service;
  }

  return null;
}

export function createMemoryServices(deps: MemoryServiceDeps): Record<string, ServiceHandler> {
  return {
    'memory.getSnapshot': async (params) => {
      const service = resolveMemoryService(deps, (params ?? {}).sessionId as string | undefined);
      if (!service) {
        return { available: false, enabled: false };
      }

      const snapshot = await service.getSnapshot({
        days: typeof params?.days === 'number' ? params.days : undefined,
        entriesPerDay: typeof params?.entriesPerDay === 'number' ? params.entriesPerDay : undefined,
      });
      return { available: true, ...snapshot };
    },

    'memory.clearAll': async (params) => {
      if ((params ?? {}).confirm !== true) {
        throw new Error('confirm=true is required to clear memory');
      }

      const service = resolveMemoryService(deps, (params ?? {}).sessionId as string | undefined);
      if (!service) {
        return { available: false, cleared: false };
      }

      const result = await service.clearAll();
      return { available: true, cleared: true, ...result };
    },
  };
}
