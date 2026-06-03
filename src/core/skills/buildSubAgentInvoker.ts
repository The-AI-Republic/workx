/**
 * buildSubAgentInvoker — bridge from SkillExecutor to the agent's `sub_agent` tool.
 *
 * Constructed per-call inside the use_skill handler so it captures the real
 * ToolContext (sessionId / turnId / callId). Hardcoded sentinels here would
 * break event correlation and approval session-scoping for forked skills.
 *
 * Lives in `core/skills/` (not the bootstrap) so it's testable in isolation
 * without standing up a RepublicAgent.
 */

import type { SubAgentInvoker, SubAgentResult } from './SkillExecutor';

/** Minimal contract this helper needs from a tool registry. */
export interface ToolRegistryExecutor {
  execute(req: {
    toolName: string;
    parameters: Record<string, unknown>;
    sessionId: string;
    turnId: string;
    callId?: string;
  }): Promise<{
    success: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  }>;
}

/** Subset of ToolContext this helper needs. */
export interface SubAgentInvokerContext {
  sessionId: string;
  turnId: string;
  callId?: string;
}

/**
 * Build a SubAgentInvoker bound to the given registry + context. The returned
 * function passes ctx fields through to registry.execute, JSON-parses the
 * sub_agent tool's response, and validates the shape before casting to
 * SubAgentResult so a contract drift surfaces as a structured error rather
 * than silent `undefined`s downstream.
 */
export function buildSubAgentInvoker(
  registry: ToolRegistryExecutor,
  ctx: SubAgentInvokerContext,
): SubAgentInvoker {
  return async (subParams) => {
    try {
      const exec = await registry.execute({
        toolName: 'sub_agent',
        parameters: {
          ...subParams,
          context_mode: subParams.contextMode,
          allowed_tools: subParams.allowedTools,
          background: false,
        },
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        callId: ctx.callId,
      });

      if (!exec.success) {
        return {
          success: false,
          runId: '',
          error:
            exec.error?.message ??
            exec.error?.code ??
            'sub_agent execute failed (unknown error)',
        };
      }

      const raw = exec.data;
      let parsed: unknown;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (parseErr) {
        return {
          success: false,
          runId: '',
          error: `sub_agent returned non-JSON output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        };
      }

      if (!isSubAgentResult(parsed)) {
        return {
          success: false,
          runId: '',
          error: 'sub_agent returned malformed result (missing success/runId)',
        };
      }
      return parsed;
    } catch (err) {
      return {
        success: false,
        runId: '',
        error: `sub_agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

function isSubAgentResult(value: unknown): value is SubAgentResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.success === 'boolean' && typeof v.runId === 'string';
}
