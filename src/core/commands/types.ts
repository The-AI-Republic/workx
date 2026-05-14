/**
 * Typed Command Hierarchy (Track 03)
 *
 * Adds a Claudy-style `prompt | local` discriminated union so the model surface
 * (`use_skill`) and the typeahead surface (`webfront/commands/CommandRegistry`)
 * can share metadata uniformly.
 *
 * Design: see .ai_design/agent_improvements/03_command_skill_system/design.md
 */

import type { HooksConfig } from '@/core/hooks/types';

/** Discriminant for the typed command union. */
export type CommandKind = 'prompt' | 'local';

/** Where a command was loaded from — drives precedence and display. */
export type CommandLoadedFrom = 'builtin' | 'skill' | 'plugin';

/** Effort level — passes through to model when supported. */
export type EffortValue = 'low' | 'medium' | 'high' | 'max' | number;

/**
 * Common metadata across all command kinds.
 */
export interface CommandBase {
  /** lowercase, alphanumeric + hyphens (matches webfront NAME_PATTERN) */
  readonly name: string;
  readonly description: string;
  /** Detailed usage scenarios — surfaced to the model and to /help. */
  readonly whenToUse?: string;
  /** Hint text rendered next to the command, e.g. `<file> <pattern>`. */
  readonly argumentHint?: string;
  /** Hide from typeahead/help listings. */
  readonly isHidden?: boolean;
  /** Dynamic enable/disable. Defaults to true when omitted. */
  readonly isEnabled?: () => boolean;
  /** Source — used by CommandLoader for precedence and display. */
  readonly loadedFrom: CommandLoadedFrom;
  /** Whether the user can invoke via `/name`. Default true. */
  readonly userInvocable?: boolean;
  /** When true, SkillTool / use_skill will not invoke. Default false. */
  readonly disableModelInvocation?: boolean;
}

/**
 * A `prompt` command — model-invocable, expands into a prompt body the agent reads.
 * Skills become PromptCommands.
 */
export interface PromptCommand extends CommandBase {
  readonly type: 'prompt';
  /** Model alias or full id; 'inherit' uses the parent agent's model. */
  readonly model?: string;
  /** Thinking effort budget. Forked skills inherit from parent if omitted. */
  readonly effort?: EffortValue;
  /** Execution context. Default 'inline'. */
  readonly context?: 'inline' | 'fork';
  /** Sub-agent type when context === 'fork'. */
  readonly agent?: string;
  /** Tools restricted to this list during execution. */
  readonly allowedTools?: readonly string[];
  /** BrowserX domain glob filter (e.g. `["mail.google.com", "*.google.com"]`). */
  readonly domains?: readonly string[];
  /** Skill-scoped hooks registered for the duration of execution. */
  readonly hooks?: HooksConfig;
  /**
   * Returns the prompt body for the agent to read.
   * String-typed (not ContentBlockParam[]) to keep `core/` free of provider types.
   */
  getPromptForCommand(args: string, ctx?: unknown): Promise<string>;
}

/**
 * A `local` command — UI-only, never model-invocable.
 * `/new`, `/help`, `/settings` are LocalCommands.
 */
export interface LocalCommand extends CommandBase {
  readonly type: 'local';
  action(args?: string): void | Promise<void>;
}

/** Discriminated union — narrow on `.type`. */
export type Command = PromptCommand | LocalCommand;
