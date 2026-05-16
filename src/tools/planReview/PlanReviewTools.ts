/**
 * Plan Review (Track 14) — BeginPlan / SubmitPlanForReview tools.
 *
 * These are NOT plain BaseTool subclasses: a ToolContext exposes no
 * handle to the registry / approval manager. They are registered as
 * handler closures from the platform wiring site (service-worker.ts /
 * DesktopAgentBootstrap.ts), where the registry + core ApprovalManager
 * are in scope. The server bootstrap deliberately does NOT call
 * registerPlanReviewTools (no working approval round-trip there) unless
 * a Track-20 plan-resolution policy is present — the trap-guard.
 *
 * Design: .ai_design/agent_improvements/14_plan_review/design.md
 */

import type { ToolContext, ToolDefinition, ToolHandler } from '../BaseTool';
import type { ToolRegistry } from '../ToolRegistry';
import type { ApprovalManager, ApprovalRequest } from '../../core/ApprovalManager';
import type { ApprovalGate } from '../../core/approval/ApprovalGate';
import {
  BEGIN_PLAN_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  SUBMIT_PLAN_FOR_REVIEW_INPUT_SCHEMA,
  type PlanArtifactPayload,
  type PlanReviewPlan,
} from './types';

export type PlatformId = 'extension' | 'desktop' | 'server';

export interface PlanReviewWiring {
  registry: ToolRegistry;
  /** Core ApprovalManager (the working ext/desktop round-trip). */
  approvalManager: ApprovalManager;
  /** Approval gate — only needed to seed Phase-4 scoped grants. */
  approvalGate?: ApprovalGate;
  platformId: PlatformId;
  /** Track 20 (absent today) — gates server registration. */
  planPolicyPresent?: boolean;
  /** Best-effort durable persistence of the plan_artifact (Track 15). */
  recordPlanArtifact?: (payload: PlanArtifactPayload) => Promise<void> | void;
}

const READ_ONLY_PROFILE = {
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,
};

const BEGIN_PLAN_RESULT = [
  'Plan review is now active. Take READ-ONLY actions only — navigation',
  'history, current URL, DOM snapshots, screenshots, scrolling, content',
  'reads, web search. Do NOT click, type, submit, navigate/reload,',
  'download, change settings, or make purchases yet (they are frozen and',
  'will be denied). Explore what the task needs, then call',
  '`SubmitPlanForReview` with a concrete plan for the user to approve.',
].join(' ');

// ---------------------------------------------------------------------------
// Tool definitions (model-facing schema)
// ---------------------------------------------------------------------------

export function buildBeginPlanDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: BEGIN_PLAN_TOOL_NAME,
      description:
        'Enter plan review: freeze all state-changing actions and switch to ' +
        'read-only exploration. Call this before exploring when the user asked ' +
        'you to plan first. After exploring, call SubmitPlanForReview.',
      strict: false,
      parameters: { type: 'object', properties: {}, required: [] } as any,
    },
  };
}

export function buildSubmitPlanForReviewDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: SUBMIT_PLAN_TOOL_NAME,
      description:
        'Present the complete plan for the user to approve, edit, or reject. ' +
        'Only call this while plan review is active and you have a concrete ' +
        'plan. Blocks until the user decides; on approval the freeze lifts and ' +
        'you execute the plan.',
      strict: false,
      parameters: SUBMIT_PLAN_FOR_REVIEW_INPUT_SCHEMA as any,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePlan(params: Record<string, any>): PlanReviewPlan | null {
  const summary = typeof params?.summary === 'string' ? params.summary.trim() : '';
  const rawSteps = Array.isArray(params?.steps) ? params.steps : [];
  if (!summary || rawSteps.length === 0) return null;
  const steps = rawSteps
    .filter((s: any) => s && typeof s.description === 'string')
    .map((s: any) => ({
      description: String(s.description),
      mutating: s.mutating === true,
      precondition:
        s.precondition && typeof s.precondition === 'object'
          ? {
              urlIncludes:
                typeof s.precondition.urlIncludes === 'string'
                  ? s.precondition.urlIncludes
                  : undefined,
              selectorPresent:
                typeof s.precondition.selectorPresent === 'string'
                  ? s.precondition.selectorPresent
                  : undefined,
            }
          : undefined,
    }));
  if (steps.length === 0) return null;
  const allowedPrompts = Array.isArray(params?.allowedPrompts)
    ? params.allowedPrompts
        .filter((g: any) => g && typeof g.tool === 'string' && typeof g.action === 'string')
        .map((g: any) => ({
          tool: String(g.tool),
          action: String(g.action),
          domain: typeof g.domain === 'string' ? g.domain : undefined,
        }))
    : undefined;
  return { summary, steps, allowedPrompts };
}

