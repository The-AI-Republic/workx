import { describe, expect, it, vi } from 'vitest';
import { RuntimeStateController, accessStateFromReadyState } from '../runtime-state';
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

  it('never serializes runtime URL credentials into the Webfront snapshot', () => {
    const runtimeState = new RuntimeStateController({
      urls: {
        homePageBaseUrl: null,
        backendApiBaseUrl: null,
        llmApiUrl: null,
        gatewayBaseUrl: null,
        gatewayLlmApiUrl: null,
        gatewayMcpUrl: 'https://gateway.example/mcp',
        gatewayCatalogUrl: null,
        gatewayCatalogApiBaseUrl: 'https://gateway.example/api/v1/apps',
        gatewayMcpName: 'gateway',
        gatewayMcpAuthMode: 'api-key',
        gatewayMcpApiKey: 'must-never-cross-ui',
        gatewayMcpToolDiscoveryHeader: null,
        gatewayMcpToolDiscovery: null,
        gatewayDefaultEfficientModel: null,
        llmRoutingMode: 'legacy',
        deeplinkRedirectUrl: 'workx://auth/callback',
        source: {
          homePageBaseUrl: 'default',
          backendApiBaseUrl: 'default',
          llmApiUrl: 'default',
          gatewayBaseUrl: 'default',
          gatewayLlmApiUrl: 'default',
          gatewayMcpUrl: 'env',
          gatewayCatalogUrl: 'default',
          gatewayCatalogApiBaseUrl: 'env',
          gatewayMcpName: 'default',
          gatewayMcpAuthMode: 'env',
          gatewayMcpApiKey: 'env',
          gatewayMcpToolDiscoveryHeader: 'default',
          gatewayMcpToolDiscovery: 'default',
          llmRoutingMode: 'default',
          deeplinkRedirectUrl: 'default',
        },
      },
    });
    const serialized = JSON.stringify(runtimeState.getSnapshot());
    expect(serialized).not.toContain('must-never-cross-ui');
    expect(runtimeState.getSnapshot()).not.toHaveProperty('urls');
  });

  it('maps agent ready states into runtime access states', () => {
    expect(
      accessStateFromReadyState({
        ready: true,
        authMode: 'login',
        provider: 'OpenAI',
        model: 'gpt',
      })
    ).toMatchObject({
      status: 'ready',
      mode: 'login',
      ready: true,
      provider: 'OpenAI',
      model: 'gpt',
    });

    expect(
      accessStateFromReadyState({
        ready: false,
        authMode: 'api_key',
        message: 'missing key',
      })
    ).toMatchObject({
      status: 'needs_api_key',
      mode: 'api_key',
      ready: false,
      reason: 'missing key',
    });

    expect(
      accessStateFromReadyState({
        ready: false,
        authMode: 'none',
      })
    ).toMatchObject({
      status: 'needs_login',
      mode: 'none',
      ready: false,
    });
  });

  it('serializes auth state emissions in write order', async () => {
    const emitted: string[] = [];
    const runtimeState = new RuntimeStateController({
      emitStateUpdate: vi.fn(async (event) => {
        if (
          event.type === 'StateUpdate' &&
          event.data.scope === 'desktop-runtime' &&
          event.data.kind === 'auth.stateChanged'
        ) {
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
