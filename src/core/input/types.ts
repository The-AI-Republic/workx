/**
 * Track 13 — Input Pipeline & Browser-Native Mentions: shared types.
 *
 * The funnel is one core module invoked from `RepublicAgent.submitOperation`
 * immediately before `preSubmitHooks`, so it serves the extension, the desktop
 * app, and all three server input sources (WS chat, connector bridges, the
 * scheduler) from a single placement. See
 * `.ai_design/agent_improvements/13_input_pipeline_mentions/design.md` §4.
 */

import type { InputItem } from '../protocol/types';
import type { IPlatformAdapter } from '../platform/IPlatformAdapter';
import type { SubmissionContext } from '../channels/types';
import type { ToolResultStore } from '../../tools/resultStore';

/**
 * Where a submission originated.
 *
 * Drives the bridge-safe slash gate and capability-degradation messaging.
 * `local` = trusted UI / on-host WS chat (gate skipped). `connector`/`remote`
 * = untrusted bridge input (gate applied). `scheduler` = an unattended job.
 */
export interface InputOrigin {
  channel: 'local' | 'connector' | 'remote' | 'scheduler';
  /** Connector/transport type when known (e.g. 'telegram', 'websocket'). */
  channelType?: string;
  channelId?: string;
  userId?: string;
}

/**
 * Everything the funnel needs, supplied by `RepublicAgent.buildFunnelContext`.
 *
 * Phase-2+ capabilities (`resultStore`, `getBrowserController`,
 * `getDomService`) are optional so the funnel degrades gracefully when a
 * platform cannot supply them — an unmet capability becomes a `systemNote`,
 * never a throw.
 */
export interface FunnelContext {
  sessionId: string;
  origin: InputOrigin;
  platform: IPlatformAdapter;
  /** Track 09 store — disk-backs large mention content / pasted images. */
  resultStore?: ToolResultStore;
  /** Resolved tab binding (Submission.context.tabId | UserTurn.tabId). */
  tabId?: number;
}

/**
 * The uniform envelope the funnel returns. The user's `text` item is never
 * rewritten — resolved mentions / screenshots ride alongside as additional
 * `context`/`text`/`image` items (claudy parity: prompt untouched).
 */
export interface ProcessedInput {
  /** Enriched items. Original text preserved; extras appended. */
  items: InputItem[];
  /** false ⇒ handled (slash/bash/blocked) — caller must NOT run an engine turn. */
  shouldQuery: boolean;
  /** Command chaining (e.g. /discover → prefilled next input). */
  nextInput?: string;
  submitNextInput?: boolean;
  /**
   * Graceful-degradation channel surfaced to the user (NOT model-visible).
   * e.g. "@page unavailable — no browser attached" /
   * "/config isn't available over a connector".
   */
  systemNote?: string;
  /** Terminal handled output (slash/bash stdout) for non-interactive replies. */
  resultText?: string;
}

/** Channel types that are trusted on-host surfaces — the gate is skipped. */
const LOCAL_CHANNEL_TYPES = new Set([
  'sidepanel',
  'tabpage',
  'tauri',
  'server',
  'cli',
]);

/**
 * Derive an {@link InputOrigin} from a server {@link SubmissionContext}.
 *
 * Fail-safe for the bridge-safe gate: only well-known on-host surfaces map to
 * `local`; `websocket` is `remote`; anything else (connector ids such as
 * `telegram`/`slack`) is treated as `connector`, so the gate errs toward
 * applying — never toward leaking a raw `/config` to the model.
 */
export function deriveInputOrigin(ctx: SubmissionContext): InputOrigin {
  const channelType = String(ctx.channelType ?? '');
  let channel: InputOrigin['channel'];
  if (LOCAL_CHANNEL_TYPES.has(channelType)) {
    channel = 'local';
  } else if (channelType === 'websocket') {
    channel = 'remote';
  } else {
    channel = 'connector';
  }
  return {
    channel,
    channelType: channelType || undefined,
    channelId: ctx.channelId,
    userId: ctx.userId,
  };
}
