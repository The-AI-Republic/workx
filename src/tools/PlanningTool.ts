/**
 * PlanningTool V2 - Task Planning and Progress Tracking
 *
 * Feature: 029-planning-tool-v2
 *
 * Enables the LLM agent to create, update, and resume task plans with
 * persistent storage (IndexedDB) and real-time progress tracking.
 * Plans survive session interruptions and are injected into the system prompt.
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseTool, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import {
  StepStatus,
  PlanAction,
  PlanStatus,
  type UpdatePlanArgs,
  type PlanItemArg,
} from '../core/protocol/events';
import type { StoredPlan, StoredPlanStep } from '../types/storage';
import { getPlanStore } from '../storage/PlanStore';

// ── Tool Description (behavioral guidance for LLM) ─────────────────────

const TOOL_DESCRIPTION = `Create, update, and manage task plans for tracking progress on complex tasks.

WHEN TO PLAN:
- Create a plan before starting tasks with 3 or more steps.
- Skip planning for simple 1-2 step tasks — execute directly.

HOW TO CREATE A PLAN:
- Use action "create" with a plan array. Each step should have:
  - "step": Clear description (5-10 words)
  - "status": Start all steps as "Pending"
  - "files": File paths you will modify (when known)
  - "reuse": Existing code/functions to leverage
  - "verification": How to verify this step succeeded
  - "dependsOn": IDs of steps that must complete first (when applicable)

HOW TO UPDATE A PLAN:
- Use action "update" to change step statuses as you work.
- Set a step to "InProgress" with an "activeDescription" before starting it.
- Set a step to "Completed" when finished.
- Only one step should be "InProgress" at a time.

HOW TO RESUME A PLAN:
- Use action "resume" to load the stored plan after a session interruption.

ACTIONS:
- "create": Create a new plan (replaces any existing plan for this session)
- "update": Modify the current plan (step statuses, add/modify steps)
- "resume": Load and return the existing plan from storage`;

/**
 * Tool definition constant for LLM discovery
 */
export const PLANNING_TOOL_DEFINITION = {
  name: 'planning_tool',
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'resume'],
        description:
          "Intent: 'create' replaces any existing plan, 'update' modifies the current plan, 'resume' loads the stored plan without changes",
      },
      explanation: {
        type: 'string',
        description: 'Optional explanation for plan creation/update',
      },
      plan: {
        type: 'array',
        description:
          "Ordered list of plan steps. Required for 'create' and 'update'. Ignored for 'resume'.",
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Stable unique identifier for this step',
            },
            step: { type: 'string', description: 'Step description (5-10 words)' },
            status: {
              type: 'string',
              enum: ['Pending', 'InProgress', 'Completed', 'Blocked'],
              description: 'Step status',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths critical to this step',
            },
            reuse: {
              type: 'array',
              items: { type: 'string' },
              description: 'Existing code/functions to leverage',
            },
            verification: {
              type: 'string',
              description: 'How to verify this step succeeded',
            },
            activeDescription: {
              type: 'string',
              description: 'Present-tense phrase shown during InProgress',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of steps that must complete first',
            },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['action'],
  },
};

/**
 * PlanningTool V2
 */
export class PlanningTool extends BaseTool {
  private sessionId: string = '';

  protected toolDefinition: ToolDefinition = {
    type: 'function' as const,
    function: {
      name: PLANNING_TOOL_DEFINITION.name,
      description: PLANNING_TOOL_DEFINITION.description,
      strict: false,
      parameters: PLANNING_TOOL_DEFINITION.inputSchema as any,
    },
    metadata: {
      capabilities: ['task_planning', 'progress_tracking'],
      platforms: ['extension', 'desktop'],
    },
    category: 'planning',
    version: '2.0.0',
  };

