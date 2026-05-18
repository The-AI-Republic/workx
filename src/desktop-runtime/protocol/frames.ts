import type { Op } from '@/core/protocol/types';
import type { ChannelEvent, SubmissionContext } from '@/core/channels/types';

export type DesktopRuntimeFrame =
  | {
      type: 'hello';
      nonce?: string;
      protocolVersion: number;
      host?: unknown;
    }
  | {
      type: 'hello-ok';
      protocolVersion: number;
      runtimeProfile: 'desktop-runtime';
      pid: number;
    }
  | {
      type: 'request';
      id: string;
      op: Op;
      context?: Partial<SubmissionContext>;
    }
  | {
      type: 'response';
      id: string;
      ok: boolean;
      error?: string;
    }
  | {
      type: 'event';
      event: ChannelEvent;
    }
  | {
      type: 'control-request';
      id: string;
      method: string;
      params?: Record<string, unknown>;
    }
  | {
      type: 'control-response';
      id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'ping';
      id: string;
      ts: number;
    }
  | {
      type: 'pong';
      id: string;
      ts: number;
    }
  | {
      type: 'shutdown';
      reason?: string;
    };

export const DESKTOP_RUNTIME_PROTOCOL_VERSION = 1;
