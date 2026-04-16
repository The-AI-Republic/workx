// File: src/tools/AgentTool/SubAgentRegistry.ts

import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';

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

  constructor(options: { maxConcurrent?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 3;
  }

  /**
   * Atomically check concurrency limit and register a sub-agent.
   * Counts running agents directly to avoid TOCTOU race conditions.
   */
  register(agent: ActiveSubAgent): void {
    let activeCount = 0;
    for (const a of this.activeAgents.values()) {
      if (a.status === 'running') activeCount++;
    }
    if (activeCount >= this.maxConcurrent) {
      throw new Error(`Max concurrent sub-agents (${this.maxConcurrent}) reached`);
    }
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
        console.warn(`[SubAgentRegistry] Error disposing sub-agent ${agent.runId}:`, error);
      }
      agent.status = 'cancelled';
    }));
    this.activeAgents.clear();
  }

  canSpawn(): boolean {
    return this.getActive().length < this.maxConcurrent;
  }

  updateStatus(runId: string, status: ActiveSubAgent['status']): void {
    const agent = this.activeAgents.get(runId);
    if (agent) {
      agent.status = status;
    }
  }
}
