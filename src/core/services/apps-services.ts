import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import { AppActivationService } from '@/core/apps/AppActivationService';
import { AppInstallService } from '@/core/apps/AppInstallService';
import { AppLocalStore } from '@/core/apps/AppLocalStore';
import { AppMarketplaceClient } from '@/core/apps/AppMarketplaceClient';
import { AppMetadataIndex } from '@/core/apps/AppMetadataIndex';
import type { AppConnectionStatus } from '@/core/apps/types';

export interface AppsServiceDeps {
  marketplaceBaseUrl: string;
  getAccessToken?: () => Promise<string | null>;
  connectAccount?: (appId: string) => Promise<unknown>;
}

function createServices(deps: AppsServiceDeps) {
  const store = new AppLocalStore();
  const marketplace = new AppMarketplaceClient({
    baseUrl: deps.marketplaceBaseUrl,
    getAccessToken: deps.getAccessToken,
  });
  const installer = new AppInstallService(marketplace, store);
  const index = new AppMetadataIndex(store);
  const activation = new AppActivationService(
    store,
    undefined,
    undefined,
    (appId: string, status: AppConnectionStatus, lastError?: string) => installer.reportStatus(appId, status, lastError),
  );

  return { store, marketplace, installer, index, activation };
}

export function createAppsServices(deps: AppsServiceDeps): Record<string, ServiceHandler> {
  const services = createServices(deps);

  return {
    'apps.marketplace': async () => {
      const items = await services.marketplace.listMarketplace();
      return { items };
    },

    'apps.installations': async () => {
      const deviceId = await services.store.getDeviceId();
      const remoteItems = await services.marketplace.listInstallations(deviceId);
      const localItems = await services.store.listInstalledApps();
      return { deviceId, remoteItems, localItems };
    },

    'apps.sync': async () => {
      return services.installer.syncFromCloud();
    },

    'apps.install': async (params) => {
      const { appId } = params as { appId?: string };
      if (!appId) {
        throw new Error('appId is required');
      }
      const record = await services.installer.install(appId);
      return record;
    },

    'apps.uninstall': async (params) => {
      const { appId } = params as { appId?: string };
      if (!appId) {
        throw new Error('appId is required');
      }
      await services.activation.deactivate(appId);
      await services.installer.uninstall(appId);
      return { success: true };
    },

    'apps.setPriority': async (params) => {
      const { appId, priority } = params as { appId?: string; priority?: number };
      if (!appId) {
        throw new Error('appId is required');
      }
      if (priority !== 1 && priority !== 2) {
        throw new Error('priority must be 1 or 2');
      }
      return services.installer.setPriority(appId, priority);
    },

    'apps.search': async (params) => {
      const { query, limit } = params as { query?: string; limit?: number };
      const results = await services.index.search(query ?? '', limit ?? 8);
      return { results };
    },

    'apps.activate': async (params) => {
      const { appId } = params as { appId?: string };
      if (!appId) {
        throw new Error('appId is required');
      }
      const result = await services.activation.activate(appId);
      return result;
    },

    'apps.connectAccount': async (params) => {
      const { appId } = params as { appId?: string };
      if (!appId) {
        throw new Error('appId is required');
      }
      if (!deps.connectAccount) {
        throw new Error('App account connection is not available on this platform');
      }
      try {
        const result = await deps.connectAccount(appId);
        await services.installer.reportStatus(appId, 'ready');
        return result;
      } catch (error) {
        await services.installer.reportStatus(appId, 'auth_error', error instanceof Error ? error.message : String(error));
        throw error;
      }
    },

    'apps.deactivate': async (params) => {
      const { appId } = params as { appId?: string };
      if (!appId) {
        throw new Error('appId is required');
      }
      const result = await services.activation.deactivate(appId);
      return result;
    },

    'apps.listActive': async () => {
      const apps = await services.activation.listActive();
      return { apps };
    },
  };
}
