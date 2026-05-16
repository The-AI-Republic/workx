/**
 * Plan Review (Track 14) — shared data model.
 *
 * Single source of truth for the structured plan, used by:
 *   - the `SubmitPlanForReview` tool input schema,
 *   - the model-facing approved-plan echo,
 *   - the editable approval card (Phase 3),
 *   - the `plan_artifact` rollout record (durability + Track 15 rewind),
 *   - scoped grants + staleness preconditions (Phase 4).
 *
 * See .ai_design/agent_improvements/14_plan_review/design.md.
 */

import type { JsonSchema } from '../BaseTool';

/** Tool names (single source of truth — imported by core + wiring). */
export const BEGIN_PLAN_TOOL_NAME = 'BeginPlan';
export const SUBMIT_PLAN_TOOL_NAME = 'SubmitPlanForReview';

/** Parameter schema for a no-argument tool (BeginPlan). */
export const NO_TOOL_PARAMS: JsonSchema = {
  type: 'object',
  properties: {},
  required: [],
};

/**
 * Sentinel `prePlanSequence` meaning "the real pre-BeginPlan rollout
 * sequence is not wired yet". Track 15 (rewind) is design-only today, so
 * every artifact records this. TODO(track-15): when rewind lands it MUST
 * populate the true sequence here AND treat this sentinel as "no anchor —
 * do not rewind" rather than "rewind to sequence 0 (session start)".
 */
export const UNSET_PRE_PLAN_SEQUENCE = 0;

/** A single planned step. `mutating` is the model's own classification. */
export interface PlanReviewStep {
  description: string;
  /** True if this step changes page/site state (click/submit/purchase/...). */
  mutating: boolean;
  /**
   * Phase-4 staleness precondition. Advisory: re-verified by model
   * discipline before the step (there is no execution interceptor).
   */
  precondition?: {
    /** Current URL must contain this substring. */
    urlIncludes?: string;
    /** This CSS selector must be present on the page. */
    selectorPresent?: string;
  };
}

/**
 * A scoped, pre-approved action grant carried out of plan review
 * (Phase 4). Seeded via ApprovalGate.rememberDecision so execution
 * does not re-prompt; the risk-ceiling still re-prompts on escalation.
 */
export interface PlanReviewGrant {
  /** Tool name, e.g. 'browser_dom'. */
  tool: string;
  /** Tool action, e.g. 'submit'. */
  action: string;
  /** Optional domain scope, e.g. 'shop.example'. */
  domain?: string;
}

/** The whole proposed plan — the `SubmitPlanForReview` input. */
export interface PlanReviewPlan {
  summary: string;
  steps: PlanReviewStep[];
  allowedPrompts?: PlanReviewGrant[];
}

export type PlanArtifactStatus = 'submitted' | 'approved' | 'rejected' | 'edited';

/**
 * Persisted plan record (`plan_artifact` RolloutItem payload).
 * Durable across reloads; the discardable unit for Track 15 rewind.
 */
export interface PlanArtifactPayload {
  planId: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  status: PlanArtifactStatus;
  plan: PlanReviewPlan;
  /** Set when the user edited the plan in the approval card (Phase 3). */
  editedBy?: 'user';
  /**
   * Rollout sequence of the turn before BeginPlan — the Track 15 rewind
   * anchor for a rejected plan. Currently always {@link UNSET_PRE_PLAN_SEQUENCE}
   * (Track 15 is design-only); see that constant for the wiring contract.
   */
  prePlanSequence: number;
}

/** JSON Schema for the SubmitPlanForReview tool input (model-facing). */
export const SUBMIT_PLAN_FOR_REVIEW_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One-paragraph summary of the overall plan.',
    },
    steps: {
      type: 'array',
      description: 'Ordered steps to execute after approval.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What this step does.' },
          mutating: {
            type: 'boolean',
            description:
              'True if this step changes page/site state (click, type, submit, download, purchase). False for read-only steps.',
          },
          precondition: {
            type: 'object',
            description:
              'Optional state this step assumes; re-verify before acting if the page may have changed.',
            properties: {
              urlIncludes: { type: 'string' },
              selectorPresent: { type: 'string' },
            },
          },
        },
        required: ['description', 'mutating'],
      },
    },
    allowedPrompts: {
      type: 'array',
      description:
        'Optional scoped grants to pre-approve for execution (tool + action + optional domain).',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          action: { type: 'string' },
          domain: { type: 'string' },
        },
        required: ['tool', 'action'],
      },
    },
  },
  required: ['summary', 'steps'],
};
