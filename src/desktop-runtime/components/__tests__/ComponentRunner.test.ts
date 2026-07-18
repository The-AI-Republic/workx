import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentManager } from '@/core/components';
import { ComponentRunner } from '../ComponentRunner';

describe('ComponentRunner', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'workx-runner-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  function manager(release = vi.fn(async () => undefined)): ComponentManager {
    return {
      initialize: vi.fn(),
      status: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      install: vi.fn(),
      verify: vi.fn(),
      uninstall: vi.fn(),
      resolveEntrypoint: vi.fn(),
      acquireEntrypoint: vi.fn(async () => ({
        executablePath: process.execPath,
        component: {
          id: 'node',
          displayName: 'Node',
          description: 'fixture',
          version: process.version,
          capabilities: [],
          state: 'installed',
          license: { name: 'MIT', url: 'https://example.test' },
          homepage: 'https://nodejs.org',
        },
        release,
      })),
      dispose: vi.fn(),
    } as unknown as ComponentManager;
  }

  it('runs a catalog-resolved executable without a shell and releases its lease', async () => {
    const release = vi.fn(async () => undefined);
    const runner = new ComponentRunner(manager(release));
    const result = await runner.run({
      componentId: 'node',
      entrypoint: 'node',
      args: ['-e', 'process.stdout.write(process.env.WORKX_COMPONENT_ID ?? "")'],
      cwd,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'node', stderr: '' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('enforces time and output limits while still releasing the lease', async () => {
    const release = vi.fn(async () => undefined);
    const runner = new ComponentRunner(manager(release));
    await expect(
      runner.run({
        componentId: 'node',
        entrypoint: 'node',
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        cwd,
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: 'COMPONENT_EXECUTION_TIMEOUT' });
    expect(release).toHaveBeenCalledTimes(1);

    await expect(
      runner.run({
        componentId: 'node',
        entrypoint: 'node',
        args: ['-e', 'process.stdout.write("x".repeat(1000))'],
        cwd,
        maxOutputBytes: 10,
      })
    ).rejects.toMatchObject({ code: 'COMPONENT_OUTPUT_LIMIT_EXCEEDED' });
  });

  it('rejects relative working directories', async () => {
    const runner = new ComponentRunner(manager());
    await expect(
      runner.run({ componentId: 'node', entrypoint: 'node', cwd: 'relative' })
    ).rejects.toMatchObject({ code: 'COMPONENT_PATH_INVALID' });
  });

  it('cancels active component processes during runtime shutdown', async () => {
    const release = vi.fn(async () => undefined);
    const runner = new ComponentRunner(manager(release));
    const pending = runner.run({
      componentId: 'node',
      entrypoint: 'node',
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'COMPONENT_EXECUTION_FAILED' });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
