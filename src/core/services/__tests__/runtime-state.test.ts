import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeStateController,
  accessStateFromReadyState,
} from '../runtime-state';
import type { EventMsg } from '@/core/protocol/events';

describe('RuntimeStateController', () => {
  it('mirrors compatibility auth aliases and emits the desktop runtime auth shape', async () => {
    const emitted: EventMsg[] = [];
    const runtimeState = new RuntimeStateController({
      emitStateUpdate: vi.fn(async (event) => {
        emitted.push(event);
      }),
    });

    const state = await runtimeState.setAuthState({
      mode: 'login',
      hasToken: true,
      profile: { email: 'user@example.com', name: 'User' },
      profileStatus: 'ready',
    });

    expect(state.hasValidToken).toBe(true);
    expect(state.user).toEqual(state.profile);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'StateUpdate',
      data: {
        scope: 'desktop-runtime',
        kind: 'auth.stateChanged',
        auth: {
          hasToken: true,
          hasValidToken: true,
          profileStatus: 'ready',
        },
      },
    });
  });

  it('composes a snapshot when no profile is available', () => {
    const runtimeState = new RuntimeStateController({
      getEffectiveConfig: () => ({ provider: 'openai' }),
      getRuntimeStatus: () => ({ status: 'ready', lastError: null }),
    });

    expect(runtimeState.getSnapshot()).toMatchObject({
      runtime: { status: 'ready', lastError: null },
      auth: {
        mode: 'none',
        hasToken: false,
        hasValidToken: false,
        profile: null,
        user: null,
        profileStatus: 'idle',
      },
      access: {
        status: 'initializing',
        mode: 'none',
        ready: false,
      },
      effectiveConfig: { provider: 'openai' },
    });
  });

  it('maps agent ready states into runtime access states', () => {
    expect(accessStateFromReadyState({
      ready: true,
      authMode: 'login',
      provider: 'OpenAI',
      model: 'gpt',
    })).toMatchObject({
      status: 'ready',
      mode: 'login',
      ready: true,
      provider: 'OpenAI',
      model: 'gpt',
    });

    expect(accessStateFromReadyState({
      ready: false,
      authMode: 'api_key',
      message: 'missing key',
    })).toMatchObject({
      status: 'needs_api_key',
      mode: 'api_key',
      ready: false,
      reason: 'missing key',
    });

    expect(accessStateFromReadyState({
      ready: false,
      authMode: 'none',
    })).toMatchObject({
      status: 'needs_login',
      mode: 'none',
      ready: false,
    });
  });

  it('serializes auth state emissions in write order', async () => {
    const emitted: string[] = [];
    const runtimeState = new RuntimeStateController({
      emitStateUpdate: vi.fn(async (event) => {
        if (event.type === 'StateUpdate' && event.data.scope === 'desktop-runtime' && event.data.kind === 'auth.stateChanged') {
          emitted.push((event.data.auth as { profileStatus: string }).profileStatus);
        }
      }),
    });

    await Promise.all([
      runtimeState.setAuthState({ mode: 'login', hasToken: true, profileStatus: 'loading' }),
      runtimeState.setAuthState({ mode: 'login', hasToken: true, profileStatus: 'ready' }),
    ]);

    expect(emitted).toEqual(['loading', 'ready']);
    expect(runtimeState.getAuthState().profileStatus).toBe('ready');
  });
});
