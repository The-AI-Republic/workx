// File: src/tools/AgentTool/SubAgentTool.ts

import type { SubAgentTypeConfig } from './types';
import type { ToolDefinition } from '../BaseTool';

/**
 * Build the sub_agent tool definition.
 * The type enum is dynamically populated from registered sub-agent types.
 */
export function buildSubAgentToolDefinition(
  types: SubAgentTypeConfig[]
): ToolDefinition {
  const typeDescriptions = types
    .map(t => `- "${t.id}": ${t.description}`)
    .join('\n');

  return {
    type: 'function',
    function: {
      name: 'sub_agent',
      description: `Delegate a task to a specialized sub-agent. By default the sub-agent runs independently with its own isolated context and returns a result. Use context_mode="fork" when the child needs the current conversation history.

Return shape depends on the background flag:
- background=false (default): synchronous. Returns { success, response, runId, turnCount, stopReason, tokenUsage?, error? } — the full result of the sub-agent's run. Use response to read its output.
- background=true: asynchronous. Returns immediately with { kind: "background", status: "launched", runId, type, description }. The sub-agent keeps running. When it finishes, a <task-notification> block is injected into your next turn with the final status, result, and usage. Keep the returned runId — use it with cancel_sub_agent or send_message.

Available types:
${typeDescriptions}`,
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: types.map(t => t.id),
            description: 'Which sub-agent type to invoke',
          },
          prompt: {
            type: 'string',
            description: 'Complete task description. In isolated mode, include all necessary context because the sub-agent has no conversation history. In fork mode, focus on the delegated task because the sub-agent receives the parent conversation snapshot.',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 word) summary of what the sub-agent will do',
          },
          background: {
            type: 'boolean',
            description: 'Run in background (returns immediately with runId, sends <task-notification> on completion). Default: false.',
          },
          context_mode: {
            type: 'string',
            enum: ['isolated', 'fork'],
            description: 'Context mode. "isolated" (default) starts with no parent conversation history. "fork" gives the sub-agent a snapshot of the parent conversation plus the delegated task.',
          },
        },
        required: ['type', 'prompt'],
      },
    },
  };
}
