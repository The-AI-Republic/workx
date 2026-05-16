import { describe, it, expect } from 'vitest';
import {
  classifyForOrigin,
  originRequiresGate,
} from '../bridgeSafe';
import { deriveInputOrigin } from '../types';
import type { InputOrigin } from '../types';
import type { SubmissionContext } from '../../channels/types';

describe('originRequiresGate', () => {
  it('skips the gate for trusted local input', () => {
    expect(originRequiresGate({ channel: 'local' })).toBe(false);
  });

  it('applies the gate for connector / remote / scheduler', () => {
    for (const channel of ['connector', 'remote', 'scheduler'] as const) {
      expect(originRequiresGate({ channel })).toBe(true);
    }
  });
});

describe('classifyForOrigin', () => {
  it('marks allowlisted read-only commands safe', () => {
    expect(classifyForOrigin('help')).toBe('safe');
    expect(classifyForOrigin('HELP')).toBe('safe');
  });

  it('marks UI-only / sensitive commands unsafe-known', () => {
    expect(classifyForOrigin('settings')).toBe('unsafe-known');
    expect(classifyForOrigin('config')).toBe('unsafe-known');
    expect(classifyForOrigin('login')).toBe('unsafe-known');
  });

  it('marks unrecognized commands unknown', () => {
    expect(classifyForOrigin('totally-made-up')).toBe('unknown');
  });
});

describe('deriveInputOrigin', () => {
  const base: SubmissionContext = {
    channelId: 'c1',
    channelType: 'server',
  };

  it('maps known on-host channel types to local', () => {
    for (const channelType of [
      'sidepanel',
      'tabpage',
      'tauri',
      'server',
      'cli',
    ] as const) {
      const o: InputOrigin = deriveInputOrigin({ ...base, channelType });
      expect(o.channel).toBe('local');
    }
  });

  it('maps websocket to remote', () => {
    expect(deriveInputOrigin({ ...base, channelType: 'websocket' }).channel).toBe(
      'remote',
    );
  });

  it('maps connector ids (e.g. telegram) to connector', () => {
    const o = deriveInputOrigin({
      channelId: 'telegram:acct',
      channelType: 'telegram',
      userId: 'u9',
    });
    expect(o.channel).toBe('connector');
    expect(o.channelType).toBe('telegram');
    expect(o.userId).toBe('u9');
  });
});
