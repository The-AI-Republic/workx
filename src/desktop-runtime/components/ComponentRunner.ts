import path from 'node:path';
import {
  ComponentError,
  type ComponentManager,
  type ComponentRunRequest,
  type ComponentRunResult,
} from '@/core/components';
import { runManagedProcess } from './runManagedProcess';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;

export class ComponentRunner {
  private readonly lifetimeAbort = new AbortController();
  private readonly activeRuns = new Set<Promise<ComponentRunResult>>();

  constructor(private readonly manager: ComponentManager) {}

  run(request: ComponentRunRequest): Promise<ComponentRunResult> {
    const operation = this.runOnce(request);
    this.activeRuns.add(operation);
    operation.then(
      () => this.activeRuns.delete(operation),
      () => this.activeRuns.delete(operation)
    );
    return operation;
  }

  async dispose(): Promise<void> {
    this.lifetimeAbort.abort();
    await Promise.allSettled([...this.activeRuns]);
    this.activeRuns.clear();
  }

  private async runOnce(request: ComponentRunRequest): Promise<ComponentRunResult> {
    if (!path.isAbsolute(request.cwd)) {
      throw new ComponentError(
        'COMPONENT_PATH_INVALID',
        'A managed component requires an absolute working directory.'
      );
    }
    const lease = await this.manager.acquireEntrypoint(request.componentId, request.entrypoint);
    try {
      return await runManagedProcess(lease.executablePath, request.args ?? [], {
        cwd: request.cwd,
        env: {
          ...process.env,
          ...(request.env ?? {}),
          WORKX_COMPONENT_ID: request.componentId,
        },
        stdin: request.stdin,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: request.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT,
        signal: this.combinedSignal(request.signal),
      });
    } finally {
      await lease.release();
    }
  }

  private combinedSignal(external?: AbortSignal): AbortSignal {
    if (!external) return this.lifetimeAbort.signal;
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([external, this.lifetimeAbort.signal]);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    external.addEventListener('abort', abort, { once: true });
    this.lifetimeAbort.signal.addEventListener('abort', abort, { once: true });
    if (external.aborted || this.lifetimeAbort.signal.aborted) controller.abort();
    return controller.signal;
  }
}
