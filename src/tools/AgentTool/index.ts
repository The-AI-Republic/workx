// File: src/tools/AgentTool/index.ts

export type {
  SubAgentTypeConfig,
  SubAgentToolParams,
  SubAgentResult,
  BackgroundSubAgentResult,
  TaskNotification,
  AgentContext,
  AgentRunResult,
  IAgentRunner,
  SubAgentUsageEntry,
  SubAgentUsageSummary,
} from './types';

export { BUILTIN_SUBAGENT_TYPES } from './builtinTypes';
export { buildSubAgentToolDefinition } from './SubAgentTool';
export { SubAgentRegistry } from './SubAgentRegistry';
export type { ActiveSubAgent } from './SubAgentRegistry';
export { SubAgentRunner } from './SubAgentRunner';
export { registerSubAgentTool } from './register';
export type { RegisterSubAgentOptions } from './register';
export {
  buildListSubAgentsToolDefinition,
  buildCancelSubAgentToolDefinition,
  buildSendMessageToolDefinition,
  createListSubAgentsHandler,
  createCancelSubAgentHandler,
  createSendMessageHandler,
} from './managementTools';
