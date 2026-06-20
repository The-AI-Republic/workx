/**
 * RegularTask - Standard conversation task
 *
 * Implements normal conversation execution by delegating to AgentTask coordinator.
 * This is the default task type for user interactions.
 */

import type { SessionTask } from './SessionTask';
import type { Session } from '../Session';
import type { TurnContext } from '../TurnContext';
import type { InputItem, ResponseItem } from '../protocol/types';
import { TaskKind } from '../session/state/types';
import { AgentTask } from '../AgentTask';
import { TurnManager } from '../TurnManager';
import type { ToolRegistry } from '../../tools/ToolRegistry';

/**
 * RegularTask implementation
 * Handles normal conversation turns with tool execution by delegating to AgentTask
 */
export class RegularTask implements SessionTask {
  private agentTask: AgentTask | null = null;
  private maxTurns?: number;
  private drainPendingMessages?: () => string[];

  constructor(options?: { maxTurns?: number; drainPendingMessages?: () => string[] }) {
    this.maxTurns = options?.maxTurns;
    this.drainPendingMessages = options?.drainPendingMessages;
  }

  /**
   * Return task kind
   */
  kind(): TaskKind {
    return TaskKind.Regular;
  }

  /**
   * Execute regular conversation task
   *
   * Delegates to AgentTask coordinator which manages TaskRunner and execution
   */
  async run(
    session: Session,
    context: TurnContext,
    subId: string,
    input: InputItem[]
  ): Promise<string | null> {
    // Create TurnManager for this task
    const turnManager = new TurnManager(
      session,
      context,
      session.getToolRegistry() as ToolRegistry // Tool registry is required
    );

    // Wire hook dispatcher if available
    const hookDispatcher = session.getHookDispatcher();
    if (hookDispatcher) {
      turnManager.setHookDispatcher(hookDispatcher);
    }

    // Convert InputItem[] to ResponseItem[] for AgentTask
    const responseItems = this.convertInput(input);

    // Delegate to AgentTask coordinator (browser-specific layer).
    // (Track 04) If the session has a TaskOutputStore (set by the engine
    // when a background sub-agent is running), thread it through so the
    // underlying TaskRunner persists chunks. subId doubles as the taskId
    // — for background_agent tasks subId is the runId set by SubAgentRunner.
    const taskOutputStore = session.getTaskOutputStore?.() ?? undefined;
    this.agentTask = new AgentTask(
      session,
      context,
      turnManager,
      session.getSessionId(),
      subId,
      responseItems,
      {
        maxTurns: this.maxTurns,
        drainPendingMessages: this.drainPendingMessages,
        taskOutputStore: taskOutputStore ?? undefined,
        taskId: taskOutputStore ? subId : undefined,
      }
    );

    try {
      // Run task via AgentTask (which creates and manages TaskRunner)
      await this.agentTask.run();

      // Extract final assistant message from session history
      const conversationHistory = session.getConversationHistory();
      const lastAgentMessage = conversationHistory.items
        .filter((item): item is Extract<ResponseItem, { type: 'message' }> => 
          item.type === 'message' && item.role === 'assistant')
        .map(item => {
          // Extract text content from ContentItem array
          return item.content
            .filter((content): content is Extract<typeof content, { type: 'output_text' }> => 
              content.type === 'output_text')
            .map(content => content.text)
            .join('');
        })
        .pop();

      return lastAgentMessage || null;
    } catch (error) {
      console.error('RegularTask execution error:', error);
      throw error;
    }
  }

  /**
   * Convert InputItem[] to ResponseItem[] for AgentTask
   *
   * AgentTask expects ResponseItem[], but SessionTask.run() provides InputItem[]
   */
  private convertInput(input: InputItem[]): ResponseItem[] {
    return input.map(item => {
      // Handle different InputItem types
      let text: string;
      if (item.type === 'text') {
        text = item.text;
      } else if (item.type === 'image') {
        text = `[Image: ${item.image_url}]`;
      } else {
        text = JSON.stringify(item);
      }
      
      return {
        type: 'message' as const,
        role: 'user' as const,
        content: [{
          type: 'text' as const,
          text: text
        }]
      };
    });
  }

  /**
   * Abort task execution
   * Delegates to AgentTask.cancel() which stops TaskRunner
   */
  async abort(session: Session, subId: string): Promise<void> {
    if (this.agentTask) {
      this.agentTask.cancel();
      this.agentTask = null;
    }
  }
}
