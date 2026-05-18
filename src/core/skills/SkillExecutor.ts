/**
 * SkillExecutor — Track 03 Phase 4
 *
 * Replaces the inline-only `use_skill` handler. Supports:
 *  - Inline expansion: returns the substituted body as the tool result
 *  - Forked execution (context: 'fork'): delegates to sub_agent and returns
 *    just the sub-agent's final response
 *  - Skill-scoped hooks: registered on entry, cleared on exit (success OR error)
 *  - allowed-tools enforcement: returned in the inline result for the tool
 *    dispatcher to enforce per-turn (model-side allowlist; design Decision #6 v1)
 *
 * Design: see .ai_design/agent_improvements/03_command_skill_system/design.md
 */

import type { SkillRegistry } from './SkillRegistry';
import type { HookRegistry } from '@/core/hooks/HookRegistry';
import { SessionHookStore } from '@/core/hooks/loaders/SessionHookStore';
import { substituteVariables } from './SkillParser';
import { registerSkillScopedHooks } from './registerSkillScopedHooks';
import { SubAgentContextMode } from '@/tools/AgentTool/agentTypes';

/**
 * Shape of the sub_agent invocation. Matches the JSON the sub_agent tool
 * returns when `background: false` (see SubAgentTool.ts:24).
 */
export interface SubAgentResult {
  success: boolean;
  response?: string;
  runId: string;
  turnCount?: number;
  stopReason?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: string;
}

export interface SubAgentInvocationParams {
  type: string;
  prompt: string;
  description: string;
  contextMode?: import('@/tools/AgentTool/agentTypes').SubAgentContextMode;
  allowedTools?: readonly string[];
}

export type SubAgentInvoker = (params: SubAgentInvocationParams) => Promise<SubAgentResult>;

// ── Result shapes ─────────────────────────────────────────────────────

export interface SkillResultInline {
  success: true;
  status: 'inline';
  commandName: string;
  body: string;
  allowedTools?: readonly string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max' | number;
}

export interface SkillResultForked {
  success: boolean;
  status: 'forked';
  commandName: string;
  agentId: string;
  result: string;
  error?: string;
}

export interface SkillResultError {
  success: false;
  status: 'error';
  commandName?: string;
  error: string;
}

export type SkillExecutionResult = SkillResultInline | SkillResultForked | SkillResultError;

// ── Executor ─────────────────────────────────────────────────────────

export class SkillExecutor {
  constructor(
    private readonly skills: SkillRegistry,
    private readonly hookRegistry: HookRegistry,
    private readonly subAgentInvoker: SubAgentInvoker | null,
  ) {}

  async execute(skillName: string, args: string | undefined): Promise<SkillExecutionResult> {
    const skill = await this.skills.loadFull(skillName);
    if (!skill) {
      return {
        success: false,
        status: 'error',
        commandName: skillName,
        error: `Skill "${skillName}" not found`,
      };
    }

    // Validate fork pre-conditions before doing any work.
    if (skill.context === 'fork') {
      if (!skill.agent) {
        return {
          success: false,
          status: 'error',
          commandName: skillName,
          error: `Skill "${skillName}" declares context: 'fork' but no agent`,
        };
      }
      if (!this.subAgentInvoker) {
        return {
          success: false,
          status: 'error',
          commandName: skillName,
          error: `Skill "${skillName}" requires sub_agent infrastructure (none configured)`,
        };
      }
    }

    const argsArray = args ? args.split(/\s+/).filter(Boolean) : [];
    const body = substituteVariables(skill.body, argsArray);

    // Skill-scoped hook lifetime — clear in finally so errors don't leak hooks.
    const hookScope = new SessionHookStore(this.hookRegistry);
    if (skill.hooks) {
      try {
        registerSkillScopedHooks(hookScope, skill.hooks, skillName);
      } catch (err) {
        console.warn(`[SkillExecutor] Failed to register hooks for "${skillName}":`, err);
      }
    }

    try {
      if (skill.context === 'fork') {
        const result = await this.subAgentInvoker!({
          type: skill.agent!,
          prompt: body,
          description: `Skill: ${skillName}`,
          contextMode: SubAgentContextMode.Fork,
          allowedTools: skill.allowedTools,
        });
        return {
          success: result.success,
          status: 'forked',
          commandName: skillName,
          agentId: result.runId,
          result: result.response ?? '',
          error: result.error,
        };
      }

      // Inline path — return body + metadata for the dispatcher to apply.
      return {
        success: true,
        status: 'inline',
        commandName: skillName,
        body,
        allowedTools: skill.allowedTools,
        model: skill.model,
        effort: skill.effort,
      };
    } finally {
      hookScope.clear();
    }
  }
}
