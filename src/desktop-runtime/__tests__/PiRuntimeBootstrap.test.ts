/**
 * PiRuntimeBootstrap contract test.
 *
 * Asserts that the desktop runtime bootstrap is locked to the
 * `desktop-runtime` profile, threads the host configDir as the data
 * directory by default, and forwards the channel through to the parent
 * server bootstrap unchanged. The full `initialize()` flow is exercised by
 * the parity harness and the storage fixture tests — this test guards the
 * constructor's parameter contract so an accidental refactor cannot
 * downgrade the profile or aim the bootstrap at a server data directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';

const recordedOptions: Array<{ profile?: string; dataDir?: string; channel?: ChannelAdapter }> = [];

vi.mock('@/server/agent/ServerAgentBootstrap', () => {
  class ServerAgentBootstrap {
    constructor(public readonly options: Record<string, unknown>) {
      recordedOptions.push(options as never);
    }
  }
  return { ServerAgentBootstrap };
});

vi.mock('../host', () => ({
  getDesktopRuntimeHost: () => ({
    configDir: '/fixture/config',
    storageDbPath: '/fixture/config/storage.db',
    rolloutDbPath: '/fixture/config/rollouts.db',
    configJsonPath: '/fixture/config/config.json',
    keychainServicePrefix: 'applepi',
  }),
}));

import { PiRuntimeBootstrap } from '../PiRuntimeBootstrap';

/**
 * Skeletal stand-in for ChannelAdapter — only identity is asserted by these
 * tests, since the bootstrap forwards the channel through to ServerAgentBootstrap
 * (which is itself mocked). Real adapters live in src/server/channels and
 * src/desktop-runtime/channels.
 */
function makeFakeChannel(): ChannelAdapter {
  return {
    channelId: 'fake-channel',
    channelType: 'tauri' as never,
    capabilities: {} as never,
    initialize: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
    onSubmission: vi.fn(),
  } as unknown as ChannelAdapter;
}

beforeEach(() => {
  recordedOptions.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PiRuntimeBootstrap', () => {
  it('forwards profile="desktop-runtime", host.configDir as dataDir, and the channel to ServerAgentBootstrap', () => {
    const channel = makeFakeChannel();
    new PiRuntimeBootstrap({ channel });

    expect(recordedOptions).toHaveLength(1);
    expect(recordedOptions[0]).toEqual({
      profile: 'desktop-runtime',
      dataDir: '/fixture/config',
      channel,
    });
  });

  it('honors an explicit dataDirOverride for tests, but cannot downgrade the profile', () => {
    const channel = makeFakeChannel();
    new PiRuntimeBootstrap({ channel, dataDirOverride: '/tmp/override' });

    expect(recordedOptions[0]?.profile).toBe('desktop-runtime');
    expect(recordedOptions[0]?.dataDir).toBe('/tmp/override');
  });
});
