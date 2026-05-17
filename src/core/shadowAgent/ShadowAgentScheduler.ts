import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import { getShadowAgentProfile } from './builtins';
import { createShadowAgentEvent, errorToMessage } from './ShadowAgentEvents';
import { ShadowAgentRunner } from './ShadowAgentRunner';
import {
  type ShadowAgentDiagnostics,
  type ShadowAgentRequest,
  type ShadowAgentResult,
  type ShadowAgentResolvedRequest,
  type ShadowJobSnapshot,
} from './types';

interface Job {
  request: ShadowAgentResolvedRequest;
  abortController: AbortController;
  queuedAt: number;
  startedAt?: number;
  promise: Promise<ShadowAgentResult>;
  resolve: (result: ShadowAgentResult) => void;
  reject: (error: unknown) => void;
}

export class ShadowAgentScheduler {
  private readonly parentEngine: RepublicAgentEngine;
  private readonly runner: ShadowAgentRunner;
  private readonly totalLimit: number;
  private readonly active = new Map<string, Job>();
  private readonly queued: Job[] = [];
  private readonly recent: ShadowAgentResult[] = [];
  private readonly lastFailureByKind: ShadowAgentDiagnostics['lastFailureByKind'] = {};
  private timeoutCount = 0;
  private fallbackCount = 0;
  private stopped = false;

  constructor(options: {
    parentEngine: RepublicAgentEngine;
    runner?: ShadowAgentRunner;
    totalLimit?: number;
  }) {
    this.parentEngine = options.parentEngine;
    this.runner = options.runner ?? new ShadowAgentRunner({ parentEngine: options.parentEngine });
    this.totalLimit = options.totalLimit ?? 2;
  }

  run(request: ShadowAgentRequest): Promise<ShadowAgentResult> {
    if (this.stopped) {
      return Promise.resolve(this.cancelledResult(request, crypto.randomUUID(), 0, 'scheduler stopped'));
    }

    const resolved = this.runner.resolveRequest(
      { ...request, parentEngine: request.parentEngine ?? this.parentEngine },
    );
    const job = this.createJob(resolved);
    this.applyQueuePolicy(job);
    this.pump();
    return job.promise;
  }

  shutdown(): void {
    this.stopped = true;
    for (const job of this.queued.splice(0)) {
      this.finishCancelled(job, 'scheduler shutdown');
    }
    for (const job of this.active.values()) {
      job.abortController.abort();
    }
  }

  diagnostics(): ShadowAgentDiagnostics {
    return {
      active: [...this.active.values()].map((job) => snapshot(job)),
      queued: this.queued.map((job) => snapshot(job)),
      recent: [...this.recent],
      lastFailureByKind: { ...this.lastFailureByKind },
      timeoutCount: this.timeoutCount,
      fallbackCount: this.fallbackCount,
    };
  }

  private createJob(request: ShadowAgentResolvedRequest): Job {
    let resolve!: (result: ShadowAgentResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ShadowAgentResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      request,
      abortController: new AbortController(),
      queuedAt: Date.now(),
      promise,
      resolve,
      reject,
    };
  }

