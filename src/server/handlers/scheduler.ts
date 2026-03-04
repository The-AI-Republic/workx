/**
 * Scheduler Method Handlers
 *
 * Handles scheduler.* WebSocket method calls for server mode.
 * Follows sessions.ts handler pattern for job management.
 *
 * @module server/handlers/scheduler
 */

import { registerMethodHandler, type MethodContext } from '@pi/ws-server';
import { invalidRequest, notFound } from '@pi/ws-server';
import type { Scheduler } from '../../core/scheduler/Scheduler';
import type { ISchedulerStorage } from '../../core/models/types/SchedulerContracts';
import type { JobResultRecord } from '../../core/models/types/Scheduler';

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
  const limit = (params?.limit as number) ?? 50;
  const offset = (params?.offset as number) ?? 0;
  const jobs = await storage.getArchivedJobs(limit, offset);
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
    total: jobs.length,
    hasMore: jobs.length === limit,
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
