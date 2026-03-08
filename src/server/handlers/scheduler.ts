/**
 * Scheduler Method Handlers
 *
 * Handles scheduler.* WebSocket method calls for server mode.
 * Delegates to Scheduler facade (ScheduleManager + JobExecutor).
 *
 * @module server/handlers/scheduler
 */

import { registerMethodHandler, type MethodContext } from '@applepi/ws-server';
import { invalidRequest } from '@applepi/ws-server';
import type { Scheduler } from '../../core/scheduler/Scheduler';
import type { JobResultRecord } from '../../core/models/types/Scheduler';

const MAX_INPUT_LENGTH = 50_000;

// ─────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────

export interface SchedulerHandlerDeps {
  scheduler: Scheduler;
}

let _deps: SchedulerHandlerDeps | null = null;

export function registerSchedulerHandlers(deps: SchedulerHandlerDeps): void {
  _deps = deps;

  registerMethodHandler('scheduler.schedule', handleSchedule);
  registerMethodHandler('scheduler.trigger', handleTrigger);
  registerMethodHandler('scheduler.cancel', handleCancel);
  registerMethodHandler('scheduler.complete', handleComplete);
  registerMethodHandler('scheduler.fail', handleFail);
  registerMethodHandler('scheduler.pauseQueue', handlePauseQueue);
  registerMethodHandler('scheduler.resumeQueue', handleResumeQueue);
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

// ─────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────

async function handleSchedule(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const input = params?.input as string | undefined;
  const scheduledTime = params?.scheduledTime as number | undefined;
  const recurrence = params?.recurrence as any | undefined;

  if (!scheduledTime) throw invalidRequest('"scheduledTime" is required');
  if (typeof scheduledTime !== 'number' || scheduledTime <= 0) throw invalidRequest('"scheduledTime" must be a positive number');
  if (!input || typeof input !== 'string') throw invalidRequest('"input" is required and must be a string');
  if (input.length > MAX_INPUT_LENGTH) throw invalidRequest(`"input" exceeds max length of ${MAX_INPUT_LENGTH} characters`);

  const newJobId = await scheduler.scheduleJob(input, scheduledTime, recurrence);
  return { success: true, jobId: newJobId };
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

async function handleGetScheduledJobs(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobs = await scheduler.getScheduledJobs();
  return { jobs };
}

async function handleGetMissedJobs(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobs = await scheduler.getMissedJobs();
  return { jobs };
}

async function handleGetQueue(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobs = await scheduler.getJobQueue();
  return { jobs };
}

async function handleGetArchivedJobs(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const rawLimit = params?.limit;
  const rawOffset = params?.offset;
  const sortDirection = params?.sortDirection as 'newest' | 'oldest' | undefined;
  const statusFilter = params?.statusFilter as string[] | undefined;

  const limit = typeof rawLimit === 'number' && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), 200)
    : 50;
  const offset = typeof rawOffset === 'number' && rawOffset >= 0
    ? Math.floor(rawOffset)
    : 0;

  return scheduler.getArchivedJobs(limit, offset, sortDirection, statusFilter);
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
  const { scheduler } = getDeps();
  const jobId = params?.jobId as string;
  if (!jobId) throw invalidRequest('"jobId" is required');

  const job = await scheduler.getJobDetails(jobId);
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

  const input = params?.input as string;
  const scheduledTime = params?.scheduledTime as number;
  const rrule = (params?.rrule as string) || null;

  if (typeof input !== 'string' || !input) throw invalidRequest('"input" is required');
  if (input.length > MAX_INPUT_LENGTH) throw invalidRequest(`Input too long (max ${MAX_INPUT_LENGTH})`);
  if (typeof scheduledTime !== 'number') throw invalidRequest('"scheduledTime" must be a number');
  if (rrule !== null && typeof rrule !== 'string') throw invalidRequest('"rrule" must be a string or null');

  const event = await scheduleManager.createEvent(input, scheduledTime, rrule);
  return { success: true, eventId: event.id };
}

async function handleUpdateEvent(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();

  const eventId = params?.eventId as string;
  if (!eventId) throw invalidRequest('"eventId" is required');

  const rawUpdates = params?.updates as Record<string, unknown> || {};
  const updates: Record<string, unknown> = {};
  if ('input' in rawUpdates && typeof rawUpdates.input === 'string') {
    if (rawUpdates.input.length > MAX_INPUT_LENGTH) throw invalidRequest(`"input" exceeds max length of ${MAX_INPUT_LENGTH} characters`);
    updates.input = rawUpdates.input;
  }
  if ('scheduledTime' in rawUpdates && typeof rawUpdates.scheduledTime === 'number') updates.scheduledTime = rawUpdates.scheduledTime;
  if ('rrule' in rawUpdates && (typeof rawUpdates.rrule === 'string' || rawUpdates.rrule === null)) updates.rrule = rawUpdates.rrule;
  if ('enabled' in rawUpdates && typeof rawUpdates.enabled === 'boolean') updates.enabled = rawUpdates.enabled;

  await scheduleManager.editSeries(eventId, updates);
  return { success: true };
}

async function handleDeleteEvent(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();

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

  const startTime = params?.startTime;
  const endTime = params?.endTime;

  if (typeof startTime !== 'number' || typeof endTime !== 'number') throw invalidRequest('"startTime" and "endTime" must be numbers');
  if (endTime <= startTime) throw invalidRequest('"endTime" must be after "startTime"');

  const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
  const clampedEnd = Math.min(endTime, startTime + MAX_RANGE_MS);

  const instances = await scheduleManager.getInstancesInRange(startTime, clampedEnd);
  return { instances };
}

async function handleEditInstance(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();

  const scheduleEventId = params?.scheduleEventId;
  const instanceTime = params?.instanceTime;
  if (typeof scheduleEventId !== 'string' || !scheduleEventId) throw invalidRequest('"scheduleEventId" is required');
  if (typeof instanceTime !== 'number') throw invalidRequest('"instanceTime" must be a number');

  const rawOverrides = params?.overrides as Record<string, unknown> || {};
  const overrides: Record<string, unknown> = {};
  if ('overrideInput' in rawOverrides && typeof rawOverrides.overrideInput === 'string') overrides.overrideInput = rawOverrides.overrideInput;
  if ('overrideTime' in rawOverrides && typeof rawOverrides.overrideTime === 'number') overrides.overrideTime = rawOverrides.overrideTime;

  await scheduleManager.editInstance(scheduleEventId, instanceTime, overrides);
  return { success: true };
}

async function handleDeleteInstance(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const scheduleManager = scheduler.getScheduleManager();

  const scheduleEventId = params?.scheduleEventId;
  const instanceTime = params?.instanceTime;
  if (typeof scheduleEventId !== 'string' || !scheduleEventId) throw invalidRequest('"scheduleEventId" is required');
  if (typeof instanceTime !== 'number') throw invalidRequest('"instanceTime" must be a number');

  await scheduleManager.deleteInstance(scheduleEventId, instanceTime);
  return { success: true };
}

async function handleGetExecutionHistory(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const { scheduler } = getDeps();
  const jobExecutor = scheduler.getJobExecutor();

  const scheduleEventId = params?.scheduleEventId as string;
  if (!scheduleEventId) throw invalidRequest('"scheduleEventId" is required');

  const executions = await jobExecutor.getExecutionHistory(scheduleEventId);
  return { executions };
}
