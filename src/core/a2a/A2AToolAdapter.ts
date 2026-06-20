/**
 * A2A Tool Adapter
 *
 * Adapts A2A skills to workx ToolDefinition format.
 * Provides skill-to-tool mapping, risk assessment, and registration helpers.
 *
 * Mirrors the MCPToolAdapter pattern from src/core/mcp/MCPToolAdapter.ts.
 */

import type { IA2ASkill, IA2AContent, IA2AManager } from './types';
import type { ToolDefinition, ToolHandler, ToolContext } from '../../tools/BaseTool';
import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../approval/types';
import { RiskLevel } from '../approval/types';
import type { ToolRegistrationOptions } from '../../tools/ToolRegistry';

// ============================================================================
// Prefixed Name Utilities
// ============================================================================

/**
 * Parse a prefixed skill name into agent name and skill ID.
 *
 * @param prefixedName - Format: "agentName__skillId"
 * @returns { agentName, skillId } or null if invalid
 */
export function parsePrefixedName(
  prefixedName: string
): { agentName: string; skillId: string } | null {
  if (!prefixedName) {
    return null;
  }

  const parts = prefixedName.split('__');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { agentName: parts[0], skillId: parts[1] };
  }

  return null;
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Format A2A tool result content for LLM consumption.
 *
 * Converts IA2AContent[] to a string:
 * - TextPart -> text as-is
 * - FilePart -> "[File: name] (mimeType) uri"
 * - DataPart -> JSON.stringify(data, null, 2)
 *
 * Multiple parts joined with "\n\n".
 * Returns "(no content)" if empty.
 */
export function formatA2AResult(content: IA2AContent[]): string {
  if (!content || content.length === 0) {
    return '(no content)';
  }

  const parts: string[] = content.map((item) => {
    switch (item.type) {
      case 'text':
        return item.text;
      case 'file':
        return `[File: ${item.name ?? 'unnamed'}] (${item.mimeType ?? 'unknown'}) ${item.uri}`;
      case 'data':
        return JSON.stringify(item.data, null, 2);
      default:
        return `[Unknown content type: ${(item as { type: string }).type}]`;
    }
  });

  const result = parts.join('\n\n');
  return result || '(no content)';
}

// ============================================================================
// Tool Adaptation
// ============================================================================

/**
 * Adapt a single A2A skill to a ToolDefinition.
 *
 * Tool naming: `${agentName}__${skill.id}`
 * Description prefixed with agent name: "[agentName] description"
 *
 * Since A2A skills don't declare JSON Schema for inputs (unlike MCP tools),
 * we create a generic schema with a single 'message' text parameter that
 * the LLM uses to communicate the request in natural language.
 *
 * @param skill - The A2A skill from the remote agent card
 * @param agentName - The remote agent's name (used as prefix)
 * @returns ToolDefinition compatible with ToolRegistry.register()
 */
export function adaptSkill(skill: IA2ASkill, agentName: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: `${agentName}__${skill.id}`,
      description: `[${agentName}] ${skill.description}`,
      strict: false,
      parameters: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string' as const,
            description: 'The message/request to send to the remote agent',
          },
        },
        required: ['message'],
      },
    },
  };
}

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * A2A Risk Assessor
 *
 * Custom IRiskAssessor for A2A skill invocations.
 * - Trusted agents: score 10, auto-approve (no risk)
 * - Untrusted agents: score 45, ask_user (medium risk, network boundary crossing)
 */
export class A2ARiskAssessor implements IRiskAssessor {
  constructor(private readonly trusted: boolean) {}

  assess(
    _toolName: string,
    _parameters: Record<string, unknown>,
    _context?: ApprovalContext
  ): RiskAssessment {
    if (this.trusted) {
      return {
        score: 10,
        level: RiskLevel.None,
        factors: ['Trusted A2A agent'],
        action: 'auto_approve',
      };
    }
    return {
      score: 45,
      level: RiskLevel.Medium,
      factors: ['External A2A agent call', 'Network boundary crossing'],
      action: 'ask_user',
    };
  }
}