  private applyQueuePolicy(job: Job): void {
    const policy = job.request.queuePolicy ?? getShadowAgentProfile(job.request.kind).queuePolicy;
    const matching = (candidate: Job) =>
      candidate.request.kind === job.request.kind &&
      (!job.request.dedupeKey || candidate.request.dedupeKey === job.request.dedupeKey);

    if (policy === 'drop_duplicate') {
      const duplicate = [...this.active.values(), ...this.queued].find(matching);
      if (duplicate) {
        this.emitCoalesced(job, 'duplicate shadow job dropped');
        duplicate.promise.then(job.resolve, job.reject);
        return;
      }
    }

    if (policy === 'abort_previous') {
      for (const active of this.active.values()) {
        if (active.request.kind === job.request.kind) active.abortController.abort();
      }
      for (let i = this.queued.length - 1; i >= 0; i -= 1) {
        if (this.queued[i].request.kind === job.request.kind) {
          this.finishCancelled(this.queued.splice(i, 1)[0], 'replaced by newer shadow job');
        }
      }
    }

    if (policy === 'coalesce_latest') {
      for (let i = this.queued.length - 1; i >= 0; i -= 1) {
        if (this.queued[i].request.kind === job.request.kind) {
          this.emitCoalesced(this.queued[i], 'replaced by latest shadow job');
          this.finishCancelled(this.queued.splice(i, 1)[0], 'coalesced by newer shadow job');
        }
      }
    }

    this.queued.push(job);
    this.sortQueue();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active.size < this.totalLimit) {
      const index = this.queued.findIndex((job) => this.canStart(job));
      if (index < 0) return;
      const [job] = this.queued.splice(index, 1);
      this.start(job);
    }
  }

  private canStart(job: Job): boolean {
    const profile = getShadowAgentProfile(job.request.kind);
    let activeForKind = 0;
    for (const active of this.active.values()) {
      if (active.request.kind === job.request.kind) activeForKind += 1;
    }
    return activeForKind < profile.maxConcurrency;
  }

  private start(job: Job): void {
    job.startedAt = Date.now();
    this.active.set(job.request.runId, job);
    this.runner.run(job.request, {
      runId: job.request.runId,
      abortSignal: job.abortController.signal,
    }).then(
      (result) => {
        this.active.delete(job.request.runId);
        this.recordResult(result);
        job.resolve(result);
        this.pump();
      },
      (error) => {
        this.active.delete(job.request.runId);
        const result = this.failedResult(job, error);
        this.recordResult(result);
        job.reject(error);
        this.pump();
      },
    );
  }

  private recordResult(result: ShadowAgentResult): void {
    if (result.status === 'timed_out') this.timeoutCount += 1;
    if (result.status === 'fallback_used') this.fallbackCount += 1;
    if (result.status === 'failed' || result.status === 'timed_out') {
      this.lastFailureByKind[result.kind] = result;
    }
    this.recent.unshift(result);
    if (this.recent.length > 20) this.recent.pop();
  }

  private finishCancelled(job: Job, reason: string): void {
    const result = this.cancelledResult(job.request, job.request.runId, Date.now() - job.queuedAt, reason);
    this.recordResult(result);
    job.resolve(result);
  }

  private cancelledResult(
    request: Pick<ShadowAgentRequest, 'kind'>,
    runId: string,
    durationMs: number,
    reason: string,
  ): ShadowAgentResult {
    return {
      kind: request.kind,
      status: 'cancelled',
      error: reason,
      durationMs,
      runId,
    };
  }

  private failedResult(job: Job, error: unknown): ShadowAgentResult {
    return {
      kind: job.request.kind,
      status: 'failed',
      error,
      durationMs: Date.now() - (job.startedAt ?? job.queuedAt),
      runId: job.request.runId,
    };
  }

  private emitCoalesced(job: Job, message: string): void {
    try {
      this.parentEngine.pushEvent(createShadowAgentEvent('ShadowAgentCoalesced', {
        run_id: job.request.runId,
        kind: job.request.kind,
        priority: job.request.priority,
        failure_policy: job.request.failurePolicy,
        parent_engine_id: this.parentEngine.engineId,
        dedupe_key: job.request.dedupeKey,
        message,
      }));
    } catch (error) {
      console.warn('[ShadowAgentScheduler] coalesce event failed:', errorToMessage(error));
    }
  }

  private sortQueue(): void {
    const rank = { immediate: 0, normal: 1, idle: 2 } as const;
    this.queued.sort((a, b) => {
      const byPriority = rank[a.request.priority] - rank[b.request.priority];
      return byPriority || a.queuedAt - b.queuedAt;
    });
  }
}

function snapshot(job: Job): ShadowJobSnapshot {
  return {
    runId: job.request.runId,
    kind: job.request.kind,
    priority: job.request.priority,
    dedupeKey: job.request.dedupeKey,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    timeoutMs: job.request.timeoutMs,
  };
}
