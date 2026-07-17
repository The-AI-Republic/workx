import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ComponentError } from '@/core/components';
import type { WorkXPaths } from './workxPaths';

const MARKER = '.workx-workspace.json';
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface WorkspaceMarker {
  schemaVersion: 1;
  id: string;
  kind: string;
  ownerPid: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface WorkXWorkspace {
  id: string;
  kind: string;
  path: string;
  createdAt: string;
}

export class WorkXWorkspaceManager {
  private readonly owned = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly paths: WorkXPaths,
    private readonly idleTtlMs = DEFAULT_IDLE_TTL_MS
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.paths.workspaces, { recursive: true });
    await this.sweepStale();
    this.sweepTimer = setInterval(() => {
      void this.sweepStale().catch(() => undefined);
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  async create(kind: string): Promise<WorkXWorkspace> {
    if (!SEGMENT_PATTERN.test(kind)) {
      throw new ComponentError('COMPONENT_PATH_INVALID', 'Workspace kind is invalid.');
    }
    const id = randomUUID();
    const workspacePath = this.workspacePath(kind, id);
    const now = new Date().toISOString();
    const marker: WorkspaceMarker = {
      schemaVersion: 1,
      id,
      kind,
      ownerPid: process.pid,
      createdAt: now,
      lastActivityAt: now,
    };
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.mkdir(workspacePath, { recursive: false });
    await fs.writeFile(path.join(workspacePath, MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    this.owned.add(workspacePath);
    return { id, kind, path: workspacePath, createdAt: now };
  }

  async touch(workspace: Pick<WorkXWorkspace, 'id' | 'kind'>): Promise<void> {
    const workspacePath = this.workspacePath(workspace.kind, workspace.id);
    const marker = await this.readMarker(workspacePath);
    if (!marker || marker.id !== workspace.id || marker.kind !== workspace.kind) {
      throw new ComponentError('COMPONENT_PATH_INVALID', 'Workspace marker is missing or invalid.');
    }
    marker.lastActivityAt = new Date().toISOString();
    await fs.writeFile(path.join(workspacePath, MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async remove(workspace: Pick<WorkXWorkspace, 'id' | 'kind'>): Promise<void> {
    const workspacePath = this.workspacePath(workspace.kind, workspace.id);
    this.owned.delete(workspacePath);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  async sweepStale(now = Date.now()): Promise<number> {
    let removed = 0;
    const kinds = await fs.readdir(this.paths.workspaces, { withFileTypes: true }).catch(() => []);
    for (const kind of kinds) {
      if (!kind.isDirectory() || !SEGMENT_PATTERN.test(kind.name)) continue;
      const kindPath = path.join(this.paths.workspaces, kind.name);
      const entries = await fs.readdir(kindPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const workspacePath = path.join(kindPath, entry.name);
        const marker = await this.readMarker(workspacePath);
        if (!marker) continue;
        const lastActivity = Date.parse(marker.lastActivityAt);
        if (!Number.isFinite(lastActivity) || now - lastActivity <= this.idleTtlMs) continue;
        if (marker.ownerPid !== process.pid && this.processIsAlive(marker.ownerPid)) continue;
        await fs.rm(workspacePath, { recursive: true, force: true });
        this.owned.delete(workspacePath);
        removed++;
      }
      const remaining = await fs.readdir(kindPath).catch(() => ['unknown']);
      if (remaining.length === 0) await fs.rmdir(kindPath).catch(() => undefined);
    }
    return removed;
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.allSettled(
      [...this.owned].map((workspacePath) => fs.rm(workspacePath, { recursive: true, force: true }))
    );
    this.owned.clear();
  }

  private workspacePath(kind: string, id: string): string {
    if (!SEGMENT_PATTERN.test(kind) || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ComponentError('COMPONENT_PATH_INVALID', 'Workspace identity is invalid.');
    }
    const base = path.resolve(this.paths.workspaces);
    const target = path.resolve(base, kind, id);
    if (!target.startsWith(`${base}${path.sep}`)) {
      throw new ComponentError('COMPONENT_PATH_INVALID', 'Workspace path escapes WorkX home.');
    }
    return target;
  }

  private async readMarker(workspacePath: string): Promise<WorkspaceMarker | null> {
    try {
      const raw = await fs.readFile(path.join(workspacePath, MARKER), 'utf8');
      const marker = JSON.parse(raw) as WorkspaceMarker;
      if (marker.schemaVersion !== 1 || typeof marker.ownerPid !== 'number') return null;
      return marker;
    } catch {
      return null;
    }
  }

  private processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