/** Phase 3: the edited plan rides back as JSON in the approval `reason`. */
function tryParseEditedPlan(reason: string | undefined): PlanReviewPlan | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return normalizePlan(parsed);
  } catch {
    return null;
  }
}

function formatPlan(plan: PlanReviewPlan): string {
  const lines: string[] = [`**Plan:** ${plan.summary}`, ''];
  plan.steps.forEach((s, i) => {
    const tag = s.mutating ? ' _(changes state)_' : '';
    lines.push(`${i + 1}. ${s.description}${tag}`);
  });
  if (plan.allowedPrompts?.length) {
    lines.push('', '_Requested grants:_');
    for (const g of plan.allowedPrompts) {
      lines.push(`- ${g.tool} · ${g.action}${g.domain ? ` · ${g.domain}` : ''}`);
    }
  }
  return lines.join('\n');
}

function formatApprovedEcho(plan: PlanReviewPlan, edited: boolean): string {
  const label = edited ? 'Approved Plan (edited by user)' : 'Approved Plan';
  const parts: string[] = [
    'The user approved your plan. Plan review is over and the freeze is ' +
      'lifted — you may now execute it.',
    '',
    `## ${label}`,
    plan.summary,
    '',
  ];
  plan.steps.forEach((s, i) => {
    let line = `${i + 1}. ${s.description}`;
    if (s.precondition && (s.precondition.urlIncludes || s.precondition.selectorPresent)) {
      const pc: string[] = [];
      if (s.precondition.urlIncludes) pc.push(`url contains "${s.precondition.urlIncludes}"`);
      if (s.precondition.selectorPresent) pc.push(`selector "${s.precondition.selectorPresent}" present`);
      line += ` _(precondition: ${pc.join(', ')})_`;
    }
    parts.push(line);
  });
  parts.push(
    '',
    'Before each step marked as changing state, re-verify its precondition ' +
      'with a read-only tool (browser_navigation getCurrentUrl / browser_dom ' +
      'snapshot). If the page no longer matches, stop and call ' +
      'SubmitPlanForReview again with a revised plan.',
  );
  return parts.join('\n');
}

function seedGrants(w: PlanReviewWiring, plan: PlanReviewPlan): void {
  if (!w.approvalGate || !plan.allowedPrompts?.length) return;
  for (const g of plan.allowedPrompts) {
    try {
      // Reuse the existing session-memory + risk-ceiling path (the same one
      // RepublicAgentEngine.handleExecApproval uses for "remember"): an
      // escalated variant still re-prompts via RISK_CEILING_MARGIN.
      w.approvalGate.rememberDecision(g.tool, { action: g.action }, 'auto_approve', g.domain);
    } catch (e) {
      console.warn('[PlanReview] failed to seed grant', g, e);
    }
  }
}

