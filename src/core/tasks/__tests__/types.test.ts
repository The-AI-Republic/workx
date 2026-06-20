import { describe, it, expect } from 'vitest';
import {
  isTerminalTaskStatus,
  isBackgroundAgentTask,
  generateTaskId,
  type BackgroundAgentTaskState,
} from '../types';

describe('isTerminalTaskStatus', () => {
  it.each([
    ['pending', false],
    ['running', false],
    ['completed', true],
    ['failed', true],
    ['killed', true],
  ] as const)('returns %s for %s', (status, expected) => {
    expect(isTerminalTaskStatus(status)).toBe(expected);
  });
});

describe('isBackgroundAgentTask', () => {
  it('returns true for a background_agent state', () => {
    const state: BackgroundAgentTaskState = {
      id: 'a4f8j2kx',
      type: 'background_agent',
      status: 'running',
      description: 'X',
      startTime: 0,
      outputOffset: 0,
      notified: false,
      isBackgrounded: true,
      retain: false,
      runId: 'a4f8j2kx',
      parentSessionId: 'p',
      prompt: '',
      toolUseCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
    };
    expect(isBackgroundAgentTask(state)).toBe(true);
  });
});

describe('generateTaskId', () => {
  it('returns 9-character ID with type prefix `a` for background_agent', () => {
    const id = generateTaskId('background_agent');
    expect(id).toMatch(/^a[0-9a-z]{8}$/);
  });

  it('is reasonably unique across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(generateTaskId('background_agent'));
    }
    expect(seen.size).toBe(500);
  });
});
