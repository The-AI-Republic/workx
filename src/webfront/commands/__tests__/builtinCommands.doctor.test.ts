/**
 * Built-in /doctor command registration + routing (Track 17).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(),
}));

import { commandRegistry } from '../CommandRegistry';
import { initBuiltinCommands } from '../builtinCommands';

describe('builtin /doctor', () => {
  beforeEach(() => commandRegistry.reset());

  it('registers /doctor and routes its action to onOpenDoctor', () => {
    const onOpenDoctor = vi.fn();
    initBuiltinCommands({
      onNewConversation: vi.fn(),
      onCommandOutput: vi.fn(),
      onOpenSettings: vi.fn(),
      onSubmitText: vi.fn(),
      onOpenDoctor,
    });

    const cmd = commandRegistry.get('doctor');
    expect(cmd).toBeTruthy();
    expect(cmd?.loadedFrom).toBe('builtin');

    cmd!.action();
    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });
});
