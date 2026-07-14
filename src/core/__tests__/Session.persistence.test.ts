/**
 * Track-09 fixes — Session-level integration tests.
 *
 *   - H1: Session.close() must NOT cleanup the tool-result store for a
 *         persistent session (resume needs those files / cache entries).
 *   - M2: Resume must not crash on a malformed `content_replacement` rollout
 *         record — it should warn and skip.
 *
 * Uses a per-file module mock of `@/tools/resultStore` so we can swap a stub
 * store in via `createToolResultStore`. Kept separate from the main
 * Session.test.ts to avoid contaminating other tests' module graph.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResponseItem } from '@/core/protocol/types';
import type { RolloutItem } from '@/storage/rollout/types';

// Mock RolloutRecorder so the constructor never touches disk.
vi.mock('@/storage/rollout', () => ({
  RolloutRecorder: {
    create: vi.fn().mockResolvedValue({
      recordItems: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    }),
    getRolloutHistory: vi.fn().mockResolvedValue({
      type: 'resumed',
      payload: { history: [] },
    }),
  },
}));

vi.mock('uuid', () => ({ v4: () => 'fixed-session-id' }));

vi.mock('@/core/title', () => ({
  TitleGenerator: vi.fn().mockImplementation(() => ({
    countUserMessages: vi.fn().mockReturnValue(0),
    extractUserMessages: vi.fn().mockReturnValue([]),
    generateTitle: vi.fn().mockResolvedValue({ success: false }),
  })),
}));

// Stub store hoisted up so the module mock can return it.
const stubStore = {
  persist: vi.fn(),
  retrieve: vi.fn(),
  cleanup: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/tools/resultStore', async (importOriginal) => {
  // Keep the real types/exports (PersistedResult, etc.) — just replace the factory.
  const actual = await importOriginal<typeof import('@/tools/resultStore')>();
  return {
    ...actual,
    createToolResultStore: vi.fn(() => stubStore),
  };
});

// Imports MUST come after vi.mock declarations so the mocked module is used.
import { Session } from '@/core/Session';

describe('Session — track 09 persistence interactions', () => {
  beforeEach(() => {
    stubStore.persist.mockReset();
    stubStore.retrieve.mockReset();
    stubStore.cleanup.mockReset().mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // H1 — close() cleanup gating by isPersistent
  // -------------------------------------------------------------------------

  it('H1: close() does NOT cleanup the tool-result store when isPersistent=true', async () => {
    // Persistent session.
    const session = new Session(undefined, true);
    // Sanity: the constructor wired the store.
    expect((session as any).toolResultStore).toBe(stubStore);

    await session.close();
    expect(stubStore.cleanup).not.toHaveBeenCalled();
  });

  it('H1: close() DOES cleanup the tool-result store when isPersistent=false', async () => {
    const session = new Session(undefined, false);
    expect((session as any).toolResultStore).toBe(stubStore);

    await session.close();
    expect(stubStore.cleanup).toHaveBeenCalledTimes(1);
    expect(stubStore.cleanup).toHaveBeenCalledWith(session.sessionId);
  });

  it('H1: close() tolerates a cleanup error on non-persistent session (logs but does not throw)', async () => {
    stubStore.cleanup.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = new Session(undefined, false);
    await expect(session.close()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // M2 — resume must not crash on malformed content_replacement
  // -------------------------------------------------------------------------

  it('M2: resume skips a malformed content_replacement payload and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const malformed: RolloutItem[] = [
      // Well-formed neighbour — must still be processed.
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'ok-call',
          output: '<persisted-output>preview</persisted-output>',
        } as ResponseItem,
      },
      // Missing toolUseId entirely.
      { type: 'content_replacement', payload: { kind: 'tool-result' } as any },
      // toolUseId is the wrong type.
      {
        type: 'content_replacement',
        payload: { kind: 'tool-result', toolUseId: 123, replacement: 'x' } as any,
      },
      // Replacement is missing.
      {
        type: 'content_replacement',
        payload: { kind: 'tool-result', toolUseId: 'no-repl' } as any,
      },
      // Null payload.
      { type: 'content_replacement', payload: null as any },
    ];

    const session = new Session(undefined, false);

    expect(() => (session as any).reconstructHistoryFromRollout(malformed)).not.toThrow();

    // The well-formed response_item should still have frozen its call_id.
    const state = session.getContentReplacementState();
    expect(state?.seenIds.has('ok-call')).toBe(true);
    // No malformed payload should have leaked into replacements.
    expect(state?.replacements.size ?? 0).toBe(0);

    // At least one warning was emitted (one per malformed payload).
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    warnSpy.mockRestore();
  });

  it('M2: resume still seeds a well-formed content_replacement record', () => {
    const items: RolloutItem[] = [
      {
        type: 'content_replacement',
        payload: {
          kind: 'tool-result',
          toolUseId: 'call_xyz',
          replacement: '<persisted-output>seeded</persisted-output>',
        },
      },
    ];
    const session = new Session(undefined, false);
    (session as any).reconstructHistoryFromRollout(items);
    const state = session.getContentReplacementState();
    expect(state?.seenIds.has('call_xyz')).toBe(true);
    expect(state?.replacements.get('call_xyz')).toBe(
      '<persisted-output>seeded</persisted-output>',
    );
  });
});

describe('Session — resumed agent mode rehydration (WORKXOS-11)', () => {
  it('rehydrates code mode from the persisted turn_context tag', () => {
    const items: RolloutItem[] = [
      { type: 'session_meta', payload: { id: 's', timestamp: 't', originator: 'desktop', cliVersion: '1', agentMode: 'code' } as any },
      { type: 'turn_context', payload: { model: 'm', summary: 'auto', approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write', agentMode: 'code' } as any },
    ];
    const session = new Session(undefined, false);
    (session as any).reconstructHistoryFromRollout(items);
    expect(session.getAgentMode()).toBe('code');
  });

  it('prefers the most recent turn_context mode over an earlier one (hot-switch)', () => {
    const items: RolloutItem[] = [
      { type: 'turn_context', payload: { agentMode: 'general' } as any },
      { type: 'turn_context', payload: { agentMode: 'code' } as any },
      { type: 'turn_context', payload: { agentMode: 'general' } as any },
    ];
    const session = new Session(undefined, false);
    (session as any).reconstructHistoryFromRollout(items);
    expect(session.getAgentMode()).toBe('general');
  });

  it('falls back to the session_meta tag when no turn_context carries a mode', () => {
    const items: RolloutItem[] = [
      { type: 'session_meta', payload: { id: 's', timestamp: 't', originator: 'desktop', cliVersion: '1', agentMode: 'code' } as any },
      { type: 'turn_context', payload: { model: 'm' } as any },
    ];
    const session = new Session(undefined, false);
    (session as any).reconstructHistoryFromRollout(items);
    expect(session.getAgentMode()).toBe('code');
  });

  it('leaves the default mode for pre-feature history with no mode tag', () => {
    const items: RolloutItem[] = [
      { type: 'turn_context', payload: { model: 'm', summary: 'auto' } as any },
    ];
    const session = new Session(undefined, false);
    expect(session.getAgentMode()).toBe('general');
    (session as any).reconstructHistoryFromRollout(items);
    expect(session.getAgentMode()).toBe('general');
  });

  it('ignores an unknown/corrupted persisted mode value', () => {
    const items: RolloutItem[] = [
      { type: 'turn_context', payload: { agentMode: 'bogus' } as any },
    ];
    const session = new Session(undefined, false);
    (session as any).reconstructHistoryFromRollout(items);
    expect(session.getAgentMode()).toBe('general');
  });
});
