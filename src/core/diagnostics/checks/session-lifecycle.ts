import type { DiagnosticCheck } from '../types';

/** Local lifecycle health snapshot. Contains counts and enums only. */
export const sessionLifecycleCheck: DiagnosticCheck = {
  id: 'session-lifecycle',
  title: 'Session lifecycle',
  platforms: ['extension', 'desktop', 'server'],
  async run(ctx) {
    const status = ctx.lifecycle?.getLifecycleStatus();
    if (!status) {
      return {
        id: 'session-lifecycle',
        title: 'Session lifecycle',
        status: 'warn',
        detail: 'Session lifecycle manager is not available',
      };
    }
    const atHardLimit = status.managedLiveCount + status.reservationCount >= status.hardMax;
    return {
      id: 'session-lifecycle',
      title: 'Session lifecycle',
      status: atHardLimit && status.queuedSessionCount > 0 ? 'warn' : 'pass',
      detail: `${status.lifecycleMode} lifecycle: ${status.liveCount} live, ${status.queuedSubmissionCount} queued`,
      data: { ...status },
    };
  },
};
