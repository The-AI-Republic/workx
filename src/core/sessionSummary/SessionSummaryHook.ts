/**
 * SessionSummaryHook
 * ─────────────────────────────────────────────────────────────────────────
 * Owns the full lifecycle of one session's automatic summary extraction:
 *
 *   • A dedicated `SubAgentRegistry` (maxConcurrent: 1) so the extractor
 *     never steals a slot from user-spawned sub-agents.
 *   • A dedicated `SubAgentRunner` configured with
 *     `SESSION_SUMMARY_EXTRACTOR_TYPE` and a `canUseTool` that locks the
 *     extractor to `file_edit` on the exact summary path.
 *   • The post-turn trigger predicate + extraction-in-flight flag.
 *   • A cached `summary.md` content string + prompt-extension registration
 *     so subsequent turns automatically see the summary.
 *   • A manual extraction API for future `/summary`-style commands.
 *
 * Constructed once per Session in `RepublicAgent.initialize()` after the
 * engine is ready. Lifetime is bound to the Session.
 *
 * Mirrors claudy's `services/SessionMemory/sessionMemory.ts` architecture
 * but adapted to browserx's `SubAgentRunner` primitive (see design §4).
 */

import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { FileSystem } from '@/core/memory/types';
import type { ResponseItem } from '@/core/protocol/types';
import {
  registerPromptExtension,
  unregisterPromptExtension,
} from '@/core/PromptLoader';
import { SubAgentRegistry } from '@/tools/AgentTool/SubAgentRegistry';
import { SubAgentRunner } from '@/tools/AgentTool/SubAgentRunner';

import { buildExtractorParams } from './cacheSafeParams';
import {
  isExtractionInFlight,
  markExtractionCompleted,
  markExtractionStarted,
} from './extractionLifecycle';
import {
  SESSION_SUMMARY_EXTRACTOR_TYPE,
} from './extractorType';
import { buildSessionSummaryUpdatePrompt } from './prompts';
import { SessionSummaryFileStore, isSessionSummaryEmpty } from './SessionSummaryFileStore';
import {
  createInitialExtractionState,
  DEFAULT_SESSION_SUMMARY_CONFIG,
  recordExtractionSnapshot,
  type ExtractionState,
  type SessionSummaryConfig,
  shouldExtractSessionSummary,
} from './sessionSummaryUtils';
import { createSummaryFileCanUseTool } from './summaryFileTools';
import { createTelemetryEmitter, type TelemetryEmitter } from './telemetry';
import { truncateSessionSummaryForCompact } from './truncate';

const PROMPT_EXTENSION_NAME = 'session_summary';

export interface SessionSummaryHookOptions {
  sessionId: string;
  parentEngine: RepublicAgentEngine;
  fs: FileSystem;
  memoryRoot: string;
  config?: SessionSummaryConfig;
  telemetry?: TelemetryEmitter;
}

/**
 * Context passed to the post-turn callback. Kept minimal: everything the
 * hook needs is derivable from these four fields.
 */
export interface PostTurnContext {
  sessionId: string;
  history: ResponseItem[];
  totalTokenUsage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
  lastTurnHadToolCalls: boolean;
}

export class SessionSummaryHook {
  private readonly sessionId: string;
  private readonly parentEngine: RepublicAgentEngine;
  private readonly fileStore: SessionSummaryFileStore;
  private readonly config: SessionSummaryConfig;
  private readonly internalRegistry: SubAgentRegistry;
  private readonly runner: SubAgentRunner;
  private readonly telemetry: TelemetryEmitter;

  private state: ExtractionState = createInitialExtractionState();
  private cachedSummary: string = '';
  private attached = false;
  private unregisterPostTurn?: () => void;
  // Track 05b Issue 3: aborted on detach() so in-flight extractions stop
  // updating cache/state on an orphaned instance. Recreated per attach.
  private lifetimeAbort = new AbortController();

  constructor(options: SessionSummaryHookOptions) {
    this.sessionId = options.sessionId;
    this.parentEngine = options.parentEngine;
    this.fileStore = new SessionSummaryFileStore(options.fs, options.memoryRoot);
    this.config = options.config ?? DEFAULT_SESSION_SUMMARY_CONFIG;
    this.telemetry =
      options.telemetry ?? createTelemetryEmitter(options.parentEngine, options.sessionId);

    // Dedicated registry — one extractor at a time, doesn't share slots
    // with user-spawned sub-agents.
    this.internalRegistry = new SubAgentRegistry({
      maxConcurrent: 1,
      maxHistoricalEntries: 5,
    });

    this.runner = new SubAgentRunner({
      parentEngine: this.parentEngine,
      registry: this.internalRegistry,
      customTypes: [SESSION_SUMMARY_EXTRACTOR_TYPE],
    });
  }

