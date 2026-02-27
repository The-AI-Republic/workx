/**
 * PlanningTool — Structured display tool for task plans
 *
 * The agent sends the full plan state every call. This tool validates,
 * emits a UI event, and returns a summary. No persistence, no session
 * tracking, no dependency graphs.
 */

import { BaseTool, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import {
  StepStatus,
  type PlanToolArgs,
} from '../core/protocol/events';

const TOOL_DESCRIPTION = `Create and update task plans for tracking progress on complex tasks.

WHEN TO PLAN:
- Use for tasks with 3 or more steps.
- Skip for simple 1-2 step tasks — execute directly.

RESEARCH FIRST:
- Never call this tool as your first action on a non-trivial task.
- First observe available resources (pages, tools, MCP servers, files) so the plan reflects reality.
- Only compose the plan after you have enough context.

HOW TO USE:
- Every call sends the FULL plan (all steps, all statuses).
- Set a step to "InProgress" before starting it.
- Set a step to "Completed" when finished.
- Only one step should be "InProgress" at a time.`;

/**
 * Tool definition constant for LLM discovery
 */
export const PLANNING_TOOL_DEFINITION = {
  name: 'planning_tool',
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object' as const,
    properties: {
      explanation: {
        type: 'string',
        description: 'What changed in this update',
      },
      plan: {
        type: 'array',
        description: 'Full ordered list of plan steps (required every call)',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Step description (5-10 words)' },
            status: {
              type: 'string',
              enum: ['Pending', 'InProgress', 'Completed'],
              description: 'Step status',
            },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['plan'],
  },
};

/**
 * PlanningTool — validate and emit, nothing more
 */
export class PlanningTool extends BaseTool {
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
    version: '1.0.0',
  };

  protected async executeImpl(
    request: PlanToolArgs,
    _options?: BaseToolOptions
  ): Promise<any> {
    const plan = request.plan;

    // Validate plan array
    if (!Array.isArray(plan)) {
      return {
        success: false,
        error: 'plan must be an array',
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
          error: `Invalid status '${item.status}' at index ${i}. Must be Pending, InProgress, or Completed`,
          errorType: 'VALIDATION_ERROR',
        };
      }
    }

    // Build summary — include _planArgs so TurnManager can emit PlanUpdate
    // through the platform-agnostic emitEvent() path
    const inProgressStep = plan.find((s) => s.status === StepStatus.InProgress);
    return {
      success: true,
      message: request.explanation
        ? `Plan updated: ${request.explanation}`
        : `Plan updated with ${plan.length} steps`,
      stepCount: plan.length,
      completedCount: plan.filter((s) => s.status === StepStatus.Completed).length,
      pendingCount: plan.filter((s) => s.status === StepStatus.Pending).length,
      inProgressStep: inProgressStep?.step ?? null,
      _planArgs: request,
    };
  }
}
