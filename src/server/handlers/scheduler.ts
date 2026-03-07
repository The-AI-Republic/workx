/**
 * Scheduler Method Handlers
 *
 * Handles scheduler.* WebSocket method calls for server mode.
 * Follows sessions.ts handler pattern for job management.
 *
 * @module server/handlers/scheduler
 */

import { registerMethodHandler, type MethodContext } from '@applepi/ws-server';
import { invalidRequest } from '@applepi/ws-server';
import type { Scheduler } from '../../core/scheduler/Scheduler';
import type { ISchedulerStorage } from '../../core/models/types/SchedulerContracts';
import type { JobResultRecord } from '../../core/models/types/Scheduler';

const MAX_INPUT_LENGTH = 50_000;

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
  registerMethodHandler('scheduler.getDraftJobs', handleGetDraftJobs);
  registerMethodHandler('scheduler.getScheduledJobs', handleGetScheduledJobs);
  registerMethodHandler('scheduler.getMissedJobs', handleGetMissedJobs);
  registerMethodHandler('scheduler.getQueue', handleGetQueue);
  registerMethodHandler('scheduler.getArchivedJobs', handleGetArchivedJobs);
  registerMethodHandler('scheduler.getState', handleGetState);
  registerMethodHandler('scheduler.getJobDetails', handleGetJobDetails);

  // New schedule event handlers
  registerMethodHandler('schedule.createEvent', handleCreateEvent);
  registerMethodHandler('schedule.updateEvent', handleUpdateEvent);
  registerMethodHandler('schedule.deleteEvent', handleDeleteEvent);
  registerMethodHandler('schedule.getEventsInRange', handleGetEventsInRange);
  registerMethodHandler('schedule.editInstance', handleEditInstance);
  registerMethodHandler('schedule.deleteInstance', handleDeleteInstance);
  registerMethodHandler('schedule.getExecutionHistory', handleGetExecutionHistory);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function getDeps(): SchedulerHandlerDeps {
  if (!_deps) throw new Error('Scheduler handlers not initialized');
  return _deps;
}

function toJobSummary(job: any) {
  return {
    id: job.id,
    input: job.input.slice(0, 100),
    scheduledTime: job.scheduledTime,
    status: job.status,
    createdAt: job.createdAt,
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
  if (typeof input !== 'string') throw invalidRequest('"input" must be a string');
  if (input.length > MAX_INPUT_LENGTH) throw invalidRequest(`"input" exceeds max length of ${MAX_INPUT_LENGTH} characters`);

  const jobId = await scheduler.createDraftJob(input);
  return { success: true, jobId };
}

async function handleSchedule(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const input = params?.input as string | undefined;
  const jobId = params?.jobId as string | undefined;
  const scheduledTime = params?.scheduledTime as number | undefined;

  if (!scheduledTime) throw invalidRequest('"scheduledTime" is required');
  if (typeof scheduledTime !== 'number' || scheduledTime <= 0) throw invalidRequest('"scheduledTime" must be a positive number');
  if (input !== undefined && typeof input !== 'string') throw invalidRequest('"input" must be a string');
  if (typeof input === 'string' && input.length > MAX_INPUT_LENGTH) throw invalidRequest(`"input" exceeds max length of ${MAX_INPUT_LENGTH} characters`);

  if (jobId) {
    await scheduler.scheduleExistingJob(jobId, scheduledTime);
    return { success: true, jobId };
  } else if (input) {
    const newJobId = await scheduler.scheduleJob(input, scheduledTime);
    return { success: true, jobId: newJobId };
  } else {
    throw invalidRequest('Either "input" or "jobId" is required');
  }
}

async function handleTrigger(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobId = params?.jobId as string;
  if (!jobId) throw invalidRequest('"jobId" is required');

  await scheduler.triggerJob(jobId);
  return { success: true };
}

async function handleCancel(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobId = params?.jobId as string;
  if (!jobId) throw invalidRequest('"jobId" is required');

  await scheduler.cancelJob(jobId);
  return { success: true };
}

async function handleComplete(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobId = params?.jobId as string;
  const result = params?.result as JobResultRecord;
  if (!jobId) throw invalidRequest('"jobId" is required');
  if (!result) throw invalidRequest('"result" is required');
  if (typeof result !== 'object' || typeof (result as any).summary !== 'string') {
    throw invalidRequest('"result" must be an object with a "summary" string field');
  }

  await scheduler.completeJob(jobId, result);
  return { success: true };
}

async function handleFail(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobId = params?.jobId as string;
  const error = params?.error as string;
  if (!jobId) throw invalidRequest('"jobId" is required');
  if (!error) throw invalidRequest('"error" is required');

  await scheduler.failJob(jobId, error);
  return { success: true };
}

async function handlePauseQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  await scheduler.pauseJobQueue();
  return { success: true };
}

async function handleResumeQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  await scheduler.resumeJobQueue();
  return { success: true };
}

