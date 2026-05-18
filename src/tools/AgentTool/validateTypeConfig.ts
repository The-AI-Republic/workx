// File: src/tools/AgentTool/validateTypeConfig.ts

import type { SubAgentTypeConfig } from './types';
import {
  AgentType,
  SubAgentContextMode,
  isAgentType,
  isSubAgentContextMode,
} from './agentTypes';
import { getDefaultBehaviorProfile } from './behavior';

/**
 * Validate that an unknown value conforms to `SubAgentTypeConfig`.
 *
 * Two callers: `registerSubAgentTool` uses it as a type guard when filtering
 * config-supplied types (warns + skips invalid entries). `SubAgentRunner.addType`
 * uses it via {@link assertValidSubAgentTypeConfig} when accepting runtime
 * (plugin-supplied) types — throws on invalid so plugin loading surfaces the
 * error rather than silently degrading.
 */
export function validateSubAgentTypeConfig(t: unknown): t is SubAgentTypeConfig {
  if (!t || typeof t !== 'object') return false;
  const obj = t as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    console.warn('[SubAgent type config] missing id');
    return false;
  }
  if (typeof obj.systemPrompt !== 'string' || !obj.systemPrompt) {
    console.warn(`[SubAgent type config] ${obj.id}: missing systemPrompt`);
    return false;
  }
  if (typeof obj.name !== 'string') {
    console.warn(`[SubAgent type config] ${obj.id}: missing name`);
    return false;
  }
  if (typeof obj.description !== 'string') {
    console.warn(`[SubAgent type config] ${obj.id}: missing description`);
    return false;
  }
  if (obj.maxTurns !== undefined && (typeof obj.maxTurns !== 'number' || obj.maxTurns < 1)) {
    console.warn(`[SubAgent type config] ${obj.id}: invalid maxTurns`);
    return false;
  }
  if (obj.agentType !== undefined && !isAgentType(obj.agentType)) {
    console.warn(`[SubAgent type config] ${obj.id}: invalid agentType`);
    return false;
  }
  if (obj.defaultContextMode !== undefined && !isSubAgentContextMode(obj.defaultContextMode)) {
    console.warn(`[SubAgent type config] ${obj.id}: invalid defaultContextMode`);
    return false;
  }
  if (obj.allowedContextModes !== undefined) {
    if (
      !Array.isArray(obj.allowedContextModes) ||
      !obj.allowedContextModes.every(isSubAgentContextMode)
    ) {
      console.warn(`[SubAgent type config] ${obj.id}: invalid allowedContextModes`);
      return false;
    }
  }
  return true;
}

export function normalizeSubAgentTypeConfig(
  config: SubAgentTypeConfig,
  options: { allowInternal?: boolean } = {},
): SubAgentTypeConfig {
  const agentType = config.agentType ?? AgentType.GeneralPurpose;
  if (agentType === AgentType.Internal && options.allowInternal !== true) {
    throw new Error(`Sub-agent type '${config.id}' cannot use internal agentType`);
  }

  // Single source of truth: when context-mode fields are omitted they derive
  // from the agentType behavior profile (same table resolveSubAgentBehavior
  // uses). Previously this hardcoded [Isolated], so a config/plugin type
  // declaring `agentType: 'worker'` (whose profile allows fork) was silently
  // locked to isolated. Explicit config fields still win.
  const profile = getDefaultBehaviorProfile(agentType);
  const allowedContextModes = config.allowedContextModes
    ?? profile.allowedContextModes;
  const defaultContextMode = config.defaultContextMode
    ?? (allowedContextModes.includes(profile.defaultContextMode)
      ? profile.defaultContextMode
      : allowedContextModes[0])
    ?? SubAgentContextMode.Isolated;

  if (!allowedContextModes.includes(defaultContextMode)) {
    throw new Error(
      `Sub-agent type '${config.id}' defaultContextMode must be in allowedContextModes`,
    );
  }

  return {
    ...config,
    agentType,
    defaultContextMode,
    allowedContextModes,
  };
}

/**
 * Throwing variant for runtime adds (e.g. plugin-supplied types).
 * The error propagates so the plugin loader can surface the failure in
 * `LoadedPlugin.errors` rather than silently dropping the type.
 */
export function assertValidSubAgentTypeConfig(t: unknown): asserts t is SubAgentTypeConfig {
  if (!validateSubAgentTypeConfig(t)) {
    const id = typeof t === 'object' && t !== null && 'id' in t ? String((t as Record<string, unknown>).id) : '<unknown>';
    throw new Error(`Invalid sub-agent type config: ${id}`);
  }
}