async function safeRecord(w: PlanReviewWiring, payload: PlanArtifactPayload): Promise<void> {
  if (!w.recordPlanArtifact) return;
  try {
    await w.recordPlanArtifact(payload);
  } catch (e) {
    console.warn('[PlanReview] failed to persist plan_artifact', e);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function makeBeginPlanHandler(w: PlanReviewWiring): ToolHandler {
  return async (_params: Record<string, any>, _ctx: ToolContext) => {
    // Defensive trap-guard: even if a stale registration leaked onto a
    // server with no plan-resolution policy, never flip the freeze there.
    if (w.platformId === 'server' && !w.planPolicyPresent) {
      return (
        'Plan review is unavailable on this deployment (no managed ' +
        'plan-resolution policy configured). Proceed normally without it.'
      );
    }
    w.registry.beginPlanReview();
    return BEGIN_PLAN_RESULT;
  };
}

function makeSubmitPlanForReviewHandler(w: PlanReviewWiring): ToolHandler {
  return async (params: Record<string, any>, ctx: ToolContext) => {
    // Cheap pre-dialog reject (claudy parity): the tool stays announced
    // after plan review ends, so the model can spuriously re-call it.
    if (!w.registry.isPlanReviewActive()) {
      return (
        'You are not in plan review. If your plan was already approved, ' +
        'continue executing it — do not call SubmitPlanForReview again.'
      );
    }

    const plan = normalizePlan(params);
    if (!plan) {
      return (
        'SubmitPlanForReview needs a non-empty `summary` and at least one ' +
        '`step`. Compose the full plan, then call it again.'
      );
    }

    const planId = `plan_${ctx.sessionId}_${Date.now()}`;
    const base = {
      planId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      createdAt: Date.now(),
      // Track 15 rewind anchor. Track 15 (rewind) is design-only; populated
      // best-effort as 0 until it lands and supplies the real sequence.
      prePlanSequence: 0,
    };
    await safeRecord(w, { ...base, status: 'submitted', plan });

    const request: ApprovalRequest = {
      id: planId,
      type: 'dangerous_action',
      title: 'Submit plan for review?',
      description: formatPlan(plan),
      details: {
        action: 'plan_review',
        riskLevel: 'high',
        command: formatPlan(plan),
        parameters: { plan },
      },
      metadata: {
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        toolName: SUBMIT_PLAN_TOOL_NAME,
        timestamp: Date.now(),
        rollbackable: false,
      },
      // 0 = wait indefinitely for the human (TurnManager grants this tool an
      // effectively unbounded execution timeout so the registry race does
      // not abort the pending review).
      timeout: 0,
    };

    let resp;
    try {
      resp = await w.approvalManager.requestApproval(request);
    } catch (e) {
      w.registry.endPlanReview();
      return (
        `Plan review could not be completed (${e instanceof Error ? e.message : String(e)}). ` +
        'The freeze has been lifted; ask the user how they want to proceed.'
      );
    }

    const edited = tryParseEditedPlan(resp.reason);
    const approved = resp.decision === 'approve' || !!edited;

    if (approved) {
      const finalPlan = edited ?? plan;
      w.registry.endPlanReview();
      await safeRecord(w, {
        ...base,
        status: edited ? 'edited' : 'approved',
        plan: finalPlan,
        ...(edited ? { editedBy: 'user' as const } : {}),
      });
      seedGrants(w, finalPlan);
      return formatApprovedEcho(finalPlan, !!edited);
    }

    // Rejected.
    w.registry.endPlanReview();
    await safeRecord(w, { ...base, status: 'rejected', plan });
    const feedback =
      resp.reason && resp.reason !== 'Denied by user'
        ? `\n\nUser feedback: ${resp.reason}`
        : '';
    return (
      'The user rejected your plan. Do NOT execute it. Ask how they would ' +
      `like to proceed or propose a revised approach.${feedback}`
    );
  };
}

// ---------------------------------------------------------------------------
// Registration (called from the platform wiring site)
// ---------------------------------------------------------------------------

/**
 * Register BeginPlan + SubmitPlanForReview with closure handlers.
 *
 * Trap-guard: on the server, only register when a Track-20 plan-resolution
 * policy is present (absent today) — otherwise the tools are never offered,
 * so the model cannot enter a state it cannot leave.
 */
export async function registerPlanReviewTools(w: PlanReviewWiring): Promise<void> {
  if (w.platformId === 'server' && !w.planPolicyPresent) {
    return; // trap-guard: no working approval round-trip on headless server
  }
  await w.registry.register(buildBeginPlanDefinition(), makeBeginPlanHandler(w), {
    runtime: { concurrency: READ_ONLY_PROFILE },
  });
  await w.registry.register(
    buildSubmitPlanForReviewDefinition(),
    makeSubmitPlanForReviewHandler(w),
    {
      runtime: {
        concurrency: {
          isConcurrencySafe: () => false,
          isReadOnly: () => true, // the submit itself must never be frozen
          isDestructive: () => false,
        },
      },
    },
  );
}
