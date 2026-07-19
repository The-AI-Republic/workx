import { describe, expect, it } from 'vitest';
import { sessionLifecycleCheck } from '../checks/session-lifecycle';

describe('session lifecycle doctor check', () => {
  it('reports local counts without session identifiers or content', async () => {
    const result = await sessionLifecycleCheck.run({
      platformId: 'extension',
      lifecycle: {
        getLifecycleStatus: () => ({
          lifecycleMode: 'client',
          liveCount: 3,
          managedLiveCount: 3,
          runningCount: 1,
          hydratingCount: 1,
          reservationCount: 0,
          queuedSessionCount: 0,
          queuedSubmissionCount: 0,
          maxLive: 5,
          hardMax: 10,
        }),
      },
    });
    expect(result.status).toBe('pass');
    expect(result.data).toMatchObject({ liveCount: 3, runningCount: 1, lifecycleMode: 'client' });
    expect(JSON.stringify(result.data)).not.toMatch(/sessionId|title|prompt|url|error/i);
  });

  it('warns when hard capacity has queued sessions', async () => {
    const result = await sessionLifecycleCheck.run({
      platformId: 'desktop',
      lifecycle: {
        getLifecycleStatus: () => ({
          lifecycleMode: 'client',
          liveCount: 10,
          managedLiveCount: 10,
          runningCount: 10,
          hydratingCount: 0,
          reservationCount: 0,
          queuedSessionCount: 2,
          queuedSubmissionCount: 2,
          maxLive: 5,
          hardMax: 10,
        }),
      },
    });
    expect(result.status).toBe('warn');
  });
});
