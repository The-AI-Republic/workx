/**
 * Contract: Command System Events
 *
 * Defines the events dispatched by the command system components.
 * These events flow from MessageInput.svelte to Main.svelte.
 */

/** Events dispatched by the enhanced MessageInput when commands execute */
export interface CommandEvents {
  /**
   * Fired when a command produces output to display in the conversation area.
   * Used by /help to render the command list.
   */
  commandOutput: {
    /** Title for the output event (e.g., "Available Commands") */
    title: string;
    /** Content to display (markdown-formatted string) */
    content: string;
  };

  /**
   * Fired when a command requests opening the settings panel.
   * Used by /settings command.
   */
  openSettings: void;
}

/**
 * Props added to MessageInput for command system support.
 * These extend the existing MessageInput props.
 */
export interface CommandInputProps {
  /**
   * Callback invoked when /new command is executed.
   * Reuses existing onNewConversation prop — no new prop needed.
   */
  // onNewConversation: () => void;  // Already exists
}

/**
 * Input parsing result from the command system.
 */
export interface ParsedCommandInput {
  /** Command name without leading "/" (lowercase) */
  commandName: string;
  /** Raw argument string after command name, or undefined */
  args?: string;
}
