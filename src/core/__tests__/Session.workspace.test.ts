import { describe, expect, it, vi } from 'vitest';
import { Session } from '../Session';
import type { SessionServices } from '../session/state/SessionServices';

function services(defaultWorkingDirectory = '/home/rich'): SessionServices {
  return {
    rollout: null,
    notifier: {
      notify: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    showRawAgentReasoning: false,
    defaultWorkingDirectory,
  };
}

describe('Session workspace', () => {
  it('captures the platform home folder as a new session default', () => {
    const session = new Session(undefined, false, services());
    expect(session.getWorkingDirectory()).toBe('/home/rich');
    expect(session.getTurnContext().getWorkingDirectory()).toBe('/home/rich');
    expect(session.getTurnContext().export().workspace).toEqual({
      workingDirectory: '/home/rich',
    });
  });

  it('exports the folder and clears file freshness when it changes', () => {
    const session = new Session(undefined, false, services());
    session.getFileStateCache().set('/home/rich/a.ts', {
      content: 'a',
      mtimeFloorMs: 1,
    });

    session.setWorkingDirectory('/home/rich/projects/workx');

    expect(session.getFileStateCache().size).toBe(0);
    expect(session.export().state.workspace).toEqual({
      workingDirectory: '/home/rich/projects/workx',
    });
  });

  it('emits model context initially and only after the folder changes', () => {
    const session = new Session(undefined, false, services());
    const first = session.takeWorkspaceContextUpdate() as any;
    expect(first.content[0].text).toContain('<working_directory>/home/rich</working_directory>');
    expect(session.takeWorkspaceContextUpdate()).toBeUndefined();

    session.setWorkingDirectory('/home/rich/projects/workx');
    const changed = session.takeWorkspaceContextUpdate() as any;
    expect(changed.content[0].text).toContain(
      '<working_directory>/home/rich/projects/workx</working_directory>',
    );
    expect(session.takeWorkspaceContextUpdate()).toBeUndefined();
  });

  it('inherits the saved folder when a conversation is forked', async () => {
    const session = new Session(undefined, false, services(), undefined, {
      mode: 'forked',
      sourceConversationId: 'source',
      workspace: { workingDirectory: '/home/rich/projects/source' },
      rolloutItems: [{
        type: 'turn_context',
        payload: {
          workspace: { workingDirectory: '/home/rich/projects/old-at-rewind-point' },
        },
      }],
    });
    await session.initialize();
    expect(session.getWorkingDirectory()).toBe('/home/rich/projects/source');
  });

  it('restores the latest saved folder when a conversation resumes', async () => {
    const meta = (cwd: string) => ({
      type: 'session_meta' as const,
      payload: {
        id: 'saved-session',
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'desktop',
        cliVersion: '1.0.0',
      },
    });
    const session = new Session(undefined, false, services(), undefined, {
      mode: 'resumed',
      sessionId: 'saved-session',
      rolloutItems: [
        meta('/home/rich/old'),
        {
          type: 'turn_context',
          payload: {
            workspace: { workingDirectory: '/home/rich/current' },
          },
        },
      ],
    });
    await session.initialize();
    expect(session.getWorkingDirectory()).toBe('/home/rich/current');
  });
});
