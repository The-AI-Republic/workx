import Fuse from 'fuse.js';

/** A registered slash command */
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  /** Detailed usage scenarios — surfaced to /help when present. */
  readonly whenToUse?: string;
  /** Source — drives display in /help and avoids treating skills as builtins. */
  readonly loadedFrom?: 'builtin' | 'skill' | 'plugin';
  action(args?: string): void | Promise<void>;
}

/** Options for registering a new command */
export interface CommandRegistration {
  name: string;
  description: string;
  argumentHint?: string;
  whenToUse?: string;
  loadedFrom?: 'builtin' | 'skill' | 'plugin';
  action: (args?: string) => void | Promise<void>;
}

/** Result of filtering commands */
export interface FilteredCommand {
  command: Command;
  matchType: 'name' | 'description';
}

/** Result of parsing a command input string */
export interface ParsedCommandInput {
  commandName: string;
  args?: string;
}

const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Singleton command registry with Map-based O(1) lookup.
 * Case-insensitive: all names normalized to lowercase.
 */
class CommandRegistryImpl {
  private commands = new Map<string, Command>();

  register(registration: CommandRegistration): void {
    if (!registration.name || registration.name.trim() === '') {
      throw new Error('Command name must be non-empty');
    }

    const normalizedName = registration.name.toLowerCase().trim();

    if (!NAME_PATTERN.test(normalizedName)) {
      throw new Error(
        `Command name "${registration.name}" contains invalid characters. Only alphanumeric characters and hyphens are allowed.`
      );
    }

    if (!registration.description || registration.description.trim() === '') {
      throw new Error('Command description must be non-empty');
    }

    if (typeof registration.action !== 'function') {
      throw new Error('Command action must be a function');
    }

    if (this.commands.has(normalizedName)) {
      throw new Error(`Command "/${normalizedName}" is already registered`);
    }

    this.commands.set(normalizedName, {
      name: normalizedName,
      description: registration.description,
      argumentHint: registration.argumentHint,
      whenToUse: registration.whenToUse,
      loadedFrom: registration.loadedFrom,
      action: registration.action,
    });
  }

  get(name: string): Command | undefined {
    return this.commands.get(name.toLowerCase().trim());
  }

  getAll(): Command[] {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  /**
   * Filter commands for autocomplete (Track 24.1).
   *
   * Two tiers, exact-prefix always wins:
   *  1. Hard top tier — commands whose name starts with the query, in the
   *     legacy `localeCompare` order. When `recency` is supplied, more
   *     recently executed commands lead within the tier. With no `recency`
   *     this tier is byte-identical to the pre-Fuse behavior.
   *  2. Fuzzy tier — a Fuse index over the remaining commands (typo/substring
   *     tolerant across name/description/whenToUse), ordered by match score
   *     with a small, bounded recency nudge so it can never override a clearly
   *     better fuzzy match.
   *
   * `matchType` stays within `'name' | 'description'` — the consumer contract
   * is unchanged.
   */
  filter(query: string, recency?: ReadonlyMap<string, number>): FilteredCommand[] {
    const q = query.toLowerCase().trim();

    // Recency comparator: newer first; a no-op (returns 0) when `recency` is
    // absent or neither command is known, so ordering falls through to the
    // legacy `localeCompare`.
    const byRecencyThenName = (a: Command, b: Command): number => {
      const ra = recency?.get(a.name) ?? 0;
      const rb = recency?.get(b.name) ?? 0;
      if (ra !== rb) return rb - ra;
      return a.name.localeCompare(b.name);
    };

    if (q === '') {
      return this.getAll()
        .sort(byRecencyThenName)
        .map((command) => ({ command, matchType: 'name' as const }));
    }

    const prefix: FilteredCommand[] = [];
    const rest: Command[] = [];
    for (const command of this.commands.values()) {
      if (command.name.startsWith(q)) {
        prefix.push({ command, matchType: 'name' });
      } else {
        rest.push(command);
      }
    }
    prefix.sort((a, b) => byRecencyThenName(a.command, b.command));

    const fuse = new Fuse(rest, {
      keys: [
        { name: 'name', weight: 0.6 },
        { name: 'description', weight: 0.3 },
        { name: 'whenToUse', weight: 0.1 },
      ],
      threshold: 0.5,
      ignoreLocation: true,
      includeScore: true,
      includeMatches: true,
    });

    const fuzzy: FilteredCommand[] = fuse
      .search(q)
      .map((r) => {
        const matchedName = r.matches?.some((m) => m.key === 'name');
        // Small, bounded recency nudge: at most 0.05 off the Fuse score
        // (range 0..1), so a clearly better match always stays ahead.
        const recencyNudge = recency?.has(r.item.name) ? 0.05 : 0;
        return {
          command: r.item,
          matchType: (matchedName ? 'name' : 'description') as 'name' | 'description',
          _score: (r.score ?? 1) - recencyNudge,
        };
      })
      .sort((a, b) => {
        if (a._score !== b._score) return a._score - b._score;
        return byRecencyThenName(a.command, b.command);
      })
      .map(({ command, matchType }) => ({ command, matchType }));

    return [...prefix, ...fuzzy];
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase().trim());
  }

  /** Unregister a command by name. Returns true if removed, false if not found. */
  unregister(name: string): boolean {
    return this.commands.delete(name.toLowerCase().trim());
  }

  /** Reset registry - for testing purposes */
  reset(): void {
    this.commands.clear();
  }
}

/** Parse a command input string into command name and optional args */
export function parseCommandInput(input: string): ParsedCommandInput | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  if (withoutSlash === '') return null;

  const spaceIndex = withoutSlash.indexOf(' ');
  if (spaceIndex === -1) {
    return { commandName: withoutSlash.toLowerCase() };
  }

  const commandName = withoutSlash.slice(0, spaceIndex).toLowerCase();
  const args = withoutSlash.slice(spaceIndex + 1).trim();
  return {
    commandName,
    args: args || undefined,
  };
}

/** Singleton instance */
export const commandRegistry = new CommandRegistryImpl();