  /** Set the session context for plan persistence */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  protected async executeImpl(
    request: UpdatePlanArgs,
    options?: BaseToolOptions
  ): Promise<any> {
    // Default action to 'update' for backward compatibility
    const action = request.action ?? PlanAction.Update;

    switch (action) {
      case PlanAction.Create:
        return this.handleCreate(request);
      case PlanAction.Update:
        return this.handleUpdate(request);
      case PlanAction.Resume:
        return this.handleResume();
      default:
        return {
          success: false,
          error: `Unknown action '${action}'. Must be create, update, or resume.`,
          errorType: 'VALIDATION_ERROR',
        };
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────

  private async handleCreate(request: UpdatePlanArgs): Promise<any> {
    const validation = this.validatePlanArray(request.plan);
    if (validation) return validation;

    const plan = request.plan!;
    const now = Date.now();

    // Assign IDs to steps that don't have them
    const steps: StoredPlanStep[] = plan.map((item) => ({
      id: item.id || uuidv4(),
      step: item.step,
      status: item.status,
      files: item.files,
      reuse: item.reuse,
      verification: item.verification,
      activeDescription: item.activeDescription,
      dependsOn: item.dependsOn,
    }));

    // Validate dependencies
    const depError = this.validateDependencies(steps);
    if (depError) return depError;

    // Derive blocked statuses
    this.deriveBlockedStatus(steps);

    const stored: StoredPlan = {
      id: uuidv4(),
      sessionId: this.sessionId,
      status: PlanStatus.Active,
      explanation: request.explanation,
      steps,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Persist
    let warning: string | undefined;
    try {
      const store = getPlanStore();
      await store.save(stored);
    } catch (error) {
      warning = 'Failed to persist plan';
    }

    // Emit event
    await this.emitPlanEvent(stored);

    return {
      success: true,
      message: request.explanation
        ? `Plan created: ${request.explanation}`
        : `Plan created with ${steps.length} steps`,
      ...(warning ? { warning } : {}),
      planId: stored.id,
      version: stored.version,
      ...this.buildSummary(steps),
    };
  }

  private async handleUpdate(request: UpdatePlanArgs): Promise<any> {
    const validation = this.validatePlanArray(request.plan);
    if (validation) return validation;

    const plan = request.plan!;
    const now = Date.now();

    // Load existing plan
    let existing: StoredPlan | null = null;
    try {
      const store = getPlanStore();
      existing = await store.get(this.sessionId);
    } catch {
      // continue without existing
    }

    // If no existing plan, treat update as create
    if (!existing) {
      return this.handleCreate(request);
    }

    // Map steps with existing IDs preserved
    const steps: StoredPlanStep[] = plan.map((item) => ({
      id: item.id || uuidv4(),
      step: item.step,
      status: item.status,
      files: item.files,
      reuse: item.reuse,
      verification: item.verification,
      activeDescription: item.activeDescription,
      dependsOn: item.dependsOn,
    }));

    // Validate dependencies
    const depError = this.validateDependencies(steps);
    if (depError) return depError;

    // Derive blocked statuses
    this.deriveBlockedStatus(steps);

    // Check if all completed
    const allCompleted = steps.every((s) => s.status === StepStatus.Completed);

    const stored: StoredPlan = {
      ...existing,
      explanation: request.explanation ?? existing.explanation,
      steps,
      status: allCompleted ? PlanStatus.Completed : PlanStatus.Active,
      version: existing.version + 1,
      updatedAt: now,
    };

    // Persist
    try {
      const store = getPlanStore();
      await store.save(stored);
    } catch {
      // Non-fatal
    }

    // Emit event
    await this.emitPlanEvent(stored);

    return {
      success: true,
      message: request.explanation
        ? `Plan updated: ${request.explanation}`
        : `Plan updated with ${steps.length} steps`,
      planId: stored.id,
      version: stored.version,
      ...this.buildSummary(steps),
    };
  }

  private async handleResume(): Promise<any> {
    try {
      const store = getPlanStore();
      const stored = await store.get(this.sessionId);

      if (!stored) {
        return {
          success: true,
          message: 'No plan exists for this session',
          planId: null,
          plan: null,
        };
      }

      // Emit event so UI shows it
      await this.emitPlanEvent(stored);

      return {
        success: true,
        message: 'Plan resumed',
        planId: stored.id,
        version: stored.version,
        explanation: stored.explanation,
        plan: stored.steps,
        ...this.buildSummary(stored.steps),
      };
    } catch (error) {
      return {
        success: true,
        message: 'No plan exists for this session',
        planId: null,
        plan: null,
      };
    }
  }

  // ── Validation ──────────────────────────────────────────────────────

  private validatePlanArray(plan?: PlanItemArg[]): any | null {
    if (!Array.isArray(plan)) {
      return {
        success: false,
        error: 'plan must be an array (required for create/update)',
        errorType: 'VALIDATION_ERROR',
      };
    }

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];

      if (!item.step || typeof item.step !== 'string') {
        return {
          success: false,
          error: `Plan item at index ${i} must have a non-empty step string`,
          errorType: 'VALIDATION_ERROR',
        };
      }

      if (!Object.values(StepStatus).includes(item.status as StepStatus)) {
        return {
          success: false,
          error: `Invalid status '${item.status}' at index ${i}. Must be Pending, InProgress, Completed, or Blocked`,
          errorType: 'VALIDATION_ERROR',
        };
      }
    }

    return null;
  }

  /**
   * Validate that dependsOn references are valid and form a DAG.
   */
  private validateDependencies(steps: StoredPlanStep[]): any | null {
    const ids = new Set(steps.map((s) => s.id));

    // Check references exist
    for (const step of steps) {
      if (!step.dependsOn) continue;
      for (const depId of step.dependsOn) {
        if (!ids.has(depId)) {
          return {
            success: false,
            error: `Step "${step.step}" depends on non-existent step ID "${depId}"`,
            errorType: 'VALIDATION_ERROR',
          };
        }
      }
    }

    // Check for cycles via DFS
    const cycle = this.detectCycle(steps);
    if (cycle) {
      return {
        success: false,
        error: `Circular dependency detected: ${cycle}`,
        errorType: 'VALIDATION_ERROR',
      };
    }

    return null;
  }

  /**
   * DFS cycle detection. Returns a cycle description string or null.
   */
  private detectCycle(steps: StoredPlanStep[]): string | null {
    const adj = new Map<string, string[]>();
    const stepMap = new Map<string, StoredPlanStep>();

    for (const step of steps) {
      stepMap.set(step.id, step);
      adj.set(step.id, step.dependsOn ?? []);
    }

    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    for (const id of adj.keys()) color.set(id, WHITE);

    for (const id of adj.keys()) {
      if (color.get(id) === WHITE) {
        const path: string[] = [];
        if (this.dfs(id, adj, color, path)) {
          return path.join(' → ');
        }
      }
    }
    return null;
  }

  private dfs(
    node: string,
    adj: Map<string, string[]>,
    color: Map<string, number>,
    path: string[]
  ): boolean {
    const GRAY = 1,
      BLACK = 2;
    color.set(node, GRAY);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        path.push(neighbor);
        return true; // cycle found
      }
      if (color.get(neighbor) !== BLACK) {
        if (this.dfs(neighbor, adj, color, path)) return true;
      }
    }

