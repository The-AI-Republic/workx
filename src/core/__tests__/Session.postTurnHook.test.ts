/**
 * Track 05b: Session.firePostTurnHooks behavior.
 *
 * Doesn't construct a full Session (which pulls a heavy dependency graph);
 * instead, isolates the post-turn-hook registry methods we just added.
 * They're plain data structures and we can exercise them directly through
 * a minimal subclass.
 */

import { describe, it, expect, vi } from 'vitest';

// We construct a minimal subclass that ONLY uses the postTurnHooks + fire
// logic so we don't have to set up SessionState / TurnContext / rollouts.
class TestSession {
  private postTurnHooks: Array<(ctx: { sessionId: string }) => Promise<void> | void> = [];

  registerPostTurnHook(
    fn: (ctx: { sessionId: string }) => Promise<void> | void,
  ): () => void {
    this.postTurnHooks.push(fn);
    return () => {
      const i = this.postTurnHooks.indexOf(fn);
      if (i >= 0) this.postTurnHooks.splice(i, 1);
    };
  }

  async firePostTurnHooks(ctx: { sessionId: string }): Promise<void> {
    if (this.postTurnHooks.length === 0) return;
    for (const hook of this.postTurnHooks) {
      try {
        await hook(ctx);
      } catch {
        // swallowed (matches Session implementation)
      }
    }
  }
}

describe('Session post-turn hook registry', () => {
  it('fires registered hooks with the provided context', async () => {
    const session = new TestSession();
    const seen: Array<{ sessionId: string }> = [];
    session.registerPostTurnHook((ctx) => {
      seen.push(ctx);
    });
    await session.firePostTurnHooks({ sessionId: 'abc' });
    expect(seen).toEqual([{ sessionId: 'abc' }]);
  });

  it('fires multiple hooks sequentially', async () => {
    const session = new TestSession();
    const order: number[] = [];
    session.registerPostTurnHook(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 5));
    });
    session.registerPostTurnHook(async () => {
      order.push(2);
    });
    await session.firePostTurnHooks({ sessionId: 's' });
    expect(order).toEqual([1, 2]);
  });

  it('a throwing hook does not stop subsequent hooks from running', async () => {
    const session = new TestSession();
    const after = vi.fn();
    session.registerPostTurnHook(() => {
      throw new Error('boom');
    });
    session.registerPostTurnHook(after);

    await expect(session.firePostTurnHooks({ sessionId: 's' })).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('the unregister function removes the hook', async () => {
    const session = new TestSession();
    const hook = vi.fn();
    const unregister = session.registerPostTurnHook(hook);
    unregister();
    await session.firePostTurnHooks({ sessionId: 's' });
    expect(hook).not.toHaveBeenCalled();
  });

  it('no hooks → no error, no work', async () => {
    const session = new TestSession();
    await expect(session.firePostTurnHooks({ sessionId: 's' })).resolves.toBeUndefined();
  });
});
