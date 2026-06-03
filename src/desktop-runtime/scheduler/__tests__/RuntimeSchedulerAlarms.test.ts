/**
 * RuntimeSchedulerAlarms contract test (Track 43 P4 — scheduler-across-restart).
 *
 * The supervisor restarts the runtime on crash. After restart, the new
 * runtime calls `reconcileOnStartup()` which:
 *   - lists OS jobs (via the control bridge → Rust)
 *   - cross-references with the scheduler store
 *   - re-arms in-process timers for jobs still in the store
 *   - removes OS jobs whose source-of-truth row is gone
 *
 * This test runs the reconcile path in-process against a fake control
 * bridge, asserting the contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSchedulerAlarms } from '../RuntimeSchedulerAlarms';
import type { SchedulerOsBridge } from '../../protocol/controlBridge';

function makeFakeBridge(initialJobs: string[] = []): SchedulerOsBridge & {
  registered: Array<{ jobId: string; scheduledTime: number }>;
  removed: string[];
} {
  let osJobs = new Set<string>(initialJobs);
  return {
    registered: [] as Array<{ jobId: string; scheduledTime: number }>,
    removed: [] as string[],
    async register(jobId, scheduledTime) {
      osJobs.add(jobId);
      this.registered.push({ jobId, scheduledTime });
    },
    async remove(jobId) {
      osJobs.delete(jobId);
      this.removed.push(jobId);
    },
    async list() {
      return Array.from(osJobs);
    },
    async has(jobId) {
      return osJobs.has(jobId);
    },
    async clear() {
      osJobs = new Set();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RuntimeSchedulerAlarms', () => {
  it('creates an OS job alongside the in-process timer', async () => {
    const bridge = makeFakeBridge();
    const alarms = new RuntimeSchedulerAlarms(bridge);
    await alarms.createJobAlarm('job-1', Date.now() + 60_000);
    expect(bridge.registered).toEqual([
      expect.objectContaining({ jobId: 'job-1' }),
    ]);
    expect(await alarms.hasJobAlarm('job-1')).toBe(true);
  });

  it('clearJobAlarm removes both the timer and the OS job', async () => {
    const bridge = makeFakeBridge();
    const alarms = new RuntimeSchedulerAlarms(bridge);
    await alarms.createJobAlarm('job-2', Date.now() + 60_000);
    await alarms.clearJobAlarm('job-2');
    expect(bridge.removed).toContain('job-2');
    expect(await alarms.hasJobAlarm('job-2')).toBe(false);
  });

  it('reconcileOnStartup re-arms timers for jobs still in the store', async () => {
    // Simulate a restart: the OS has registered jobs from the previous
    // process. After restart the runtime instance has no in-process timers.
    const bridge = makeFakeBridge(['job-3']);
    const alarms = new RuntimeSchedulerAlarms(bridge);
    await alarms.reconcileOnStartup(async () => [
      { id: 'job-3', scheduledTime: Date.now() + 30_000 },
    ]);
    expect(await alarms.hasJobAlarm('job-3')).toBe(true);
    expect(bridge.registered.some((r) => r.jobId === 'job-3')).toBe(true);
  });

  it('reconcileOnStartup removes orphaned OS jobs (store row gone)', async () => {
    const bridge = makeFakeBridge(['ghost-job']);
    const alarms = new RuntimeSchedulerAlarms(bridge);
    await alarms.reconcileOnStartup(async () => []); // store has no jobs
    expect(bridge.removed).toContain('ghost-job');
    expect(await alarms.hasJobAlarm('ghost-job')).toBe(false);
  });

  it('reconcileOnStartup removes OS jobs whose scheduledTime has passed', async () => {
    const bridge = makeFakeBridge(['stale-job']);
    const alarms = new RuntimeSchedulerAlarms(bridge);
    await alarms.reconcileOnStartup(async () => [
      { id: 'stale-job', scheduledTime: Date.now() - 10_000 },
    ]);
    expect(bridge.removed).toContain('stale-job');
  });

  it('fires the alarm handler when an in-process timer expires', async () => {
    const bridge = makeFakeBridge();
    const alarms = new RuntimeSchedulerAlarms(bridge);
    const handler = vi.fn(async () => undefined);
    alarms.setAlarmHandler(handler);
    await alarms.createJobAlarm('job-4', Date.now() + 1_000);
    vi.advanceTimersByTime(1_001);
    // Flush microtasks so the timer callback runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(expect.stringContaining('job-4'));
  });

  it('dispose() cancels in-process timers without removing OS jobs', async () => {
    const bridge = makeFakeBridge();
    const alarms = new RuntimeSchedulerAlarms(bridge);
    await alarms.createJobAlarm('job-5', Date.now() + 1_000);
    alarms.dispose();
    expect(await alarms.hasJobAlarm('job-5')).toBe(false);
    // OS job is intentionally left in place: it's the across-restart
    // anchor.
    expect(bridge.removed).not.toContain('job-5');
  });
});
