/**
 * Check: at least one input channel is registered.
 *
 * This is the real signal the server-mode `HealthMonitor` never had — it
 * fabricates every channel as `'connected'`. We do not over-claim liveness
 * we cannot measure; "registered" is the honest bound (zero channels ⇒ the
 * agent can receive no input).
 *
 * @module core/diagnostics/checks/channels-reachable
 */

import type {
  DiagnosticCheck,
  DiagnosticContext,
  DiagnosticResult,
} from '../types';

const ID = 'channels-reachable';
const TITLE = 'Input channels registered';

export const channelsReachableCheck: DiagnosticCheck = {
  id: ID,
  title: TITLE,
  platforms: ['extension', 'desktop', 'server'],
  async run(ctx: DiagnosticContext): Promise<DiagnosticResult> {
    if (!ctx.channelManager) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'Channel manager unavailable in this context.',
      };
    }

    const channels = ctx.channelManager.getChannelInfo();
    if (channels.length === 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'No input channels registered.',
        data: { count: 0 },
      };
    }

    return {
      id: ID,
      title: TITLE,
      status: 'pass',
      detail: `${channels.length} channel(s) registered: ${channels
        .map((c) => c.channelId)
        .join(', ')}.`,
      data: { count: channels.length },
    };
  },
};