    path.pop();
    color.set(node, BLACK);
    return false;
  }

  /**
   * Auto-set Blocked status for steps with incomplete dependencies.
   */
  private deriveBlockedStatus(steps: StoredPlanStep[]): void {
    const statusMap = new Map(steps.map((s) => [s.id, s.status]));

    for (const step of steps) {
      if (!step.dependsOn?.length) continue;

      const hasIncompleteDep = step.dependsOn.some((depId) => {
        const depStatus = statusMap.get(depId);
        return depStatus !== StepStatus.Completed;
      });

      if (hasIncompleteDep && step.status === StepStatus.Pending) {
        step.status = StepStatus.Blocked;
      }

      // Clear blocked if all deps completed
      if (!hasIncompleteDep && step.status === StepStatus.Blocked) {
        step.status = StepStatus.Pending;
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private buildSummary(steps: StoredPlanStep[]) {
    const inProgressStep = steps.find((s) => s.status === StepStatus.InProgress);
    return {
      stepCount: steps.length,
      inProgressStep: inProgressStep?.step ?? null,
      completedCount: steps.filter((s) => s.status === StepStatus.Completed).length,
      pendingCount: steps.filter((s) => s.status === StepStatus.Pending).length,
      blockedCount: steps.filter((s) => s.status === StepStatus.Blocked).length,
    };
  }

  private async emitPlanEvent(stored: StoredPlan): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      try {
        await chrome.runtime.sendMessage({
          type: 'EVENT',
          payload: {
            id: `evt_plan_${Date.now()}`,
            msg: {
              type: 'PlanUpdate',
              data: {
                action: stored.version === 1 ? PlanAction.Create : PlanAction.Update,
                explanation: stored.explanation,
                plan: stored.steps,
                planId: stored.id,
                version: stored.version,
                status: stored.status,
              },
            },
          },
        });
      } catch (error) {
        console.debug('[PlanningTool] Event emission failed (no listeners):', error);
      }
    }
  }
}
