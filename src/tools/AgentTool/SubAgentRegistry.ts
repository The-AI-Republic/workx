// File: src/tools/AgentTool/SubAgentRegistry.ts

import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { AgentContext, SubAgentUsageEntry, SubAgentUsageSummary } from './types';

/** Default cap on retained non-running entries before oldest-first eviction. */
const DEFAULT_HISTORICAL_RETENTION = 50;

/**
 * Tracks an active sub-agent within a parent session
 */
export interface ActiveSubAgent {
  runId: string;
  type: string;
  description: string;
  parentSessionId: string;
  engine: RepublicAgentEngine;
  startTime: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /**
   * Set when the status transitions away from 'running'. Used as the eviction
   * ordering key when historical retention exceeds the cap.
   */
  endTime?: number;
  /**
   * Back-reference to the runner's context — used by external cancellation
   * paths (e.g. cancel_sub_agent) to set `context.cancelled = true` before
   * disposing the engine so the detached background handler skips the
   * task-notification injection. Optional because the registry may be used
   * by callers that don't go through the runner pipeline (e.g. tests).
   */
  context?: AgentContext;
}

/**
 * SubAgentRegistry tracks active sub-agent runs within a parent session.
 *
 * Responsibilities:
 * - Track active sub-agents per parent session
 * - Enforce concurrency limits
 * - Cancel all sub-agents when parent session ends
 * - Provide status queries
 *
 * NOT a singleton — one per parent agent instance.
 */
export class SubAgentRegistry {
  private activeAgents = new Map<string, ActiveSubAgent>();
  private readonly maxConcurrent: number;
  private readonly maxHistoricalEntries: number;
  private usageRecords: SubAgentUsageEntry[] = [];
  private pendingMessages = new Map<string, string[]>();
  private onError?: (msg: string, error: unknown) => void;

  constructor(options: {
    maxConcurrent?: number;
    maxHistoricalEntries?: number;
    onError?: (msg: string, error: unknown) => void;
  } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.maxHistoricalEntries = options.maxHistoricalEntries ?? DEFAULT_HISTORICAL_RETENTION;
    this.onError = options.onError;
  }

  /**
   * Atomically check concurrency limit and register a sub-agent.
   * Counts running agents directly to avoid TOCTOU race conditions.
   * Evicts oldest non-running entries if historical retention is at the cap.
   */
  register(agent: ActiveSubAgent): void {
    let activeCount = 0;
    for (const a of this.activeAgents.values()) {
      if (a.status === 'running') activeCount++;
    }
    if (activeCount >= this.maxConcurrent) {
      throw new Error(`Max concurrent sub-agents (${this.maxConcurrent}) reached`);
    }
    this.evictHistoricalIfNeeded();
    this.activeAgents.set(agent.runId, agent);
  }

  unregister(runId: string): void {
    this.activeAgents.delete(runId);
  }

  get(runId: string): ActiveSubAgent | undefined {
    return this.activeAgents.get(runId);
  }

  getActive(): ActiveSubAgent[] {
    return Array.from(this.activeAgents.values())
      .filter(a => a.status === 'running');
  }

  getAll(): ActiveSubAgent[] {
    return Array.from(this.activeAgents.values());
  }

  async cancelAll(): Promise<void> {
    const running = this.getActive();
    await Promise.all(running.map(async (agent) => {
      try {
        await agent.engine.dispose();
      } catch (error) {
        this.reportError(`Error disposing sub-agent ${agent.runId}`, error);
      }
      agent.status = 'cancelled';
      agent.endTime = Date.now();
      // Delete only the snapshotted runId — concurrent register() during the
      // await above must not have its entry erased.
      this.activeAgents.delete(agent.runId);
      this.pendingMessages.delete(agent.runId);
    }));
  }

  canSpawn(): boolean {
    return this.getActive().length < this.maxConcurrent;
  }

  updateStatus(runId: string, status: ActiveSubAgent['status']): void {
    const agent = this.activeAgents.get(runId);
    if (agent) {
      agent.status = status;
      if (status !== 'running' && agent.endTime === undefined) {
        agent.endTime = Date.now();
      }
    }
  }

  /**
   * Evict oldest non-running historical entries when retention is at the cap.
   * Running entries are never evicted (they're load-bearing for management
   * tools); only completed/failed/cancelled tombstones are recycled.
   */
  private evictHistoricalIfNeeded(): void {
    const tombstones: ActiveSubAgent[] = [];
    for (const a of this.activeAgents.values()) {
      if (a.status !== 'running') tombstones.push(a);
    }
    if (tombstones.length < this.maxHistoricalEntries) return;
    tombstones.sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
    const toEvict = tombstones.length - this.maxHistoricalEntries + 1;
    for (let i = 0; i < toEvict; i++) {
      const victim = tombstones[i];
      this.activeAgents.delete(victim.runId);
      this.pendingMessages.delete(victim.runId);
    }
  }

  /**
   * Report an error via the configured callback. Falls back to a silent drop
   * if no callback is wired — callers that care about disposal errors must
   * provide an `onError` callback at construction time.
   */
  private reportError(msg: string, error: unknown): void {
    if (this.onError) {
      this.onError(msg, error);
    }
  }

  /**
   * Record token usage for a sub-agent run.
   */
  recordUsage(entry: SubAgentUsageEntry): void {
    this.usageRecords.push(entry);
  }

  /**
   * Get aggregated token usage across all recorded sub-agent runs.
   */
  getUsageSummary(): SubAgentUsageSummary {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const entry of this.usageRecords) {
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      byAgent: [...this.usageRecords],
    };
  }

  /**
   * Queue a cross-agent message for a running sub-agent.
   * The message will be drained and injected into the sub-agent's next turn.
   */
  queueMessage(runId: string, message: string): void {
    const agent = this.activeAgents.get(runId);
    if (!agent) {
      throw new Error(`No sub-agent found with runId: ${runId}`);
    }
    if (agent.status !== 'running') {
      throw new Error(`Sub-agent ${runId} is not running (status: ${agent.status})`);
    }
    const queue = this.pendingMessages.get(runId) ?? [];
    queue.push(message);
    this.pendingMessages.set(runId, queue);
  }

  /**
   * Drain and return all pending messages for a sub-agent.
   * Clears the queue after draining.
   */
  drainMessages(runId: string): string[] {
    const messages = this.pendingMessages.get(runId) ?? [];
    this.pendingMessages.delete(runId);
    return messages;
  }
}
