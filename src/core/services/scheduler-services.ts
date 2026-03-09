/**
 * Scheduler Service Handlers
 *
 * Platform-agnostic service handlers for task scheduling.
 * Wraps the Scheduler facade for the ServiceRegistry.
 *
 * @module core/services/scheduler-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { Scheduler } from '@/core/scheduler/Scheduler';
import type { JobResultRecord } from '@/core/models/types/Scheduler';

const MAX_INPUT_LENGTH = 50_000;

export interface SchedulerServiceDeps {
  scheduler: Scheduler;
}

export function createSchedulerServices(deps: SchedulerServiceDeps): Record<string, ServiceHandler> {
  const { scheduler } = deps;

  return {
    // ── Job lifecycle ──────────────────────────────────────────────────

    'scheduler.schedule': async (params) => {
      const input = params?.input as string | undefined;
      const scheduledTime = params?.scheduledTime as number | undefined;
      const recurrence = params?.recurrence as any | undefined;

      if (!scheduledTime || typeof scheduledTime !== 'number' || scheduledTime <= 0) {
        return { success: false, error: '"scheduledTime" must be a positive number' };
      }
      if (!input || typeof input !== 'string') {
        return { success: false, error: '"input" is required and must be a string' };
      }
      if (input.length > MAX_INPUT_LENGTH) {
        return { success: false, error: `"input" exceeds max length of ${MAX_INPUT_LENGTH} characters` };
      }

      const jobId = await scheduler.scheduleJob(input, scheduledTime, recurrence);
      return { success: true, jobId };
    },

    'scheduler.trigger': async (params) => {
      const jobId = params?.jobId as string;
      if (!jobId) return { success: false, error: '"jobId" is required' };
      await scheduler.triggerJob(jobId);
      return { success: true };
    },

    'scheduler.cancel': async (params) => {
      const jobId = params?.jobId as string;
      if (!jobId) return { success: false, error: '"jobId" is required' };
      await scheduler.cancelJob(jobId);
      return { success: true };
    },

    'scheduler.complete': async (params) => {
      const jobId = params?.jobId as string;
      const result = params?.result as JobResultRecord;
      if (!jobId) return { success: false, error: '"jobId" is required' };
      if (!result) return { success: false, error: '"result" is required' };
      await scheduler.completeJob(jobId, result);
      return { success: true };
    },

    'scheduler.fail': async (params) => {
      const jobId = params?.jobId as string;
      const error = params?.error as string;
      if (!jobId) return { success: false, error: '"jobId" is required' };
      if (!error) return { success: false, error: '"error" is required' };
      await scheduler.failJob(jobId, error);
      return { success: true };
    },

    'scheduler.pauseQueue': async () => {
      await scheduler.pauseJobQueue();
      return { success: true };
    },

    'scheduler.resumeQueue': async () => {
      await scheduler.resumeJobQueue();
      return { success: true };
    },

    // ── Queries ────────────────────────────────────────────────────────

    'scheduler.getScheduledJobs': async () => {
      const jobs = await scheduler.getScheduledJobs();
      return { jobs };
    },

    'scheduler.getMissedJobs': async () => {
      const jobs = await scheduler.getMissedJobs();
      return { jobs };
    },

    'scheduler.getQueue': async () => {
      const jobs = await scheduler.getJobQueue();
      return { jobs };
    },

    'scheduler.getArchivedJobs': async (params) => {
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
    },

    'scheduler.getState': async () => {
      return scheduler.getSchedulerState();
    },

    'scheduler.getJobDetails': async (params) => {
      const jobId = params?.jobId as string;
      if (!jobId) return { success: false, error: '"jobId" is required' };
      const job = await scheduler.getJobDetails(jobId);
      return { job };
    },

    'scheduler.reschedule': async (params) => {
      const jobId = params?.jobId as string;
      const scheduledTime = params?.scheduledTime as number;
      if (!jobId) return { success: false, error: '"jobId" is required' };
      if (typeof scheduledTime !== 'number' || scheduledTime <= 0) {
        return { success: false, error: '"scheduledTime" must be a positive number' };
      }
      await scheduler.rescheduleJob(jobId, scheduledTime);
      return { success: true };
    },

    'scheduler.getAllJobsInRange': async (params) => {
      const startTime = params?.startTime as number;
      const endTime = params?.endTime as number;
      if (typeof startTime !== 'number' || typeof endTime !== 'number') {
        return { success: false, error: '"startTime" and "endTime" must be numbers' };
      }
      const jobs = await scheduler.getAllJobsInRange(startTime, endTime);
      return { jobs };
    },

    // ── Schedule Event handlers ────────────────────────────────────────

    'schedule.createEvent': async (params) => {
      const scheduleManager = scheduler.getScheduleManager();
      const input = params?.input as string;
      const scheduledTime = params?.scheduledTime as number;
      const rrule = (params?.rrule as string) || null;

      if (typeof input !== 'string' || !input) return { success: false, error: '"input" is required' };
      if (input.length > MAX_INPUT_LENGTH) return { success: false, error: `Input too long (max ${MAX_INPUT_LENGTH})` };
      if (typeof scheduledTime !== 'number') return { success: false, error: '"scheduledTime" must be a number' };

      const event = await scheduleManager.createEvent(input, scheduledTime, rrule);
      return { success: true, eventId: event.id };
    },

    'schedule.updateEvent': async (params) => {
      const scheduleManager = scheduler.getScheduleManager();
      const eventId = params?.eventId as string;
      if (!eventId) return { success: false, error: '"eventId" is required' };

      const rawUpdates = params?.updates as Record<string, unknown> || {};
      const updates: Record<string, unknown> = {};
      if ('input' in rawUpdates && typeof rawUpdates.input === 'string') {
        if (rawUpdates.input.length > MAX_INPUT_LENGTH) return { success: false, error: `"input" exceeds max length` };
        updates.input = rawUpdates.input;
      }
      if ('scheduledTime' in rawUpdates && typeof rawUpdates.scheduledTime === 'number') updates.scheduledTime = rawUpdates.scheduledTime;
      if ('rrule' in rawUpdates && (typeof rawUpdates.rrule === 'string' || rawUpdates.rrule === null)) updates.rrule = rawUpdates.rrule;
      if ('enabled' in rawUpdates && typeof rawUpdates.enabled === 'boolean') updates.enabled = rawUpdates.enabled;

      await scheduleManager.editSeries(eventId, updates);
      return { success: true };
    },

    'schedule.deleteEvent': async (params) => {
      const scheduleManager = scheduler.getScheduleManager();
      const eventId = params?.eventId as string;
      if (!eventId) return { success: false, error: '"eventId" is required' };
      await scheduleManager.deleteEvent(eventId);
      return { success: true };
    },

    'schedule.getEventsInRange': async (params) => {
      const scheduleManager = scheduler.getScheduleManager();
      const startTime = params?.startTime as number;
      const endTime = params?.endTime as number;

      if (typeof startTime !== 'number' || typeof endTime !== 'number') {
        return { success: false, error: '"startTime" and "endTime" must be numbers' };
      }
      if (endTime <= startTime) return { success: false, error: '"endTime" must be after "startTime"' };

      const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
      const clampedEnd = Math.min(endTime, startTime + MAX_RANGE_MS);

      const instances = await scheduleManager.getInstancesInRange(startTime, clampedEnd);
      return { instances };
    },

    'schedule.editInstance': async (params) => {
      const scheduleManager = scheduler.getScheduleManager();
      const scheduleEventId = params?.scheduleEventId as string;
      const instanceTime = params?.instanceTime as number;
      if (!scheduleEventId) return { success: false, error: '"scheduleEventId" is required' };
      if (typeof instanceTime !== 'number') return { success: false, error: '"instanceTime" must be a number' };

      const rawOverrides = params?.overrides as Record<string, unknown> || {};
      const overrides: Record<string, unknown> = {};
      if ('overrideInput' in rawOverrides && typeof rawOverrides.overrideInput === 'string') overrides.overrideInput = rawOverrides.overrideInput;
      if ('overrideTime' in rawOverrides && typeof rawOverrides.overrideTime === 'number') overrides.overrideTime = rawOverrides.overrideTime;

      await scheduleManager.editInstance(scheduleEventId, instanceTime, overrides);
      return { success: true };
    },

    'schedule.deleteInstance': async (params) => {
      const scheduleManager = scheduler.getScheduleManager();
      const scheduleEventId = params?.scheduleEventId as string;
      const instanceTime = params?.instanceTime as number;
      if (!scheduleEventId) return { success: false, error: '"scheduleEventId" is required' };
      if (typeof instanceTime !== 'number') return { success: false, error: '"instanceTime" must be a number' };

      await scheduleManager.deleteInstance(scheduleEventId, instanceTime);
      return { success: true };
    },

    'schedule.getExecutionHistory': async (params) => {
      const jobExecutor = scheduler.getJobExecutor();
      const scheduleEventId = params?.scheduleEventId as string;
      if (!scheduleEventId) return { success: false, error: '"scheduleEventId" is required' };

      const executions = await jobExecutor.getExecutionHistory(scheduleEventId);
      return { executions };
    },
  };
}
