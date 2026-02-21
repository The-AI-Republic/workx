/**
 * A2A Tool Adapter Interface Contract
 *
 * Adapts A2A skills to browserx ToolDefinition format.
 * Mirrors MCPToolAdapter pattern from src/core/mcp/MCPToolAdapter.ts.
 */

import type { IA2ASkill, IA2AManager } from './a2a-manager-interface';

// ============================================================================
// Tool Adaptation
// ============================================================================

/**
 * Adapt a single A2A skill to a ToolDefinition.
 *
 * @param skill - The A2A skill from the remote agent card
 * @param agentName - The remote agent's name (used as prefix)
 * @returns ToolDefinition compatible with ToolRegistry.register()
 *
 * Tool naming: `${agentName}__${skill.id}`
 * Example: "weather-agent__get_forecast"
 *
 * Description prefixed with agent name: "[weather-agent] Get weather forecast"
 *
 * Parameters schema: Generated from skill metadata.
 * Since A2A skills don't declare JSON Schema for inputs (unlike MCP tools),
 * we create a generic schema with a single 'message' text parameter that
 * the LLM uses to communicate the request in natural language.
 */
export interface AdaptSkillFn {
  (skill: IA2ASkill, agentName: string): ToolDefinition;
}

/**
 * Create a tool handler for an A2A skill.
 *
 * @param manager - A2AManager instance for skill execution
 * @param agentName - Remote agent name
 * @param skillId - Skill identifier
 * @returns ToolHandler function compatible with ToolRegistry
 *
 * Handler flow:
 * 1. Extract 'message' parameter from args
 * 2. Check if remote agent supports streaming
 * 3. Call manager.executeSkill() or manager.executeSkillStream()
 * 4. Format result via formatA2AResult()
 * 5. Return formatted string for LLM consumption
 */
export interface CreateHandlerFn {
  (manager: IA2AManager, agentName: string, skillId: string): ToolHandler;
}

/**
 * Register all skills from a connected A2A agent.
 *
 * @param manager - A2AManager instance
 * @param agentName - Remote agent name
 * @param skills - Skills discovered from agent card
 * @param registry - ToolRegistry to register with
 * @param trusted - Whether the agent is trusted (affects risk score)
 */
export interface RegisterA2ASkillsFn {
  (
    manager: IA2AManager,
    agentName: string,
    skills: IA2ASkill[],
    registry: ToolRegistry,
    trusted: boolean
  ): Promise<void>;
}

/**
 * Unregister all skills for an A2A agent.
 *
 * @param agentName - Remote agent name
 * @param skills - Previously registered skills
 * @param registry - ToolRegistry to unregister from
 */
export interface UnregisterA2ASkillsFn {
  (agentName: string, skills: IA2ASkill[], registry: ToolRegistry): Promise<void>;
}

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * A2A Risk Assessor
 *
 * Custom IRiskAssessor for A2A skill invocations.
 * - Trusted agents: score 10 (auto-approve in balanced mode)
 * - Untrusted agents: score 45 (ask_user in balanced mode)
 */
export interface A2ARiskAssessorConfig {
  trusted: boolean;
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Format A2A tool result for LLM consumption.
 *
 * Converts IA2AContent[] to a string:
 * - TextPart → text as-is
 * - FilePart → "[File: name] (mimeType) uri"
 * - DataPart → JSON.stringify(data, null, 2)
 *
 * Multiple parts joined with "\n\n".
 */
export interface FormatA2AResultFn {
  (content: import('./a2a-manager-interface').IA2AContent[]): string;
}

// ============================================================================
// Prefixed Name Utilities
// ============================================================================

/**
 * Parse a prefixed skill name into agent name and skill ID.
 *
 * @param prefixedName - Format: "agentName__skillId"
 * @returns { agentName, skillId } or null if invalid
 */
export interface ParsePrefixedNameFn {
  (prefixedName: string): { agentName: string; skillId: string } | null;
}

// Placeholder types (actual definitions in src/tools/)
type ToolDefinition = unknown;
type ToolHandler = unknown;
type ToolRegistry = unknown;
