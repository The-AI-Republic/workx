import { AppCredentialStore } from './credentials/AppCredentialStore';
import { AppLocalStore, createInstalledRecord } from './AppLocalStore';
import { AppMarketplaceClient } from './AppMarketplaceClient';
import type { AppConnectionStatus, AppManifest, AppSyncResult, InstalledAppRecord } from './types';

export const MAX_PINNED_APPS = 10;

export class AppInstallService {
  constructor(
    private readonly marketplace: AppMarketplaceClient,
    private readonly store: AppLocalStore = new AppLocalStore(),
    private readonly credentials: AppCredentialStore = new AppCredentialStore(),
  ) {}

  async install(appId: string): Promise<InstalledAppRecord> {
    const deviceId = await this.store.getDeviceId();
    const manifest = await this.marketplace.getManifest(appId);
    const metadata = await this.marketplace.getMetadataMarkdown(appId);

    await this.marketplace.install(appId, deviceId);
    await this.store.saveManifest(appId, manifest);
    await this.store.saveMetadataMarkdown(appId, metadata);

    const existing = await this.store.getInstalledApp(appId);
    const record = createInstalledRecord(manifest, {
      priority: existing?.priority ?? 2,
      enabled: existing?.enabled ?? true,
      credentialRef: existing?.credentialRef,
    });
    await this.store.upsertInstalledApp(record);
    await this.reportStatus(appId, record.connectionStatus);
    return record;
  }

  async installFromManifest(manifest: AppManifest, metadataMarkdown: string): Promise<InstalledAppRecord> {
    await this.store.saveManifest(manifest.appId, manifest);
    await this.store.saveMetadataMarkdown(manifest.appId, metadataMarkdown);

    const existing = await this.store.getInstalledApp(manifest.appId);
    const patch: Partial<InstalledAppRecord> = {
      priority: existing?.priority ?? 2,
      enabled: existing?.enabled ?? true,
      credentialRef: existing?.credentialRef,
      runtimeServerId: existing?.runtimeServerId,
      runtimeServerName: existing?.runtimeServerName,
    };
    if (existing?.connectionStatus) {
      patch.connectionStatus = existing.connectionStatus;
    }
    const record = createInstalledRecord(manifest, patch);
    await this.store.upsertInstalledApp(record);
    return record;
  }

  async syncFromCloud(): Promise<AppSyncResult> {
    const deviceId = await this.store.getDeviceId();
    const queueResult = await this.drainSyncQueue(deviceId);
    const remoteInstallations = await this.marketplace.listInstallations(deviceId);
    const activeRemoteAppIds = new Set(
      remoteInstallations
        .filter(remote => remote.status === 'installed' && remote.enabled)
        .map(remote => remote.appId),
    );
    const pulled: string[] = [];
    const removed: string[] = [];

    for (const remote of remoteInstallations) {
      if (remote.status !== 'installed' || !remote.enabled) {
        continue;
      }

      const local = await this.store.getInstalledApp(remote.appId);
      const manifest = local ? await this.store.getManifest(remote.appId) : null;
      const metadata = local ? await this.store.getMetadataMarkdown(remote.appId) : null;
      const shouldPull = !local || !manifest || !metadata || local.version !== remote.version;

      if (shouldPull) {
        const freshManifest = await this.marketplace.getManifest(remote.appId);
        const freshMetadata = await this.marketplace.getMetadataMarkdown(remote.appId);
        const record = createInstalledRecord(freshManifest, {
          enabled: remote.enabled,
          priority: remote.priority,
          connectionStatus: normalizeRemoteDeviceStatus(remote.deviceStatus, freshManifest, local?.connectionStatus),
        });
        await this.store.saveManifest(remote.appId, freshManifest);
        await this.store.saveMetadataMarkdown(remote.appId, freshMetadata);
        await this.store.upsertInstalledApp(record);
        pulled.push(remote.appId);
      } else {
        await this.store.patchInstalledApp(remote.appId, {
          enabled: remote.enabled,
          priority: remote.priority,
          connectionStatus: normalizeRemoteDeviceStatus(remote.deviceStatus, manifest, local.connectionStatus),
        });
      }
    }

    const localInstallations = await this.store.listInstalledApps();
    for (const local of localInstallations) {
      if (activeRemoteAppIds.has(local.appId)) {
        continue;
      }
      await this.credentials.deleteAppSecrets(local.appId);
      await this.store.deleteManifest(local.appId);
      await this.store.deleteMetadataMarkdown(local.appId);
      await this.store.removeInstalledApp(local.appId);
      removed.push(local.appId);
    }

    return {
      deviceId,
      pulled,
      removed,
      pushed: queueResult.pushed,
      failed: queueResult.failed,
    };
  }

