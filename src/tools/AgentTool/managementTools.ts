// File: src/tools/AgentTool/managementTools.ts

import type { ToolDefinition } from '../BaseTool';
import type { SubAgentRegistry } from './SubAgentRegistry';

export function buildListSubAgentsToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'list_sub_agents',
      description: 'List all active and recently completed sub-agents with their status.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  };
}

export function buildCancelSubAgentToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'cancel_sub_agent',
      description: 'Cancel a running sub-agent by its runId.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: 'The runId of the sub-agent to cancel',
          },
        },
        required: ['runId'],
      },
    },
  };
}

export function buildSendMessageToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a follow-up message to a running background sub-agent.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'The runId of the target sub-agent',
          },
          message: {
            type: 'string',
            description: 'Follow-up instruction or context to send',
          },
        },
        required: ['to', 'message'],
      },
    },
  };
}

export function createListSubAgentsHandler(registry: SubAgentRegistry) {
  return async (_params: Record<string, unknown>) => {
    const agents = registry.getAll().map(a => ({
      runId: a.runId,
      type: a.type,
      description: a.description,
      status: a.status,
      startTime: a.startTime,
      durationMs: Date.now() - a.startTime,
    }));
    return JSON.stringify({ success: true, agents });
  };
}

export function createCancelSubAgentHandler(registry: SubAgentRegistry) {
  return async (params: Record<string, unknown>) => {
    const runId = params.runId as string;
    if (!runId) {
      return JSON.stringify({ success: false, error: 'Missing required parameter: runId' });
    }
    const agent = registry.get(runId);
    if (!agent) {
      return JSON.stringify({ success: false, error: `No sub-agent found with runId: ${runId}` });
    }
    if (agent.status !== 'running') {
      return JSON.stringify({ success: false, error: `Sub-agent ${runId} is not running (status: ${agent.status})` });
    }
    try {
      await agent.engine.dispose();
      registry.updateStatus(runId, 'cancelled');
      return JSON.stringify({ success: true, message: `Sub-agent ${runId} cancelled` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: false, error: `Failed to cancel: ${msg}` });
    }
  };
}

export function createSendMessageHandler(registry: SubAgentRegistry) {
  return async (params: Record<string, unknown>) => {
    const to = params.to as string;
    const message = params.message as string;
    if (!to) return JSON.stringify({ success: false, error: 'Missing required parameter: to' });
    if (!message) return JSON.stringify({ success: false, error: 'Missing required parameter: message' });

    const agent = registry.get(to);
    if (!agent) return JSON.stringify({ success: false, error: `No sub-agent found with runId: ${to}` });
    if (agent.status !== 'running') {
      return JSON.stringify({ success: false, error: `Sub-agent ${to} is not running (status: ${agent.status})` });
    }

    registry.queueMessage(to, message);
    return JSON.stringify({ success: true, message: 'Message queued' });
  };
}
