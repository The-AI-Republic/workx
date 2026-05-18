/**
 * CommandLoader
 *
 * Aggregates typed commands from multiple sources and dedupes by name.
 * First-match-wins, mirrors claudy `commands.ts:451-470` semantics. Source
 * precedence is `builtin > skill > plugin` (see `precedence.ts`).
 */

import { BuiltinCommandLoader } from './loaders/BuiltinCommandLoader';
import { SkillCommandLoader } from './loaders/SkillCommandLoader';
import { PluginCommandLoader } from './loaders/PluginCommandLoader';
import { precedenceOf } from './precedence';
import type { Command } from './types';

export interface CommandLoaderDeps {
  builtin?: BuiltinCommandLoader;
  skill?: SkillCommandLoader;
  /** Track 10: plugin-contributed commands (manifest.commands slot). */
  plugin?: PluginCommandLoader;
}

export class CommandLoader {
  constructor(private readonly deps: CommandLoaderDeps) {}

  loadAll(): Command[] {
    const collected: Command[] = [];
    if (this.deps.builtin) collected.push(...this.deps.builtin.load());
    if (this.deps.skill) collected.push(...this.deps.skill.load());
    if (this.deps.plugin) collected.push(...this.deps.plugin.load());
    return CommandLoader.dedupeByName(collected);
  }

  /**
   * First-match-wins by `name`, with stable ordering by source precedence.
   * Filters out commands whose `isEnabled()` returns false.
   */
  static dedupeByName(commands: readonly Command[]): Command[] {
    // Sort a copy by precedence so earlier sources are tried first.
    const sorted = [...commands].sort(
      (a, b) => precedenceOf(a.loadedFrom) - precedenceOf(b.loadedFrom),
    );

    const seen = new Set<string>();
    const out: Command[] = [];
    for (const cmd of sorted) {
      if (cmd.isEnabled && cmd.isEnabled() === false) continue;
      const key = cmd.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cmd);
    }
    return out;
  }

  /** Filter to model-invocable prompt commands (used by the model system prompt). */
  static getModelInvocable(commands: readonly Command[]): Command[] {
    return commands.filter(
      (c) => c.type === 'prompt' && !c.disableModelInvocation && !c.isHidden,
    );
  }

  /** Filter to user-invocable commands (for slash typeahead). */
  static getUserInvocable(commands: readonly Command[]): Command[] {
    return commands.filter((c) => c.userInvocable !== false && !c.isHidden);
  }
}
