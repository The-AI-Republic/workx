import { getConfigStorage, type ConfigStorageProvider } from '../storage/ConfigStorageProvider';
import type { AppLocalState, AppManifest, AppSyncQueueItem, InstalledAppRecord } from './types';

const STORAGE_KEY = 'appStore.local';
const SCHEMA_VERSION = 1;

function now(): number {
  return Date.now();
}

function createEmptyState(): AppLocalState {
  return {
    schemaVersion: SCHEMA_VERSION,
    installedApps: {},
    manifests: {},
    metadataMarkdown: {},
    syncQueue: [],
  };
}

function normalizeState(state: AppLocalState | null): AppLocalState {
  if (!state) {
    return createEmptyState();
  }

  return {
    schemaVersion: state.schemaVersion || SCHEMA_VERSION,
    deviceId: state.deviceId,
    installedApps: state.installedApps ?? {},
    manifests: state.manifests ?? {},
    metadataMarkdown: state.metadataMarkdown ?? {},
    syncQueue: state.syncQueue ?? [],
  };
}

export class AppLocalStore {
  // Serializes read-modify-write critical sections against this instance. The
  // whole store is a single storage blob, so concurrent flows (sync-queue
  // drain, activation status patches, installs) would otherwise each read the
  // old blob and the last writer would silently clobber the others.
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: ConfigStorageProvider = getConfigStorage()) {}

  async getState(): Promise<AppLocalState> {
    return normalizeState(await this.storage.get<AppLocalState>(STORAGE_KEY));
  }

  private async saveState(state: AppLocalState): Promise<void> {
    await this.storage.set(STORAGE_KEY, {
      ...state,
      schemaVersion: SCHEMA_VERSION,
    });
  }

  /** Run a read-modify-write op exclusively, chained after any in-flight write. */
  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeLock.then(op, op);
    // Keep the lock chain alive across both success and failure without
    // leaking unhandled rejections; the original `run` still rejects to caller.
    this.writeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async mutate(mutator: (state: AppLocalState) => void): Promise<AppLocalState> {
    return this.runExclusive(async () => {
      const state = await this.getState();
      mutator(state);
      await this.saveState(state);
      return state;
    });
  }

  async getDeviceId(): Promise<string> {
    const existing = (await this.getState()).deviceId;
    if (existing) {
      return existing;
    }

    return this.runExclusive(async () => {
      // Re-read inside the lock so two concurrent callers can't each generate
      // (and persist) a different device id.
      const state = await this.getState();
      if (state.deviceId) {
        return state.deviceId;
      }
      const deviceId = globalThis.crypto?.randomUUID?.() ?? `device_${Math.random().toString(36).slice(2)}_${now()}`;
      state.deviceId = deviceId;
      await this.saveState(state);
      return deviceId;
    });
  }

  async listInstalledApps(): Promise<InstalledAppRecord[]> {
    const state = await this.getState();
    return Object.values(state.installedApps).filter(app => app.installState === 'installed');
  }

  async getInstalledApp(appId: string): Promise<InstalledAppRecord | null> {
    const state = await this.getState();
    const record = state.installedApps[appId];
    return record?.installState === 'installed' ? record : null;
  }

  async upsertInstalledApp(record: InstalledAppRecord): Promise<void> {
    await this.mutate(state => {
      state.installedApps[record.appId] = {
        ...record,
        updatedAt: now(),
      };
    });
  }

  async patchInstalledApp(appId: string, patch: Partial<InstalledAppRecord>): Promise<InstalledAppRecord | null> {
    let updated: InstalledAppRecord | null = null;
    await this.mutate(state => {
      const current = state.installedApps[appId];
      if (!current) {
        return;
      }
      updated = {
        ...current,
        ...patch,
        appId: current.appId,
        updatedAt: now(),
      };
      state.installedApps[appId] = updated;
    });
    return updated;
  }

  async removeInstalledApp(appId: string): Promise<void> {
    await this.mutate(state => {
      delete state.installedApps[appId];
    });
  }

  async saveManifest(appId: string, manifest: AppManifest): Promise<void> {
    await this.mutate(state => {
      state.manifests[appId] = manifest;
    });
  }

  async getManifest(appId: string): Promise<AppManifest | null> {
    const state = await this.getState();
    return state.manifests[appId] ?? null;
  }

  async deleteManifest(appId: string): Promise<void> {
    await this.mutate(state => {
      delete state.manifests[appId];
    });
  }

  async saveMetadataMarkdown(appId: string, markdown: string): Promise<void> {
    await this.mutate(state => {
      state.metadataMarkdown[appId] = markdown;
    });
  }

  async getMetadataMarkdown(appId: string): Promise<string | null> {
    const state = await this.getState();
    return state.metadataMarkdown[appId] ?? null;
  }

  async deleteMetadataMarkdown(appId: string): Promise<void> {
    await this.mutate(state => {
      delete state.metadataMarkdown[appId];
    });
  }

  async listMetadataEntries(): Promise<Array<{ appId: string; manifest: AppManifest; metadataMarkdown: string; install: InstalledAppRecord }>> {
    const state = await this.getState();
    const entries: Array<{ appId: string; manifest: AppManifest; metadataMarkdown: string; install: InstalledAppRecord }> = [];

    for (const install of Object.values(state.installedApps)) {
      if (install.installState !== 'installed') {
        continue;
      }
      const manifest = state.manifests[install.appId];
      const metadataMarkdown = state.metadataMarkdown[install.appId];
      if (manifest && metadataMarkdown) {
        entries.push({ appId: install.appId, manifest, metadataMarkdown, install });
      }
    }

    return entries;
  }

  async enqueueSync(item: Omit<AppSyncQueueItem, 'id' | 'createdAt'>): Promise<void> {
    await this.mutate(state => {
      state.syncQueue.push({
        ...item,
        id: globalThis.crypto?.randomUUID?.() ?? `sync_${now()}_${Math.random().toString(36).slice(2)}`,
        createdAt: now(),
        attempts: item.attempts ?? 0,
        nextAttemptAt: item.nextAttemptAt ?? now(),
      });
    });
  }

  async listSyncQueue(): Promise<AppSyncQueueItem[]> {
    const state = await this.getState();
    return state.syncQueue;
  }

  async removeSyncQueueItem(id: string): Promise<void> {
    await this.mutate(state => {
      state.syncQueue = state.syncQueue.filter(item => item.id !== id);
    });
  }

  async recordSyncQueueFailure(id: string, error: string): Promise<void> {
    const timestamp = now();
    await this.mutate(state => {
      state.syncQueue = state.syncQueue.map(item => {
        if (item.id !== id) {
          return item;
        }
        const attempts = (item.attempts ?? 0) + 1;
        const delayMs = Math.min(60 * 60_000, 2 ** Math.min(attempts, 6) * 1_000);
        return {
          ...item,
          attempts,
          lastAttemptAt: timestamp,
          nextAttemptAt: timestamp + delayMs,
          lastError: error,
        };
      });
    });
  }
}

export function createInstalledRecord(manifest: AppManifest, patch: Partial<InstalledAppRecord> = {}): InstalledAppRecord {
  const timestamp = now();
  return {
    appId: manifest.appId,
    slug: manifest.slug,
    name: manifest.name,
    version: manifest.version,
    installState: 'installed',
    enabled: true,
    priority: 2,
    connectionStatus: manifest.auth?.type && manifest.auth.type !== 'none' ? 'needs_auth' : 'ready',
    installedAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}
