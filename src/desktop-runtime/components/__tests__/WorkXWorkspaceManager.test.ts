import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkXWorkspaceManager } from '../WorkXWorkspaceManager';
import { resolveWorkXPaths } from '../workxPaths';

describe('WorkXWorkspaceManager', () => {
  let root: string;
  let manager: WorkXWorkspaceManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workx-workspaces-'));
    manager = new WorkXWorkspaceManager(resolveWorkXPaths({ env: { WORKX_HOME: root } }), 1000);
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates private workspaces, refreshes activity, and removes completed work', async () => {
    const workspace = await manager.create('analysis');
    expect(await fs.stat(workspace.path)).toBeTruthy();
    await manager.touch(workspace);
    expect(await manager.sweepStale(Date.now() + 500)).toBe(0);
    await manager.remove(workspace);
    await expect(fs.stat(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sweeps idle same-process workspaces and rejects unsafe kinds', async () => {
    const workspace = await manager.create('analysis');
    expect(await manager.sweepStale(Date.now() + 2000)).toBe(1);
    await expect(fs.stat(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.create('../escape')).rejects.toMatchObject({
      code: 'COMPONENT_PATH_INVALID',
    });
  });
});
