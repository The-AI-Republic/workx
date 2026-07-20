import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComponentRunner } from '../ComponentRunner';
import { NodeComponentManager } from '../NodeComponentManager';
import { componentPlatform, createBuiltinComponentCatalog } from '../builtinCatalog';
import { resolveWorkXPaths } from '../workxPaths';

describe.runIf(process.env.WORKX_TEST_COMPONENT_DOWNLOAD === 'true')(
  'DuckDB trusted release download (opt-in)',
  () => {
    let root: string;
    let manager: NodeComponentManager;

    beforeAll(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'workx-duckdb-download-'));
      manager = new NodeComponentManager({
        paths: resolveWorkXPaths({ env: { WORKX_HOME: root } }),
        platform: componentPlatform(),
        catalog: createBuiltinComponentCatalog(),
      });
      await manager.initialize();
    });

    afterAll(async () => {
      await manager?.dispose();
      await fs.rm(root, { recursive: true, force: true });
    });

    it('downloads, verifies, executes, and removes the pinned official CLI', async () => {
      expect(componentPlatform()).not.toBeNull();
      const installed = await manager.install('duckdb');
      expect(installed).toMatchObject({
        id: 'duckdb',
        version: '1.5.4',
        state: 'installed',
      });
      expect(await manager.verify('duckdb')).toMatchObject({ state: 'installed' });

      const runner = new ComponentRunner(manager);
      const result = await runner.run({
        componentId: 'duckdb',
        entrypoint: 'duckdb',
        args: ['-version'],
        cwd: root,
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/\bv?1\.5\.4\b/i);

      await manager.uninstall('duckdb');
      expect(await manager.get('duckdb')).toMatchObject({ state: 'not_installed' });
    }, 180_000);
  }
);
