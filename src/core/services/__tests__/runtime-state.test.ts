import { describe, expect, it, vi } from 'vitest';
import { RuntimeStateController, accessStateFromReadyState } from '../runtime-state';

describe('OSS runtime state', () => {
  it('projects ChatGPT OAuth through the API-key access mode', () => {
    expect(accessStateFromReadyState({ ready: true, authMode: 'chatgpt_oauth' })).toMatchObject({
      status: 'ready',
      mode: 'api_key',
      ready: true,
    });
  });

  it('requests an API key when no credential is configured', () => {
    expect(accessStateFromReadyState({ ready: false, authMode: 'none' })).toMatchObject({
      status: 'needs_api_key',
      mode: 'none',
      ready: false,
    });
  });

  it('publishes state updates without a product session', async () => {
    const emitStateUpdate = vi.fn();
    const state = new RuntimeStateController({ emitStateUpdate });
    await state.setAccessState({ status: 'needs_api_key', mode: 'api_key', ready: false });
    expect(state.getAccessState()).toMatchObject({ status: 'needs_api_key', mode: 'api_key' });
    expect(emitStateUpdate).toHaveBeenCalledOnce();
  });
});
