/**
 * Track 10 (review B #4): CommandSlotLoader argument substitution.
 *
 * `getPromptForCommand` must use single-pass, function-form replacement so
 * that `$`-sequences in untrusted user `args` (`$&`, `$\``, `$'`, `$$`) are
 * NOT reinterpreted as String.replace replacement patterns, and an injected
 * `$1` coming from args is not re-expanded by a second pass.
 */

import { describe, it, expect, vi } from 'vitest';
import { CommandSlotLoader } from '../CommandSlotLoader';
import type { LoadedPlugin } from '../../types';
import type { PromptCommand } from '@/core/commands/types';

function makePlugin(commands: Record<string, { content: string; description: string }>): LoadedPlugin {
  return {
    id: 'p@local',
    manifest: { name: 'p', version: '1.0.0', commands },
    path: '/plugins/p',
    source: { type: 'path', path: '/plugins/p' },
    scope: 'user',
    state: { status: 'disabled' },
  };
}

async function loadCommands(
  commands: Record<string, { content: string; description: string }>,
): Promise<PromptCommand[]> {
  const added: PromptCommand[] = [];
  const loader = new CommandSlotLoader({
    pluginCommandLoader: {
      add: vi.fn((_id: string, cmds: PromptCommand[]) => added.push(...cmds)),
      removeByPluginId: vi.fn(),
    } as never,
    readFile: vi.fn(async () => null),
    listDirs: vi.fn(async () => []),
  });
  const errors = await loader.load(makePlugin(commands), {});
  expect(errors).toEqual([]);
  return added;
}

describe('CommandSlotLoader — argument substitution', () => {
  it('substitutes $1/$2/$@ positionally', async () => {
    const [cmd] = await loadCommands({ run: { content: 'A=$1 B=$2 ALL=$@ END', description: 'd' } });
    expect(cmd.name).toBe('p:run');
    expect(await cmd.getPromptForCommand!('one two')).toBe('A=one B=two ALL=one two END');
  });

  it('returns the body verbatim when no args are given', async () => {
    const [cmd] = await loadCommands({ run: { content: 'A=$1 ALL=$@', description: 'd' } });
    expect(await cmd.getPromptForCommand!('')).toBe('A=$1 ALL=$@');
  });

  it("does NOT reinterpret $&, $`, $', $$ from args as replacement patterns", async () => {
    const [cmd] = await loadCommands({ sp: { content: 'X=[$@]', description: 'd' } });
    // $@ → the raw args string, inserted literally (function-form replace).
    expect(await cmd.getPromptForCommand!("$& $` $' $$")).toBe("X=[$& $` $' $$]");
  });

  it('does NOT re-expand a $1 that arrives via args (single pass)', async () => {
    const [cmd] = await loadCommands({ sp: { content: 'X=$@', description: 'd' } });
    // The injected `$1` must survive literally, not be replaced by argList[0].
    expect(await cmd.getPromptForCommand!('$1 hello')).toBe('X=$1 hello');
  });

  it('treats a positional arg containing $-specials literally', async () => {
    const [cmd] = await loadCommands({ v: { content: 'V=$1', description: 'd' } });
    expect(await cmd.getPromptForCommand!('$&x foo')).toBe('V=$&x');
  });

  it('missing positionals resolve to empty string', async () => {
    const [cmd] = await loadCommands({ v: { content: 'V=[$3]', description: 'd' } });
    expect(await cmd.getPromptForCommand!('only-one')).toBe('V=[]');
  });
});
