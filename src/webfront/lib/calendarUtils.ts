/**
 * Calendar Utilities
 *
 * Maps SchedulerJobRecord and CalendarInstance data to @event-calendar/core event objects.
 */

import type { CalendarInstance, CalendarInstanceStatus } from '@/core/models/types/ScheduleEvent';

export interface CalendarEvent {
  id: string;
  start: Date;
  end: Date;
  title: string;
  backgroundColor: string;
  editable: boolean;
  classNames?: string[];
  extendedProps: {
    job?: { id: string; input: string; scheduledTime: number | null; status: string; createdAt: number; [key: string]: unknown };
    instance?: CalendarInstance;
  };
}

interface JobLike {
  id: string;
  input: string;
  scheduledTime: number | null;
  status: string;
  createdAt: number;
  [key: string]: unknown;
}

const STATUS_COLORS_MODERN: Record<string, string> = {
  scheduled: '#22c55e',
  running: '#3b82f6',
  waiting: '#60a5fa',
  missed: '#eab308',
  failed: '#ef4444',
  completed: '#6b7280',
  cancelled: '#9ca3af',
  draft: '#a78bfa',
  upcoming: '#22c55e',
};

const STATUS_COLORS_TERMINAL: Record<string, string> = {
  scheduled: '#00ff00',
  running: '#00ffff',
  waiting: '#00cccc',
  missed: '#ffff00',
  failed: '#ff4444',
  completed: '#666666',
  cancelled: '#444444',
  draft: '#aa88ff',
  upcoming: '#00ff00',
};

/** Visual duration for calendar event blocks (30 minutes). */
const EVENT_DISPLAY_DURATION_MS = 30 * 60 * 1000;

export function statusToColor(status: string, theme: 'modern' | 'terminal'): string {
  const colors = theme === 'modern' ? STATUS_COLORS_MODERN : STATUS_COLORS_TERMINAL;
  return colors[status] || colors.scheduled;
}

export function isReschedulable(status: string): boolean {
  return ['scheduled', 'missed', 'draft'].includes(status);
}

export function jobToCalendarEvent(job: JobLike, theme: 'modern' | 'terminal'): CalendarEvent | null {
  if (job.scheduledTime == null) return null;
  return {
    id: job.id,
    start: new Date(job.scheduledTime),
    end: new Date(job.scheduledTime + EVENT_DISPLAY_DURATION_MS),
    title: job.input.slice(0, 50),
    backgroundColor: statusToColor(job.status, theme),
    editable: isReschedulable(job.status),
    extendedProps: { job },
  };
}

export function jobsToCalendarEvents(jobs: JobLike[], theme: 'modern' | 'terminal'): CalendarEvent[] {
  return jobs
    .map((job) => jobToCalendarEvent(job, theme))
    .filter((e): e is CalendarEvent => e !== null);
}

// ============================================================================
// CalendarInstance → CalendarEvent mapping (new model)
// ============================================================================

/**
 * Convert a CalendarInstance (from ScheduleManager.getInstancesInRange) to a CalendarEvent.
 * Virtual (future) instances get dashed borders and semi-transparency.
 */
export function instanceToCalendarEvent(
  instance: CalendarInstance,
  theme: 'modern' | 'terminal'
): CalendarEvent {
  const classNames: string[] = [];
  if (instance.isVirtual) {
    classNames.push('ec-virtual-instance');
  }
  if (!instance.enabled) {
    classNames.push('ec-disabled-instance');
  }

  return {
    id: `${instance.scheduleEventId}:${instance.instanceTime}`,
    start: new Date(instance.instanceTime),
    end: new Date(instance.instanceTime + EVENT_DISPLAY_DURATION_MS),
    title: instance.input.slice(0, 50),
    backgroundColor: statusToColor(instance.status, theme),
    editable: instance.status === 'upcoming' && instance.enabled,
    classNames,
    extendedProps: { instance },
  };
}

/**
 * Convert an array of CalendarInstances to CalendarEvents.
 */
export function instancesToCalendarEvents(
  instances: CalendarInstance[],
  theme: 'modern' | 'terminal'
): CalendarEvent[] {
  return instances.map(inst => instanceToCalendarEvent(inst, theme));
}
