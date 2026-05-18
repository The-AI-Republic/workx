// File: src/tools/AgentTool/behavior.ts

import {
  AgentType,
  SubAgentContextMode,
  SubAgentExecutionMode,
} from './agentTypes';
import type { SubAgentToolParams, SubAgentTypeConfig } from './types';

export interface SubAgentBehaviorProfile {
  agentType: AgentType;
  defaultContextMode: SubAgentContextMode;
  allowedContextModes: SubAgentContextMode[];
  approvalPolicyDefault: 'inherit' | 'never';
  canRunInBackground: boolean;
  canUseParentHistory: boolean;
  canUseBrowserContext: boolean;
  toolPolicy: 'configured' | 'read_only_bias' | 'mutation_capable' | 'internal_locked';
  suppressStreamingEvents: boolean;
}

export interface ResolvedSubAgentBehavior extends SubAgentBehaviorProfile {
  typeId: string;
  contextMode: SubAgentContextMode;
  executionMode: SubAgentExecutionMode;
  suppressedEvents: string[];
}

const DEFAULT_SUPPRESSED_STREAMING_EVENTS = ['AgentMessageDelta', 'AgentReasoningDelta'];

const PROFILE_BY_TYPE: Record<AgentType, SubAgentBehaviorProfile> = {
  [AgentType.GeneralPurpose]: {
    agentType: AgentType.GeneralPurpose,
    defaultContextMode: SubAgentContextMode.Isolated,
    allowedContextModes: [SubAgentContextMode.Isolated],
    approvalPolicyDefault: 'inherit',
    canRunInBackground: true,
    canUseParentHistory: false,
    canUseBrowserContext: true,
    toolPolicy: 'configured',
    suppressStreamingEvents: false,
  },
  [AgentType.Researcher]: {
    agentType: AgentType.Researcher,
    defaultContextMode: SubAgentContextMode.Isolated,
    allowedContextModes: [SubAgentContextMode.Isolated, SubAgentContextMode.Fork],
    approvalPolicyDefault: 'never',
    canRunInBackground: true,
    canUseParentHistory: true,
    canUseBrowserContext: false,
    toolPolicy: 'read_only_bias',
    suppressStreamingEvents: true,
  },
  [AgentType.Planner]: {
    agentType: AgentType.Planner,
    defaultContextMode: SubAgentContextMode.Isolated,
    allowedContextModes: [SubAgentContextMode.Isolated, SubAgentContextMode.Fork],
    approvalPolicyDefault: 'never',
    canRunInBackground: true,
    canUseParentHistory: true,
    canUseBrowserContext: false,
    toolPolicy: 'read_only_bias',
    suppressStreamingEvents: true,
  },
  [AgentType.Worker]: {
    agentType: AgentType.Worker,
    defaultContextMode: SubAgentContextMode.Isolated,
    allowedContextModes: [SubAgentContextMode.Isolated, SubAgentContextMode.Fork],
    approvalPolicyDefault: 'inherit',
    canRunInBackground: true,
    canUseParentHistory: true,
    canUseBrowserContext: true,
    toolPolicy: 'mutation_capable',
    suppressStreamingEvents: true,
  },
  [AgentType.Verifier]: {
    agentType: AgentType.Verifier,
    defaultContextMode: SubAgentContextMode.Isolated,
    allowedContextModes: [SubAgentContextMode.Isolated, SubAgentContextMode.Fork],
    approvalPolicyDefault: 'never',
    canRunInBackground: true,
    canUseParentHistory: true,
    canUseBrowserContext: false,
    toolPolicy: 'read_only_bias',
    suppressStreamingEvents: true,
  },
  [AgentType.Internal]: {
    agentType: AgentType.Internal,
    defaultContextMode: SubAgentContextMode.Fork,
    allowedContextModes: [SubAgentContextMode.Fork],
    approvalPolicyDefault: 'never',
    canRunInBackground: true,
    canUseParentHistory: true,
    canUseBrowserContext: false,
    toolPolicy: 'internal_locked',
    suppressStreamingEvents: true,
  },
};

export function getDefaultBehaviorProfile(agentType: AgentType): SubAgentBehaviorProfile {
  return PROFILE_BY_TYPE[agentType];
}

export function resolveSubAgentBehavior(
  config: SubAgentTypeConfig,
  params: Pick<SubAgentToolParams, 'background' | 'contextMode'>,
): ResolvedSubAgentBehavior {
  const agentType = config.agentType ?? AgentType.GeneralPurpose;
  const base = PROFILE_BY_TYPE[agentType] ?? PROFILE_BY_TYPE[AgentType.GeneralPurpose];
  const allowedContextModes = config.allowedContextModes ?? base.allowedContextModes;
  const defaultContextMode = config.defaultContextMode ?? base.defaultContextMode;
  const contextMode = params.contextMode ?? defaultContextMode;

  if (!allowedContextModes.includes(contextMode)) {
    throw new Error(
      `Sub-agent type '${config.id}' does not allow context mode '${contextMode}'`,
    );
  }

  const executionMode = params.background
    ? SubAgentExecutionMode.Background
    : SubAgentExecutionMode.Foreground;

  if (executionMode === SubAgentExecutionMode.Background && !base.canRunInBackground) {
    throw new Error(`Sub-agent type '${config.id}' cannot run in background`);
  }

  const suppressedEvents = config.suppressedEvents
    ?? (base.suppressStreamingEvents ? DEFAULT_SUPPRESSED_STREAMING_EVENTS : []);

  return {
    ...base,
    typeId: config.id,
    defaultContextMode,
    allowedContextModes,
    contextMode,
    executionMode,
    suppressedEvents,
  };
}
