/**
 * PlanningTool - Task Planning and Progress Tracking
 *
 * Enables the LLM agent to create, display, and update task plans with
 * real-time progress tracking. The tool emits PlanUpdate events that
 * the UI layer captures and displays to users.
 */

import { BaseTool, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import { StepStatus, type UpdatePlanArgs, type PlanItemArg } from '../protocol/events';

/**
 * Tool definition constant for LLM discovery
 */
export const PLANNING_TOOL_DEFINITION = {
  name: 'planning_tool',
  description: 'Create and update task plans. You must provide a "plan" array where each item has a "step" description and a "status" (Pending, InProgress, Completed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      explanation: {
        type: 'string',
        description: 'Optional explanation for plan creation/update'
      },
      plan: {
        type: 'array',
        description: 'Ordered list of plan steps',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Step description' },
            status: {
              type: 'string',
              enum: ['Pending', 'InProgress', 'Completed'],
              description: 'Step status'
            }
          },
          required: ['step', 'status']
        }
      }
    },
    required: ['plan']
  }
};

/**
 * PlanningTool Class
 *
 * Extends BaseTool to provide task planning and progress tracking
 * capabilities for the LLM agent.
 */
export class PlanningTool extends BaseTool {
  protected toolDefinition: ToolDefinition = {
    type: 'function' as const,
    function: {
      name: PLANNING_TOOL_DEFINITION.name,
      description: PLANNING_TOOL_DEFINITION.description,
      strict: false,
      parameters: PLANNING_TOOL_DEFINITION.inputSchema as any
    }
  };

  /**
   * Execute the planning tool
   *
   * @param request - UpdatePlanArgs containing optional explanation and plan array
   * @param options - Optional execution options
   * @returns Success response with plan summary or validation error
   */
  protected async executeImpl(
    request: UpdatePlanArgs,
    options?: BaseToolOptions
  ): Promise<any> {
    // Validate plan array exists and is an array
    if (!Array.isArray(request.plan)) {
      return {
        success: false,
        error: 'plan must be an array',
        errorType: 'VALIDATION_ERROR'
      };
    }

    // Validate each step in the plan
    for (let i = 0; i < request.plan.length; i++) {
      const item = request.plan[i];

      // Validate step string exists and is non-empty
      if (!item.step || typeof item.step !== 'string') {
        return {
          success: false,
          error: `Plan item at index ${i} must have a non-empty step string`,
          errorType: 'VALIDATION_ERROR'
        };
      }

      // Validate status is a valid StepStatus enum value
      if (!Object.values(StepStatus).includes(item.status as StepStatus)) {
        return {
          success: false,
          error: `Invalid status '${item.status}' at index ${i}. Must be Pending, InProgress, or Completed`,
          errorType: 'VALIDATION_ERROR'
        };
      }
    }

    // Find the in-progress step (if any) for the response
    const inProgressStep = request.plan.find(
      item => item.status === StepStatus.InProgress
    );

    // Emit PlanUpdate event via Chrome runtime messaging
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      try {
        await chrome.runtime.sendMessage({
          type: 'EVENT',
          payload: {
            id: `evt_plan_${Date.now()}`,
            msg: {
              type: 'PlanUpdate',
              data: request
            }
          }
        });
      } catch (error) {
        // Log but don't fail - the plan update itself succeeded
        console.debug('[PlanningTool] Event emission failed (no listeners):', error);
      }
    }

    // Return success response with plan summary
    return {
      success: true,
      message: request.explanation
        ? `Plan updated: ${request.explanation}`
        : `Plan updated with ${request.plan.length} steps`,
      stepCount: request.plan.length,
      inProgressStep: inProgressStep?.step || null,
      completedCount: request.plan.filter(
        item => item.status === StepStatus.Completed
      ).length,
      pendingCount: request.plan.filter(
        item => item.status === StepStatus.Pending
      ).length
    };
  }
}
