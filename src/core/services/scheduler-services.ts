/**
 * Scheduler Service Handlers
 *
 * Platform-agnostic service handlers for task scheduling.
 * Extracted from extension service-worker setupSchedulerMessageHandlers().
 *
 * @module core/services/scheduler-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface SchedulerServiceDeps {
  scheduler: {
    createDraftTask(input: string): Promise<string>;
    scheduleTask(input: string, scheduledTime: number): Promise<string>;
    scheduleExistingTask(taskId: string, scheduledTime: number): Promise<void>;
    triggerTask(taskId: string): Promise<void>;
    cancelTask(taskId: string): Promise<void>;
    completeTask(taskId: string, result: unknown): Promise<void>;
    failTask(taskId: string, error: string): Promise<void>;
    pauseSchedulerTaskQueue(): Promise<void>;
    resumeSchedulerTaskQueue(): Promise<void>;
    getSchedulerState(): unknown;
  };
  schedulerStorage: {
    getDraftTasks(): Promise<any[]>;
    getScheduledTasks(): Promise<any[]>;
    getMissedTasks(): Promise<any[]>;
    getSchedulerTaskQueueTasks(): Promise<any[]>;
    getArchivedTasks(limit: number, offset: number): Promise<any[]>;
    getTask(taskId: string): Promise<unknown>;
  };
}

function summarizeTask(t: { id: string; input: string; scheduledTime: string; status: string; createdAt: string }) {
  return {
    id: t.id,
    input: t.input.slice(0, 100),
    scheduledTime: t.scheduledTime,
    status: t.status,
    createdAt: t.createdAt,
  };
}

export function createSchedulerServices(deps: SchedulerServiceDeps): Record<string, ServiceHandler> {
  const { scheduler, schedulerStorage } = deps;

  return {
    'scheduler.createDraft': async (params) => {
      const { input } = params as { input: string };
      const taskId = await scheduler.createDraftTask(input);
      return { success: true, taskId };
    },

    'scheduler.schedule': async (params) => {
      const { input, taskId, scheduledTime } = params as {
        input?: string;
        taskId?: string;
        scheduledTime: number;
      };

      if (taskId) {
        await scheduler.scheduleExistingTask(taskId, scheduledTime);
        return { success: true, taskId };
      } else if (input) {
        const newTaskId = await scheduler.scheduleTask(input, scheduledTime);
        return { success: true, taskId: newTaskId };
      } else {
        return { success: false, error: 'Either input or taskId is required' };
      }
    },

    'scheduler.trigger': async (params) => {
      const { taskId } = params as { taskId: string };
      await scheduler.triggerTask(taskId);
      return { success: true };
    },

    'scheduler.cancel': async (params) => {
      const { taskId } = params as { taskId: string };
      await scheduler.cancelTask(taskId);
      return { success: true };
    },

    'scheduler.complete': async (params) => {
      const { taskId, result } = params as { taskId: string; result: unknown };
      await scheduler.completeTask(taskId, result);
      return { success: true };
    },

    'scheduler.fail': async (params) => {
      const { taskId, error } = params as { taskId: string; error: string };
      await scheduler.failTask(taskId, error);
      return { success: true };
    },

    'scheduler.pauseQueue': async () => {
      await scheduler.pauseSchedulerTaskQueue();
      return { success: true };
    },

    'scheduler.resumeQueue': async () => {
      await scheduler.resumeSchedulerTaskQueue();
      return { success: true };
    },

    'scheduler.getDraftTasks': async () => {
      const tasks = await schedulerStorage.getDraftTasks();
      return { tasks: tasks.map(summarizeTask) };
    },

    'scheduler.getScheduledTasks': async () => {
      const tasks = await schedulerStorage.getScheduledTasks();
      return { tasks: tasks.map(summarizeTask) };
    },

    'scheduler.getMissedTasks': async () => {
      const tasks = await schedulerStorage.getMissedTasks();
      return { tasks: tasks.map(summarizeTask) };
    },

    'scheduler.getQueue': async () => {
      const tasks = await schedulerStorage.getSchedulerTaskQueueTasks();
      return { tasks: tasks.map(summarizeTask) };
    },

    'scheduler.getArchivedTasks': async (params) => {
      const { limit = 50, offset = 0 } = params as { limit?: number; offset?: number };
      const tasks = await schedulerStorage.getArchivedTasks(limit, offset);
      return {
        tasks: tasks.map((t) => ({
          id: t.id,
          input: t.input.slice(0, 100),
          scheduledTime: t.scheduledTime,
          completedAt: t.completedAt,
          status: t.status,
          sessionId: t.sessionId,
          error: t.error,
        })),
        total: tasks.length,
        hasMore: tasks.length === limit,
      };
    },

    'scheduler.getState': async () => {
      return scheduler.getSchedulerState();
    },

    'scheduler.getTaskDetails': async (params) => {
      const { taskId } = params as { taskId: string };
      const task = await schedulerStorage.getTask(taskId);
      return { task };
    },
  };
}
