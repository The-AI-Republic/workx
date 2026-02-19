/**
 * Contract: Command Registry API
 *
 * Defines the interface for the slash command system.
 * This is a design contract — not runtime code.
 */

/** A registered slash command */
export interface Command {
  /** Unique identifier, lowercase (e.g., "new", "help") */
  readonly name: string;

  /** Human-readable description shown in dropdown */
  readonly description: string;

  /** Optional hint for expected arguments (e.g., "[query]") */
  readonly argumentHint?: string;

  /**
   * Action executed when command is invoked.
   * @param args - Raw argument string after command name, or undefined if none provided
   */
  action(args?: string): void | Promise<void>;
}

/** Options for registering a new command */
export interface CommandRegistration {
  /** Command name without leading "/" (e.g., "new", "help") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Optional argument hint displayed in dropdown */
  argumentHint?: string;

  /** Action to execute */
  action: (args?: string) => void | Promise<void>;
}

/** Result of filtering commands */
export interface FilteredCommand {
  /** The matched command */
  command: Command;

  /** Whether the match was on name (prefix) or description (substring) */
  matchType: 'name' | 'description';
}

/** Command Registry interface */
export interface ICommandRegistry {
  /**
   * Register a new command.
   * @throws Error if command name is already registered
   * @throws Error if name is empty or contains invalid characters
   */
  register(registration: CommandRegistration): void;

  /**
   * Look up a command by name (case-insensitive).
   * @returns Command if found, undefined otherwise
   */
  get(name: string): Command | undefined;

  /**
   * Get all registered commands.
   * @returns Array of all commands, sorted alphabetically by name
   */
  getAll(): Command[];

  /**
   * Filter commands by query string.
   * Matches name by prefix and description by substring (both case-insensitive).
   * Name-prefix matches are returned before description-substring matches.
   * @returns Filtered commands with match type metadata
   */
  filter(query: string): FilteredCommand[];

  /**
   * Check if a command name is registered.
   * @returns true if command exists
   */
  has(name: string): boolean;
}
