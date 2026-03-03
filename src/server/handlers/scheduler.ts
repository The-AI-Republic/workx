/**
 * Scheduler Method Handlers
 *
 * Handles scheduler.* WebSocket method calls for server mode.
 * Follows sessions.ts handler pattern.
 *
 * @module server/handlers/scheduler
 */

import { registerMethodHandler, type MethodContext } from '@pi/ws-server';
import { invalidRequest, notFound } from '@pi/ws-server';
import type { Scheduler } from '../../core/scheduler/Scheduler';
import type { ISchedulerStorage } from '../../core/models/types/SchedulerContracts';
import type { TaskResultRecord } from '../../core/models/types/Scheduler';

// ─────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────

export interface SchedulerHandlerDeps {
  scheduler: Scheduler;
  storage: ISchedulerStorage;
}

let _deps: SchedulerHandlerDeps | null = null;

export function registerSchedulerHandlers(deps: SchedulerHandlerDeps): void {
  _deps = deps;

  registerMethodHandler('scheduler.createDraft', handleCreateDraft);
  registerMethodHandler('scheduler.schedule', handleSchedule);
  registerMethodHandler('scheduler.trigger', handleTrigger);
  registerMethodHandler('scheduler.cancel', handleCancel);
  registerMethodHandler('scheduler.complete', handleComplete);
  registerMethodHandler('scheduler.fail', handleFail);
  registerMethodHandler('scheduler.pauseQueue', handlePauseQueue);
  registerMethodHandler('scheduler.resumeQueue', handleResumeQueue);
  registerMethodHandler('scheduler.getDraftTasks', handleGetDraftTasks);
  registerMethodHandler('scheduler.getScheduledTasks', handleGetScheduledTasks);
  registerMethodHandler('scheduler.getMissedTasks', handleGetMissedTasks);
  registerMethodHandler('scheduler.getQueue', handleGetQueue);
  registerMethodHandler('scheduler.getArchivedTasks', handleGetArchivedTasks);
  registerMethodHandler('scheduler.getState', handleGetState);
  registerMethodHandler('scheduler.getTaskDetails', handleGetTaskDetails);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function getDeps(): SchedulerHandlerDeps {
  if (!_deps) throw new Error('Scheduler handlers not initialized');
  return _deps;
}

function toTaskSummary(task: any) {
  return {
    id: task.id,
    input: task.input.slice(0, 100),
    scheduledTime: task.scheduledTime,
    status: task.status,
    createdAt: task.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────

async function handleCreateDraft(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const input = params?.input as string;
  if (!input) throw invalidRequest('"input" is required');

  const taskId = await scheduler.createDraftTask(input);
  return { success: true, taskId };
}

async function handleSchedule(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const input = params?.input as string | undefined;
  const taskId = params?.taskId as string | undefined;
  const scheduledTime = params?.scheduledTime as number | undefined;

  if (!scheduledTime) throw invalidRequest('"scheduledTime" is required');

  if (taskId) {
    await scheduler.scheduleExistingTask(taskId, scheduledTime);
    return { success: true, taskId };
  } else if (input) {
    const newTaskId = await scheduler.scheduleTask(input, scheduledTime);
    return { success: true, taskId: newTaskId };
  } else {
    throw invalidRequest('Either "input" or "taskId" is required');
  }
}

async function handleTrigger(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const taskId = params?.taskId as string;
  if (!taskId) throw invalidRequest('"taskId" is required');

  await scheduler.triggerTask(taskId);
  return { success: true };
}

async function handleCancel(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const taskId = params?.taskId as string;
  if (!taskId) throw invalidRequest('"taskId" is required');

  await scheduler.cancelTask(taskId);
  return { success: true };
}

async function handleComplete(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const taskId = params?.taskId as string;
  const result = params?.result as TaskResultRecord;
  if (!taskId) throw invalidRequest('"taskId" is required');
  if (!result) throw invalidRequest('"result" is required');

  await scheduler.completeTask(taskId, result);
  return { success: true };
}

async function handleFail(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const taskId = params?.taskId as string;
  const error = params?.error as string;
  if (!taskId) throw invalidRequest('"taskId" is required');
  if (!error) throw invalidRequest('"error" is required');

  await scheduler.failTask(taskId, error);
  return { success: true };
}

async function handlePauseQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  await scheduler.pauseSchedulerTaskQueue();
  return { success: true };
}

async function handleResumeQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  await scheduler.resumeSchedulerTaskQueue();
  return { success: true };
}

async function handleGetDraftTasks(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const tasks = await storage.getDraftTasks();
  return { tasks: tasks.map(toTaskSummary) };
}

async function handleGetScheduledTasks(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const tasks = await storage.getScheduledTasks();
  return { tasks: tasks.map(toTaskSummary) };
}

async function handleGetMissedTasks(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const tasks = await storage.getMissedTasks();
  return { tasks: tasks.map(toTaskSummary) };
}

async function handleGetQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const tasks = await storage.getSchedulerTaskQueueTasks();
  return { tasks: tasks.map(toTaskSummary) };
}

async function handleGetArchivedTasks(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const limit = (params?.limit as number) ?? 50;
  const offset = (params?.offset as number) ?? 0;
  const tasks = await storage.getArchivedTasks(limit, offset);
  return {
    tasks: tasks.map(t => ({
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
}

async function handleGetState(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  return scheduler.getSchedulerState();
}

async function handleGetTaskDetails(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const taskId = params?.taskId as string;
  if (!taskId) throw invalidRequest('"taskId" is required');

  const task = await storage.getTask(taskId);
  return { task };
}
