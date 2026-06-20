/**
 * Check: the scheduler is firing jobs.
 *
 * `missedCount > 0` means jobs missed their scheduled window — the strongest
 * "scheduler not firing" signal — so it is a fail. A paused scheduler is an
 * unexpected-but-recoverable warn.
 *
 * @module core/diagnostics/checks/scheduler-health
 */

import type {
  DiagnosticCheck,
  DiagnosticContext,
  DiagnosticResult,
} from '../types';

const ID = 'scheduler-health';
const TITLE = 'Scheduler healthy';

export const schedulerHealthCheck: DiagnosticCheck = {
  id: ID,
  title: TITLE,
  platforms: ['extension', 'desktop', 'server'],
  async run(ctx: DiagnosticContext): Promise<DiagnosticResult> {
    if (!ctx.scheduler) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'Scheduler unavailable in this context.',
      };
    }

    const state = await ctx.scheduler.getSchedulerState();

    if (state.missedCount > 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'fail',
        detail: `${state.missedCount} scheduled instance(s) missed their window.`,
        data: {
          missedCount: state.missedCount,
          jobQueueCount: state.jobQueueCount,
          isPaused: state.isPaused,
        },
      };
    }

    if (state.isPaused) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'Scheduler is paused.',
        data: { jobQueueCount: state.jobQueueCount },
      };
    }

    return {
      id: ID,
      title: TITLE,
      status: 'pass',
      detail: `Scheduler running (queue: ${state.jobQueueCount}).`,
      data: { jobQueueCount: state.jobQueueCount },
    };
  },
};
