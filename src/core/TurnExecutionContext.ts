import type { AgentMode } from '../prompts/PromptComposer';

/** The local folder captured by a conversation. */
export interface SessionWorkspace {
  workingDirectory: string;
}

/**
 * Immutable settings snapshot shared by every tool call in one model turn.
 * Tools must use this context instead of reading global preferences or the
 * host process working directory.
 */
export interface TurnExecutionContext {
  sessionId: string;
  turnId: string;
  mode: AgentMode;
  workspace?: Readonly<SessionWorkspace>;
  tabId?: number;
}