  /**
   * Wire the hook into the session's post-turn callback list and prompt
   * extension registry. Idempotent.
   *
   * @param registerPostTurnHook  Session-provided registrar. Returns the
   *   unregister function used by `detach()`.
   */
  async attach(
    registerPostTurnHook: (fn: (ctx: PostTurnContext) => Promise<void>) => () => void,
  ): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    // Fresh abort controller for this attach cycle (detach()→attach() reuse).
    this.lifetimeAbort = new AbortController();

    // Ensure the summary file exists with the canonical template, so first
    // extraction has something to edit and isSessionSummaryEmpty() works.
    try {
      await this.fileStore.ensureScaffold(this.sessionId);
    } catch (err) {
      console.warn(
        '[SessionSummary] failed to ensure scaffold; proceeding without persistence',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Prime the cache once at attach time so the first turn after a resume
    // already sees the prior summary (if any).
    await this.refreshCache();

    // Register the post-turn callback. The Session owns the registry; we get
    // back an unregister thunk for detach().
    this.unregisterPostTurn = registerPostTurnHook((ctx) => this.handlePostTurn(ctx));

    // Register the sync prompt-extension callback. PromptLoader calls it on
    // every loadPrompt(); we return the truncated cached content.
    registerPromptExtension(PROMPT_EXTENSION_NAME, () => this.renderForPrompt());

    this.telemetry.emit('init', {
      config: { ...this.config },
      memoryRoot: this.fileStore.pathFor(this.sessionId),
    });
  }

  /**
   * Tear down. Safe to call multiple times.
   *
   * Aborts any in-flight extraction's polling loop and cache refresh so they
   * don't write to an orphaned instance. The underlying sub-agent run may
   * continue briefly in the background but its result is discarded.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.lifetimeAbort.abort();

    try {
      this.unregisterPostTurn?.();
    } catch (err) {
      console.warn('[SessionSummary] unregisterPostTurn failed', err);
    }
    this.unregisterPostTurn = undefined;

    try {
      unregisterPromptExtension(PROMPT_EXTENSION_NAME);
    } catch (err) {
      console.warn('[SessionSummary] unregisterPromptExtension failed', err);
    }
  }

  /**
   * The post-turn callback. Decides whether to fire the extractor and, if
   * so, spawns it in the background. Never throws — failures are logged via
   * telemetry and swallowed.
   *
   * Track 05b Issue 2: the extraction is intentionally fire-and-forget so
   * the post-turn hook returns immediately and does not delay the next
   * turn. `runExtraction` has its own try/finally for the in-flight flag,
   * and the compaction interlock awaits the flag separately, so correctness
   * does not require this caller to await.
   */
  async handlePostTurn(ctx: PostTurnContext): Promise<void> {
    if (!this.attached) return;
    if (ctx.sessionId !== this.sessionId) return;

    if (
      !shouldExtractSessionSummary({
        history: ctx.history,
        state: this.state,
        lastTurnHadToolCalls: ctx.lastTurnHadToolCalls,
        config: this.config,
      })
    ) {
      return;
    }

    if (isExtractionInFlight(this.sessionId)) {
      // Another extraction is already running for this session — skip; the
      // next eligible turn will pick up where we left off.
      return;
    }

    // Fire-and-forget. `runExtraction` swallows errors internally.
    void this.runExtraction(ctx.history, /*manual*/ false);
  }

  /**
   * Manually trigger an extraction, bypassing the threshold predicate but
   * still respecting the in-flight guard. Returns when the extraction
   * completes (success or failure).
   *
   * Used by future `/summary` slash command and the e2e test harness.
   */
  async manuallyExtractSessionSummary(history: ResponseItem[]): Promise<void> {
    if (isExtractionInFlight(this.sessionId)) return;
    this.telemetry.emit('manual_extraction', { trigger: 'manual' });
    await this.runExtraction(history, /*manual*/ true);
  }

  /**
   * Direct file-store access for the compaction interlock branch (which
   * reads fresh from disk, not from cache, to pick up any extraction that
   * completed while compaction was preparing).
   */
  async readSummaryFromDisk(): Promise<string> {
    return this.fileStore.read(this.sessionId);
  }

  /** Absolute path of this session's summary.md (mostly for telemetry/logging). */
  getSummaryPath(): string {
    return this.fileStore.pathFor(this.sessionId);
  }

  /**
   * Emit a SessionSummaryTelemetry event via this hook's emitter. Public so
   * the compaction interlock in `CompactService` can record its own
   * `compact_with_summary`, `compact_skipped_empty_summary`, and
   * `compact_extraction_wait_timeout` events without reaching into the
   * hook's internals.
   */
  emitTelemetry(
    event: import('@/core/protocol/events').SessionSummaryTelemetryName,
    payload: Record<string, unknown>,
  ): void {
    this.telemetry.emit(event, payload);
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async runExtraction(
    history: ResponseItem[],
    manual: boolean,
  ): Promise<void> {
    markExtractionStarted(this.sessionId);
    const startedAt = Date.now();
    let success = false;
    let error: string | undefined;

    try {
      // Ensure scaffold + read current content. Build the path-locking gate
      // and install it via SubAgentToolParams.canUseTool, which
      // SubAgentRunner.prepare() applies to the child tool registry as a
      // pre-execute check. Defence-in-depth on top of `tools.allow`.
      const summaryPath = await this.fileStore.ensureScaffold(this.sessionId);
      const currentContent = await this.fileStore.read(this.sessionId);
      const gate = createSummaryFileCanUseTool(summaryPath);

      const userPrompt = buildSessionSummaryUpdatePrompt(summaryPath, currentContent);
      const result = await this.runner.run(buildExtractorParams(userPrompt, gate));

      success = 'kind' in result ? result.status === 'launched' : result.success;

      // Background `run()` returns `'launched'` immediately. The actual
      // completion fires through the registry; we need to wait for it
      // before we refresh the cache and clear the flag.
      if ('kind' in result && result.kind === 'background') {
        await this.waitForBackgroundCompletion(result.runId);
      }

      // If detach() fired during the run, don't update cache/state on
      // this orphaned instance.
      if (this.lifetimeAbort.signal.aborted) return;

      // Refresh the in-memory cache from disk. If the extractor's edits
      // failed/no-oped, this is a cheap re-read of the same content.
      await this.refreshCache();
      recordExtractionSnapshot(this.state, history);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.warn('[SessionSummary] extraction failed', error);
    } finally {
      markExtractionCompleted(this.sessionId);
      // Telemetry emit is best-effort and tolerates a disposed engine.
      if (!this.lifetimeAbort.signal.aborted) {
        this.telemetry.emit('extraction', {
          success,
          manual,
          duration_ms: Date.now() - startedAt,
          config: { ...this.config },
          error,
        });
      }
    }
  }

  /**
   * Wait for a background sub-agent run to complete by polling the
   * internal registry. The registry tracks status transitions; once the
   * entry leaves the 'running' state we resolve.
   *
   * Has its own ~15s deadline so a runaway extractor can't block the hook
   * indefinitely (the compaction interlock has a separate 15s deadline of
   * its own — these are independent).
   */
  private async waitForBackgroundCompletion(runId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.lifetimeAbort.signal.aborted) return;
      const entry = this.internalRegistry.get(runId);
      if (!entry || entry.status !== 'running') return;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn(
      `[SessionSummary] extractor run ${runId} exceeded 15s wait; releasing flag`,
    );
  }

  private async refreshCache(): Promise<void> {
    try {
      const fresh = await this.fileStore.read(this.sessionId);
      this.cachedSummary = fresh;
      this.telemetry.emit('file_read', { content_length: fresh.length });
    } catch (err) {
      console.warn(
        '[SessionSummary] cache refresh failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Sync callback consumed by PromptLoader's `appendExtensions()`.
   * Returns the truncated summary, or '' when no meaningful content exists.
   */
  private renderForPrompt(): string {
    if (!this.cachedSummary) return '';
    if (isSessionSummaryEmpty(this.cachedSummary)) return '';
    const truncated = truncateSessionSummaryForCompact(this.cachedSummary);
    this.telemetry.emit('loaded', {
      content_length: truncated.length,
      token_count: Math.ceil(truncated.length / 4),
    });
    return truncated;
  }
}