async function handleGetDraftJobs(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const jobs = await storage.getDraftJobs();
  return { jobs: jobs.map(toJobSummary) };
}

async function handleGetScheduledJobs(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const jobs = await storage.getScheduledJobs();
  return { jobs: jobs.map(toJobSummary) };
}

async function handleGetMissedJobs(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const jobs = await storage.getMissedJobs();
  return { jobs: jobs.map(toJobSummary) };
}

async function handleGetQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const jobs = await storage.getJobQueueJobs();
  return { jobs: jobs.map(toJobSummary) };
}

async function handleGetArchivedJobs(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const rawLimit = params?.limit;
  const rawOffset = params?.offset;

  // Validate and clamp limit/offset
  const limit = typeof rawLimit === 'number' && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), 200)
    : 50;
  const offset = typeof rawOffset === 'number' && rawOffset >= 0
    ? Math.floor(rawOffset)
    : 0;

  const [jobs, total] = await Promise.all([
    storage.getArchivedJobs(limit, offset),
    storage.getArchivedJobsCount(),
  ]);

  return {
    jobs: jobs.map(j => ({
      id: j.id,
      input: j.input.slice(0, 100),
      scheduledTime: j.scheduledTime,
      completedAt: j.completedAt,
      status: j.status,
      sessionId: j.sessionId,
      error: j.error,
    })),
    total,
    hasMore: offset + jobs.length < total,
  };
}

async function handleGetState(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  return scheduler.getSchedulerState();
}

async function handleGetJobDetails(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { storage } = getDeps();
  const jobId = params?.jobId as string;
  if (!jobId) throw invalidRequest('"jobId" is required');

  const job = await storage.getJob(jobId);
  return { job };
}

// ─────────────────────────────────────────────────────────────────────────
// New Schedule Event Handlers
// ─────────────────────────────────────────────────────────────────────────

async function handleCreateEvent(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();
  if (!scheduleManager) throw new Error('Schedule manager not available');

  const input = params?.input as string;
  const scheduledTime = params?.scheduledTime as number;
  const rrule = (params?.rrule as string) || null;

  if (!input || typeof input !== 'string') throw invalidRequest('"input" is required');
  if (input.length > MAX_INPUT_LENGTH) throw invalidRequest(`Input too long (max ${MAX_INPUT_LENGTH})`);
  if (!scheduledTime || typeof scheduledTime !== 'number') throw invalidRequest('"scheduledTime" is required');

  const event = await scheduleManager.createEvent(input, scheduledTime, rrule);
  return { success: true, eventId: event.id };
}

async function handleUpdateEvent(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();
  if (!scheduleManager) throw new Error('Schedule manager not available');

  const eventId = params?.eventId as string;
  if (!eventId) throw invalidRequest('"eventId" is required');

  const updates = params?.updates as Record<string, unknown> || {};
  await scheduleManager.editSeries(eventId, updates);
  return { success: true };
}

async function handleDeleteEvent(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();
  if (!scheduleManager) throw new Error('Schedule manager not available');

  const eventId = params?.eventId as string;
  if (!eventId) throw invalidRequest('"eventId" is required');

  await scheduleManager.deleteEvent(eventId);
  return { success: true };
}

async function handleGetEventsInRange(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();
  if (!scheduleManager) return { instances: [] };

  const startTime = params?.startTime as number;
  const endTime = params?.endTime as number;

  if (!startTime || !endTime) throw invalidRequest('"startTime" and "endTime" are required');

  const instances = await scheduleManager.getInstancesInRange(startTime, endTime);
  return { instances };
}

async function handleEditInstance(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();
  if (!scheduleManager) throw new Error('Schedule manager not available');

  const scheduleEventId = params?.scheduleEventId as string;
  const instanceTime = params?.instanceTime as number;
  if (!scheduleEventId || !instanceTime) throw invalidRequest('"scheduleEventId" and "instanceTime" are required');

  const overrides = params?.overrides as Record<string, unknown> || {};
  await scheduleManager.editInstance(scheduleEventId, instanceTime, overrides);
  return { success: true };
}

async function handleDeleteInstance(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();
  if (!scheduleManager) throw new Error('Schedule manager not available');

  const scheduleEventId = params?.scheduleEventId as string;
  const instanceTime = params?.instanceTime as number;
  if (!scheduleEventId || !instanceTime) throw invalidRequest('"scheduleEventId" and "instanceTime" are required');

  await scheduleManager.deleteInstance(scheduleEventId, instanceTime);
  return { success: true };
}

async function handleGetExecutionHistory(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobExecutor = scheduler.getJobExecutor();
  if (!jobExecutor) return { executions: [] };

  const scheduleEventId = params?.scheduleEventId as string;
  if (!scheduleEventId) throw invalidRequest('"scheduleEventId" is required');

  const executions = await jobExecutor.getExecutionHistory(scheduleEventId);
  return { executions };
}
