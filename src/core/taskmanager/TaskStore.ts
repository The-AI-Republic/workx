/**
 * TaskStore — Persistent task management service
 *
 * Platform-agnostic service layer. Takes StorageProvider in constructor.
 * All operations are read-modify-write on a single blob keyed by sessionId.
 *
 * @module core/taskmanager/TaskStore
 */

import type { StorageProvider } from '../storage/StorageProvider';
import type {
  Task,
  TaskSummary,
  TaskStatus,
  SessionPlanData,
} from './types';

export class TaskStore {
  private static readonly COLLECTION = 'tasks';

  constructor(private storage: StorageProvider) {}

  // ---------------------------------------------------------------------------
  // Blob access
  // ---------------------------------------------------------------------------

  /** Load blob from storage. Returns empty default if no plan exists yet. */
  private async load(sessionId: string): Promise<SessionPlanData> {
    const data = await this.storage.get<SessionPlanData>(
      TaskStore.COLLECTION,
      sessionId,
    );
    if (data) return data;

    const now = new Date().toISOString();
    return {
      sessionId,
      nextTaskId: 1,
      tasks: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Write blob to storage. */
  private async save(data: SessionPlanData): Promise<void> {
    data.updatedAt = new Date().toISOString();
    await this.storage.set(TaskStore.COLLECTION, data.sessionId, data);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Replace current plan with new tasks. Returns created tasks.
   * Counter never resets — prevents stale ID collisions.
   */
  async createPlan(
    sessionId: string,
    params: {
      plan_summary?: string;
      plan_detail?: string;
      tasks: Array<{
        subject: string;
        task_description: string;
        activeForm?: string;
      }>;
    },
  ): Promise<{ tasks: Task[]; allTasks: TaskSummary[] }> {
    const blob = await this.load(sessionId);

    const newTasks: Task[] = [];
    let nextId = blob.nextTaskId;

    for (const t of params.tasks) {
      newTasks.push({
        id: String(nextId),
        subject: t.subject,
        task_description: t.task_description,
        activeForm: t.activeForm,
        status: 'pending',
        blocks: [],
        blockedBy: [],
      });
      nextId++;
    }

    blob.nextTaskId = nextId;
    blob.tasks = newTasks;
    blob.plan_summary = params.plan_summary;
    blob.plan_detail = params.plan_detail;
    blob.createdAt = new Date().toISOString();

    await this.save(blob);

    return {
      tasks: newTasks,
      allTasks: this.toSummaries(blob.tasks),
    };
  }

  /**
   * Get a single task by ID from current plan.
   * Returns null for deleted tasks.
   */
  async get(sessionId: string, taskId: string): Promise<Task | null> {
    const blob = await this.load(sessionId);
    const task = blob.tasks.find((t) => t.id === taskId);
    if (!task || task.status === 'deleted') return null;
    return task;
  }

  /**
   * Update a single task in current plan.
   * Supports: status, subject, task_description, activeForm, owner,
   * metadata merge (null deletes), addBlocks, addBlockedBy with cycle detection.
   */
  async update(
    sessionId: string,
    taskId: string,
    updates: {
      status?: TaskStatus;
      subject?: string;
      task_description?: string;
      activeForm?: string;
      owner?: string;
      metadata?: Record<string, unknown>;
      addBlocks?: string[];
      addBlockedBy?: string[];
    },
  ): Promise<{ task: Task; allTasks: TaskSummary[] }> {
    const blob = await this.load(sessionId);
    const task = blob.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Simple field updates
    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.task_description !== undefined) task.task_description = updates.task_description;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
    if (updates.owner !== undefined) task.owner = updates.owner;

    // Metadata merge (null deletes key)
    if (updates.metadata) {
      if (!task.metadata) task.metadata = {};
      for (const [key, value] of Object.entries(updates.metadata)) {
        if (value === null) {
          delete task.metadata[key];
        } else {
          task.metadata[key] = value;
        }
      }
    }

    // Dependency edges — validate + cycle detect before adding
    if (updates.addBlocks) {
      for (const blockedId of updates.addBlocks) {
        const blockedTask = blob.tasks.find((t) => t.id === blockedId);
        if (!blockedTask) {
          throw new Error(`Task not found: ${blockedId}`);
        }
        // Cycle check: would adding taskId → blockedId create a cycle?
        // i.e., can we reach taskId by following blocks from blockedId?
        if (this.wouldCreateCycle(blob.tasks, blockedId, taskId)) {
          throw new Error(`Cycle detected: adding ${taskId} blocks ${blockedId} would create a dependency cycle`);
        }
        if (!task.blocks.includes(blockedId)) {
          task.blocks.push(blockedId);
        }
        if (!blockedTask.blockedBy.includes(taskId)) {
          blockedTask.blockedBy.push(taskId);
        }
      }
    }

    if (updates.addBlockedBy) {
      for (const blockerId of updates.addBlockedBy) {
        const blockerTask = blob.tasks.find((t) => t.id === blockerId);
        if (!blockerTask) {
          throw new Error(`Task not found: ${blockerId}`);
        }
        // Cycle check: would adding blockerId → taskId create a cycle?
        if (this.wouldCreateCycle(blob.tasks, taskId, blockerId)) {
          throw new Error(`Cycle detected: adding ${blockerId} blocks ${taskId} would create a dependency cycle`);
        }
        if (!task.blockedBy.includes(blockerId)) {
          task.blockedBy.push(blockerId);
        }
        if (!blockerTask.blocks.includes(taskId)) {
          blockerTask.blocks.push(taskId);
        }
      }
    }

    // Status change — must come after dependency updates
    if (updates.status !== undefined) {
      task.status = updates.status;

      // Auto-unblock on completion or deletion
      if (updates.status === 'completed' || updates.status === 'deleted') {
        for (const blockedId of task.blocks) {
          const blockedTask = blob.tasks.find((t) => t.id === blockedId);
          if (blockedTask) {
            blockedTask.blockedBy = blockedTask.blockedBy.filter(
              (id) => id !== taskId,
            );
          }
        }
        // Clear stale blocks references on the completed/deleted task itself
        task.blocks = [];
      }
    }

    await this.save(blob);

    return {
      task,
      allTasks: this.toSummaries(blob.tasks),
    };
  }

  /**
   * List all tasks in current plan (summary view).
   * Excludes deleted tasks. blockedBy filtered to open tasks only.
   */
  async list(sessionId: string): Promise<TaskSummary[]> {
    const blob = await this.load(sessionId);
    return this.toSummaries(blob.tasks);
  }

  /**
   * Get full plan context: summary, detail, and all tasks.
   */
  async getPlan(
    sessionId: string,
  ): Promise<{
    plan_summary?: string;
    plan_detail?: string;
    tasks: TaskSummary[];
  }> {
    const blob = await this.load(sessionId);
    return {
      plan_summary: blob.plan_summary,
      plan_detail: blob.plan_detail,
      tasks: this.toSummaries(blob.tasks),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert tasks to summaries. Excludes deleted tasks.
   * blockedBy filtered to only open (non-completed, non-deleted) tasks.
   */
  private toSummaries(tasks: Task[]): TaskSummary[] {
    const completedOrDeleted = new Set(
      tasks
        .filter((t) => t.status === 'completed' || t.status === 'deleted')
        .map((t) => t.id),
    );

    return tasks
      .filter((t) => t.status !== 'deleted')
      .map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy.filter((id) => !completedOrDeleted.has(id)),
      }));
  }

  /**
   * BFS cycle detection.
   * Returns true if adding an edge where `sourceId` blocks `targetId`
   * would create a cycle. Checks whether sourceId can already reach
   * targetId through existing `blocks` edges — if so, adding the
   * reverse direction would close a loop.
   */
  private wouldCreateCycle(
    tasks: Task[],
    sourceId: string,
    targetId: string,
  ): boolean {
    // Self-loop check
    if (sourceId === targetId) return true;

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const queue: string[] = [sourceId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const task = taskMap.get(current);
      if (task) {
        for (const blockedId of task.blocks) {
          if (!visited.has(blockedId)) {
            queue.push(blockedId);
          }
        }
      }
    }

    return false;
  }
}
