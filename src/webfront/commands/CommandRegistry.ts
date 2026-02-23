/** A registered slash command */
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  action(args?: string): void | Promise<void>;
}

/** Options for registering a new command */
export interface CommandRegistration {
  name: string;
  description: string;
  argumentHint?: string;
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

  filter(query: string): FilteredCommand[] {
    const q = query.toLowerCase().trim();
    if (q === '') {
      return this.getAll().map((command) => ({ command, matchType: 'name' as const }));
    }

    const nameMatches: FilteredCommand[] = [];
    const descMatches: FilteredCommand[] = [];
    const seen = new Set<string>();

    for (const command of this.commands.values()) {
      if (command.name.startsWith(q)) {
        nameMatches.push({ command, matchType: 'name' });
        seen.add(command.name);
      }
    }

    for (const command of this.commands.values()) {
      if (!seen.has(command.name) && command.description.toLowerCase().includes(q)) {
        descMatches.push({ command, matchType: 'description' });
      }
    }

    nameMatches.sort((a, b) => a.command.name.localeCompare(b.command.name));
    descMatches.sort((a, b) => a.command.name.localeCompare(b.command.name));

    return [...nameMatches, ...descMatches];
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase().trim());
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
