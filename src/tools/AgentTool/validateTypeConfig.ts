// File: src/tools/AgentTool/validateTypeConfig.ts

import type { SubAgentTypeConfig } from './types';

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
  return true;
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
