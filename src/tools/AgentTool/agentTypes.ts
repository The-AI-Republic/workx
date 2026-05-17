// File: src/tools/AgentTool/agentTypes.ts

/**
 * Runtime behavior identity for sub-agents.
 *
 * `SubAgentTypeConfig.id` remains a dynamic registration key for config and
 * plugin agents. `AgentType` is the bounded enum runtime code can safely use
 * for behavior profiles.
 */
export enum AgentType {
  GeneralPurpose = 'general_purpose',
  Researcher = 'researcher',
  Planner = 'planner',
  Worker = 'worker',
  Verifier = 'verifier',
  Internal = 'internal',
}

export enum SubAgentContextMode {
  Isolated = 'isolated',
  Fork = 'fork',
}

export enum SubAgentExecutionMode {
  Foreground = 'foreground',
  Background = 'background',
}

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (Object.values(AgentType) as string[]).includes(value);
}

export function isSubAgentContextMode(value: unknown): value is SubAgentContextMode {
  return typeof value === 'string' && (Object.values(SubAgentContextMode) as string[]).includes(value);
}
