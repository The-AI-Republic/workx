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
      description: `Delegate a task to a specialized sub-agent. The sub-agent runs independently with its own context and returns a result. Use this when a task is self-contained and can be fully described in the prompt.

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
            description: 'Complete task description with all necessary context. The sub-agent has NO access to your conversation history — include everything it needs.',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 word) summary of what the sub-agent will do',
          },
          background: {
            type: 'boolean',
            description: 'Run in background (returns immediately with runId, sends <task-notification> on completion). Default: false.',
          },
        },
        required: ['type', 'prompt'],
      },
    },
  };
}
