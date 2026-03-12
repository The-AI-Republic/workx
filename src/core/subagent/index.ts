// File: src/core/subagent/index.ts

export type {
  SubAgentTypeConfig,
  SubAgentToolParams,
  SubAgentResult,
} from './types';

export { BUILTIN_SUBAGENT_TYPES } from './builtinTypes';
export { buildSubAgentToolDefinition } from './SubAgentTool';
export { SubAgentRegistry } from './SubAgentRegistry';
export type { ActiveSubAgent } from './SubAgentRegistry';
export { SubAgentRunner } from './SubAgentRunner';
export { registerSubAgentTool } from './register';
export type { RegisterSubAgentOptions } from './register';
