import { describe, expect, it, vi } from 'vitest';
import { createMemoryServices } from '../memory-services';
import type { SubmissionContext } from '@/core/channels/types';

const ctx = { channelId: 'test', channelType: 'sidepanel' } as SubmissionContext;

function createDeps(memoryService: any = null) {
  return {
    registry: {
      getSession: vi.fn((id: string) => (
        id === 's1'
          ? {
              agent: {
                getSession: () => ({
                  getMemoryService: () => memoryService,
                }),
              },
            }
          : undefined
      )),
      listSessions: vi.fn(() => [{ sessionId: 's1', state: 'active' }]),
    },
  };
}

describe('createMemoryServices', () => {
  it('returns unavailable when no active session has a memory service', async () => {
    const services = createMemoryServices(createDeps(null));

    await expect(services['memory.getSnapshot']({}, ctx)).resolves.toEqual({
      available: false,
      enabled: false,
    });
  });

  it('returns a memory snapshot from the active session service', async () => {
    const memoryService = {
      getSnapshot: vi.fn().mockResolvedValue({
        enabled: true,
        coreMemory: 'core',
        dailyFiles: [],
        dailyEntryCount: 0,
      }),
    };
    const services = createMemoryServices(createDeps(memoryService));

    const result = await services['memory.getSnapshot']({ days: 2, entriesPerDay: 5 }, ctx);

    expect(memoryService.getSnapshot).toHaveBeenCalledWith({ days: 2, entriesPerDay: 5 });
    expect(result).toMatchObject({ available: true, enabled: true, coreMemory: 'core' });
  });

  it('requires explicit confirmation before clearing memory', async () => {
    const memoryService = { clearAll: vi.fn() };
    const services = createMemoryServices(createDeps(memoryService));

    await expect(services['memory.clearAll']({}, ctx)).rejects.toThrow(
      'confirm=true is required to clear memory',
    );
    expect(memoryService.clearAll).not.toHaveBeenCalled();
  });

  it('clears memory on the active session service', async () => {
    const memoryService = {
      clearAll: vi.fn().mockResolvedValue({ coreCleared: true, dailyEntriesCleared: 2 }),
    };
    const services = createMemoryServices(createDeps(memoryService));

    const result = await services['memory.clearAll']({ confirm: true }, ctx);

    expect(memoryService.clearAll).toHaveBeenCalled();
    expect(result).toEqual({
      available: true,
      cleared: true,
      coreCleared: true,
      dailyEntriesCleared: 2,
    });
  });
});
