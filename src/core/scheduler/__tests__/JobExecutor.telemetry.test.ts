import { describe, it, expect } from 'vitest';
import { JobExecutor, type ExecutionFailureReason } from '../JobExecutor';
import type { IExecutionStorage } from '../../models/types/ScheduleContracts';
import type { ExecutionRecord } from '../../models/types/ScheduleEvent';

/** Minimal in-memory IExecutionStorage for an isolated telemetry test. */
class MemStore implements IExecutionStorage {
  private m = new Map<string, ExecutionRecord>();
  async createExecution(r: ExecutionRecord) {
    this.m.set(r.id, { ...r });
  }
  async getExecution(id: string) {
    return this.m.get(id) ?? null;
  }
  async updateExecution(id: string, u: Partial<ExecutionRecord>) {
    const e = this.m.get(id);
    if (e) this.m.set(id, { ...e, ...u });
  }
  async deleteExecution(id: string) {
    this.m.delete(id);
  }
  async getExecutionsByEvent(s: string) {
    return [...this.m.values()].filter((e) => e.scheduleEventId === s);
  }
  async getExecutionByInstance() {
    return null;
  }
  async getExecutionsByStatus(status: string) {
    return [...this.m.values()].filter((e) => e.status === status);
  }
  async getExecutionsInRange() {
    return [];
  }
  async getLatestExecution() {
    return null;
  }
  async getRunningExecutions() {
    return [...this.m.values()].filter((e) => e.status === 'running');
  }
  async getArchivedExecutions() {
    return [];
  }
  async getArchivedExecutionsCount() {
    return 0;
  }
}

describe('JobExecutor failureReason (Test 2.e — goal-closing)', () => {
  it('a job that aborts at launch carries a machine-readable cause', async () => {
    const exec = new JobExecutor(new MemStore());
    const events: Array<{ status: string; failureReason?: ExecutionFailureReason }> =
      [];
    exec.setEventEmitter((e) => events.push(e));
    exec.setJobLauncher(async () => {
      throw new Error('launch blew up before any turn');
    });

    await exec.execute('sched-1', Date.now(), 'do something');

    const statuses = events.map((e) => e.status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('failed');

    const failed = events.find((e) => e.status === 'failed');
    // The abort is attributable, not an opaque generic 'failed':
    expect(failed?.failureReason).toBe('launcher_error');
  });
});
