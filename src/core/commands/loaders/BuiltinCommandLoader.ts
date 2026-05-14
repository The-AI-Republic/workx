/**
 * BuiltinCommandLoader
 *
 * Wraps the existing webfront/commands/CommandRegistry singleton's registered
 * built-in commands (`/new`, `/help`, `/settings`, etc.) as typed LocalCommand[]
 * for the new typed command surface.
 *
 * Note: `core/` cannot import from `webfront/`. The loader is constructed with
 * an injected snapshot getter so the dependency direction stays inverted.
 */

import type { LocalCommand } from '../types';

export interface BuiltinCommandSource {
  /** Returns the current set of UI-only commands. */
  list(): Array<{
    name: string;
    description: string;
    argumentHint?: string;
    action: (args?: string) => void | Promise<void>;
  }>;
}

export class BuiltinCommandLoader {
  constructor(private readonly source: BuiltinCommandSource) {}

  load(): LocalCommand[] {
    return this.source.list().map((cmd) => ({
      type: 'local',
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.argumentHint,
      loadedFrom: 'builtin',
      action: cmd.action,
    }));
  }
}