  async drainSyncQueue(deviceId?: string): Promise<Pick<AppSyncResult, 'pushed' | 'failed'>> {
    const resolvedDeviceId = deviceId ?? await this.store.getDeviceId();
    const queue = await this.store.listSyncQueue();
    const pushed: string[] = [];
    const failed: AppSyncResult['failed'] = [];

    for (const item of queue) {
      if (item.nextAttemptAt && item.nextAttemptAt > Date.now()) {
        continue;
      }
      try {
        if (item.op === 'uninstall') {
          await this.marketplace.uninstall(item.appId, String(item.payload?.deviceId ?? resolvedDeviceId));
        } else if (item.op === 'device_status') {
          const connectionStatus = String(item.payload?.connectionStatus ?? 'ready') as AppConnectionStatus;
          const lastError = typeof item.payload?.lastError === 'string' ? item.payload.lastError : undefined;
          await this.marketplace.reportDeviceStatus(item.appId, String(item.payload?.deviceId ?? resolvedDeviceId), connectionStatus, lastError);
        } else if (item.op === 'install') {
          await this.marketplace.install(item.appId, String(item.payload?.deviceId ?? resolvedDeviceId));
        }
        await this.store.removeSyncQueueItem(item.id);
        pushed.push(`${item.op}:${item.appId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.recordSyncQueueFailure(item.id, message);
        failed.push({ op: item.op, appId: item.appId, error: message });
      }
    }

    return { pushed, failed };
  }

  async uninstall(appId: string): Promise<void> {
    const deviceId = await this.store.getDeviceId();
    await this.credentials.deleteAppSecrets(appId);
    await this.store.deleteManifest(appId);
    await this.store.deleteMetadataMarkdown(appId);
    await this.store.removeInstalledApp(appId);

    try {
      await this.marketplace.uninstall(appId, deviceId);
    } catch (error) {
      await this.store.enqueueSync({
        op: 'uninstall',
        appId,
        payload: { deviceId },
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async setPriority(appId: string, priority: 1 | 2): Promise<InstalledAppRecord> {
    const install = await this.store.getInstalledApp(appId);
    if (!install) {
      throw new Error('App is not installed on this device.');
    }
    if (priority === 1 && install.priority !== 1) {
      const pinnedCount = (await this.store.listInstalledApps())
        .filter(app => app.appId !== appId && app.priority === 1).length;
      if (pinnedCount >= MAX_PINNED_APPS) {
        throw new Error(`You can pin up to ${MAX_PINNED_APPS} apps.`);
      }
    }

    await this.marketplace.setPriority(appId, priority);
    const updated = await this.store.patchInstalledApp(appId, { priority });
    if (!updated) {
      throw new Error('App is not installed on this device.');
    }
    return updated;
  }

  async reportStatus(appId: string, connectionStatus: InstalledAppRecord['connectionStatus'], lastError?: string): Promise<void> {
    const deviceId = await this.store.getDeviceId();
    try {
      await this.marketplace.reportDeviceStatus(appId, deviceId, connectionStatus, lastError);
    } catch (error) {
      await this.store.enqueueSync({
        op: 'device_status',
        appId,
        payload: { deviceId, connectionStatus, lastError },
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function normalizeRemoteDeviceStatus(
  status: AppConnectionStatus | undefined,
  manifest: AppManifest,
  localStatus?: AppConnectionStatus,
): AppConnectionStatus {
  const requiresAuth = !!manifest.auth?.type && manifest.auth.type !== 'none';
  if (!requiresAuth && status === 'needs_auth') {
    return 'ready';
  }
  if (
    localStatus
    && ['ready', 'connected', 'auth_error', 'blocked_by_provider_registration'].includes(localStatus)
    && (!status || status === 'missing_metadata' || status === 'needs_auth')
  ) {
    return localStatus;
  }
  if (status && status !== 'missing_metadata') {
    return status;
  }
  return requiresAuth ? 'needs_auth' : 'ready';
}
