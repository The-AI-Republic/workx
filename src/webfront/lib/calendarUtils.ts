/**
 * Calendar Utilities
 *
 * Maps SchedulerJobRecord data to @event-calendar/core event objects.
 */

import type { SchedulerJobStatus } from '@/core/models/types/Scheduler';

export interface CalendarEvent {
  id: string;
  start: Date;
  end: Date;
  title: string;
  backgroundColor: string;
  editable: boolean;
  extendedProps: { job: { id: string; input: string; scheduledTime: number | null; status: SchedulerJobStatus; createdAt: number; [key: string]: unknown } };
}

interface JobLike {
  id: string;
  input: string;
  scheduledTime: number | null;
  status: SchedulerJobStatus;
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
};

export function statusToColor(status: SchedulerJobStatus, theme: 'modern' | 'terminal'): string {
  const colors = theme === 'modern' ? STATUS_COLORS_MODERN : STATUS_COLORS_TERMINAL;
  return colors[status] || colors.scheduled;
}

export function isReschedulable(status: SchedulerJobStatus): boolean {
  return ['scheduled', 'missed', 'draft'].includes(status);
}

export function jobToCalendarEvent(job: JobLike, theme: 'modern' | 'terminal'): CalendarEvent | null {
  if (!job.scheduledTime) return null;
  return {
    id: job.id,
    start: new Date(job.scheduledTime),
    end: new Date(job.scheduledTime + 30 * 60 * 1000),
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
