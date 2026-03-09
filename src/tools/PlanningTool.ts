/**
 * PlanningTool — Persistent task management with 5 commands
 *
 * Commands:
 *   plan     — Bulk-create tasks from a plan (replaces current plan)
 *   update   — Update status, fields, or dependencies on a single task
 *   list     — List all session tasks (summary view)
 *   get      — Get full task details by ID
 *   get_plan — Retrieve plan context (summary, detail, and all tasks)
 *
 * Persists to StorageProvider via TaskStore. Platform-agnostic.
 */

import { BaseTool, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import type { TaskStore } from '../core/taskmanager/TaskStore';
import type { PlanningCommand } from '../core/taskmanager/types';

const TOOL_DESCRIPTION = `Create and manage task plans for tracking progress on complex tasks.

WHEN TO PLAN:
- Use for tasks with 3 or more steps.
- Skip for simple 1-2 step tasks — execute directly.

RESEARCH FIRST:
- Never call this tool as your first action on a non-trivial task.
- First observe available resources (pages, tools, MCP servers, files) so the plan reflects reality.
- Only compose the plan after you have enough context.

COMMANDS:
- "plan": Create a new plan with tasks. Replaces any existing plan. Include plan_summary (one-line headline), plan_detail (free-form strategy/reasoning), and tasks array.
- "update": Update a single task by taskId. Change status (pending → in_progress → completed), subject, task_description, activeForm, owner, metadata, or add dependency edges (addBlocks, addBlockedBy).
- "list": List all tasks with their current status.
- "get": Get full details of a single task by taskId.
- "get_plan": Retrieve the full plan context including plan_summary, plan_detail, and all tasks. Use when you need to recover plan strategy after many tool calls.`;

/**
 * PlanningTool — command-dispatching persistent task manager
 */
export class PlanningTool extends BaseTool {
  constructor(private taskStore: TaskStore) {
    super();
  }

  protected toolDefinition: ToolDefinition = {
    type: 'function' as const,
    function: {
      name: 'planning_tool',
      description: TOOL_DESCRIPTION,
      strict: false,
      parameters: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            enum: ['plan', 'update', 'list', 'get', 'get_plan'],
            description: 'Operation to perform',
          },
          // "plan" command fields
          plan_summary: {
            type: 'string',
            description: '[plan] One-line summary of the plan goal',
          },
          plan_detail: {
            type: 'string',
            description: '[plan] Free-form strategy: approach, reasoning, assumptions, constraints. Markdown supported.',
          },
          tasks: {
            type: 'array',
            description: '[plan] Tasks to create. Each becomes a tracked task with an ID.',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Imperative title (5-10 words)' },
                task_description: { type: 'string', description: 'Detailed requirements' },
                activeForm: { type: 'string', description: 'Present continuous form for spinner' },
              },
              required: ['subject', 'task_description'],
            },
          },
          // "update" / "get" command fields
          taskId: {
            type: 'string',
            description: '[update, get] Task ID to operate on',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'deleted'],
            description: '[update] New status',
          },
          subject: {
            type: 'string',
            description: '[update] New subject',
          },
          task_description: {
            type: 'string',
            description: '[update] New task_description',
          },
          activeForm: {
            type: 'string',
            description: '[update] New activeForm',
          },
          owner: {
            type: 'string',
            description: '[update] Agent name',
          },
          metadata: {
            type: 'object',
            description: '[update] Merge keys (null deletes)',
          },
          addBlocks: {
            type: 'array',
            items: { type: 'string' },
            description: '[update] Task IDs this task blocks',
          },
          addBlockedBy: {
            type: 'array',
            items: { type: 'string' },
            description: '[update] Task IDs blocking this task',
          },
        },
        required: ['command'],
        additionalProperties: true,
      },
    },
    metadata: {
      capabilities: ['task_planning', 'progress_tracking'],
      platforms: ['extension', 'desktop'],
    },
    category: 'planning',
    version: '2.0.0',
  };

  protected async executeImpl(
    request: any,
    options?: BaseToolOptions,
  ): Promise<any> {
    const sessionId = options?.metadata?.sessionId;
    if (!sessionId) {
      return { success: false, error: 'No session context' };
    }

    const command: PlanningCommand = request.command;

    switch (command) {
      case 'plan':
        return this.executePlan(sessionId, request);
      case 'update':
        return this.executeUpdate(sessionId, request);
      case 'list':
        return this.executeList(sessionId);
      case 'get':
        return this.executeGet(sessionId, request);
      case 'get_plan':
        return this.executeGetPlan(sessionId);
      default:
        return {
          success: false,
          error: `Invalid command '${command}'. Must be: plan, update, list, get, get_plan`,
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------

  private async executePlan(sessionId: string, request: any): Promise<any> {
    if (!Array.isArray(request.tasks) || request.tasks.length === 0) {
      return {
        success: false,
        error: 'plan command requires a non-empty tasks array',
      };
    }

    // Validate each task has required fields
    for (let i = 0; i < request.tasks.length; i++) {
      const t = request.tasks[i];
      if (!t.subject || typeof t.subject !== 'string') {
        return {
          success: false,
          error: `Task at index ${i} must have a non-empty subject string`,
        };
      }
      if (!t.task_description || typeof t.task_description !== 'string') {
        return {
          success: false,
          error: `Task at index ${i} must have a non-empty task_description string`,
        };
      }
    }

    try {
      const result = await this.taskStore.createPlan(sessionId, {
        plan_summary: request.plan_summary,
        plan_detail: request.plan_detail,
        tasks: request.tasks,
      });

      return {
        success: true,
        message: `Plan created: ${result.tasks.length} tasks`,
        taskIds: result.tasks.map((t) => t.id),
        tasks: result.allTasks,
        _taskEvent: {
          eventType: 'plan_created',
          allTasks: result.allTasks,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  private async executeUpdate(sessionId: string, request: any): Promise<any> {
    if (!request.taskId) {
      return {
        success: false,
        error: 'update command requires taskId',
      };
    }

    // Validate status value if provided
    const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'];
    if (request.status !== undefined && !VALID_STATUSES.includes(request.status)) {
      return {
        success: false,
        error: `Invalid status '${request.status}'. Must be: ${VALID_STATUSES.join(', ')}`,
      };
    }

    try {
      const updates: any = {};
      if (request.status !== undefined) updates.status = request.status;
      if (request.subject !== undefined) updates.subject = request.subject;
      if (request.task_description !== undefined) updates.task_description = request.task_description;
      if (request.activeForm !== undefined) updates.activeForm = request.activeForm;
      if (request.owner !== undefined) updates.owner = request.owner;
      if (request.metadata !== undefined) updates.metadata = request.metadata;
      if (request.addBlocks !== undefined) updates.addBlocks = request.addBlocks;
      if (request.addBlockedBy !== undefined) updates.addBlockedBy = request.addBlockedBy;

      const result = await this.taskStore.update(sessionId, request.taskId, updates);

      // Derive eventType from status change
      let eventType = 'updated';
      if (request.status === 'completed') eventType = 'completed';
      else if (request.status === 'deleted') eventType = 'deleted';

      return {
        success: true,
        taskId: result.task.id,
        subject: result.task.subject,
        status: result.task.status,
        _taskEvent: {
          eventType,
          task: {
            id: result.task.id,
            subject: result.task.subject,
            activeForm: result.task.activeForm,
            status: result.task.status,
            blocks: result.task.blocks,
            blockedBy: result.task.blockedBy,
          },
          allTasks: result.allTasks,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  private async executeList(sessionId: string): Promise<any> {
    try {
      const tasks = await this.taskStore.list(sessionId);
      return {
        success: true,
        tasks,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  private async executeGet(sessionId: string, request: any): Promise<any> {
    if (!request.taskId) {
      return {
        success: false,
        error: 'get command requires taskId',
      };
    }

    try {
      const task = await this.taskStore.get(sessionId, request.taskId);
      if (!task) {
        return {
          success: false,
          error: `Task not found: ${request.taskId}`,
        };
      }

      return {
        success: true,
        ...task,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  private async executeGetPlan(sessionId: string): Promise<any> {
    try {
      const plan = await this.taskStore.getPlan(sessionId);
      return {
        success: true,
        ...plan,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }
}