// ============================================================================
// Handler Creation
// ============================================================================

/**
 * Create a tool handler for an A2A skill.
 *
 * Handler flow:
 * 1. Extract 'message' parameter from args
 * 2. Check if remote agent supports streaming
 * 3. Call manager.executeSkillStream() or manager.executeSkill()
 * 4. Format result via formatA2AResult()
 * 5. Return formatted string for LLM consumption
 *
 * @param manager - A2AManager instance for skill execution
 * @param agentName - Remote agent name
 * @param skillId - Skill identifier
 * @returns ToolHandler function compatible with ToolRegistry
 */
export function createHandler(
  manager: IA2AManager,
  agentName: string,
  skillId: string
): ToolHandler {
  return async (
    parameters: Record<string, unknown>,
    _context: ToolContext
  ): Promise<string> => {
    const message = parameters.message as string;
    if (!message) {
      throw new Error('Missing required parameter: message');
    }

    const prefixedName = `${agentName}__${skillId}`;

    // Check if agent supports streaming
    const agentConfig = manager.getAgentByName(agentName);
    const connection = agentConfig ? manager.getConnection(agentConfig.id) : undefined;
    const supportsStreaming = connection?.agentCard?.capabilities?.streaming === true;

    let result;
    if (supportsStreaming) {
      result = await manager.executeSkillStream(prefixedName, { message });
    } else {
      result = await manager.executeSkill(prefixedName, { message });
    }

    if (result.isError) {
      throw new Error(formatA2AResult(result.content));
    }

    return formatA2AResult(result.content);
  };
}

// ============================================================================
// Registration Helpers
// ============================================================================

/**
 * Registry interface matching ToolRegistry for registration/unregistration.
 */
interface IToolRegistry {
  register(
    tool: ToolDefinition,
    handler: ToolHandler,
    riskAssessor?: IRiskAssessor | ToolRegistrationOptions
  ): Promise<void>;
  unregister(toolName: string): Promise<void>;
}

/**
 * Register all skills from a connected A2A agent with the ToolRegistry.
 * Called by A2AManager after successful connection and skill discovery.
 *
 * @param manager - A2AManager instance
 * @param agentName - Remote agent name (used as tool prefix)
 * @param skills - Skills discovered from agent card
 * @param registry - ToolRegistry to register with
 * @param trusted - Whether the agent is trusted (affects risk score)
 */
export async function registerA2ASkills(
  manager: IA2AManager,
  agentName: string,
  skills: IA2ASkill[],
  registry: IToolRegistry,
  trusted: boolean
): Promise<void> {
  const riskAssessor = new A2ARiskAssessor(trusted);

  for (const skill of skills) {
    const toolDef = adaptSkill(skill, agentName);
    const handler = createHandler(manager, agentName, skill.id);
    await registry.register(toolDef, handler, {
      riskAssessor,
      exposure: {
        source: 'a2a',
        mode: 'deferred',
        serverName: agentName,
        displayName: `${agentName}: ${skill.name ?? skill.id}`,
        searchHint: [
          skill.name,
          skill.description,
          ...(skill.tags ?? []),
        ].filter(Boolean).join(' '),
      },
    });
  }
}

/**
 * Unregister all skills for an A2A agent from the ToolRegistry.
 * Called by A2AManager before disconnection.
 *
 * @param agentName - Remote agent name
 * @param skills - Previously registered skills
 * @param registry - ToolRegistry to unregister from
 */
export async function unregisterA2ASkills(
  agentName: string,
  skills: IA2ASkill[],
  registry: { unregister(toolName: string): Promise<void> }
): Promise<void> {
  for (const skill of skills) {
    const toolName = `${agentName}__${skill.id}`;
    try {
      await registry.unregister(toolName);
    } catch {
      // Tool may not be registered, ignore
    }
  }
}
