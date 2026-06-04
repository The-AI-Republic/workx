import { MCPManager } from '../mcp/MCPManager';
import type { IMCPManager } from '../mcp/types';
import { AppOAuthService } from './auth/AppOAuthService';
import { AppCredentialStore } from './credentials/AppCredentialStore';
import { AppLocalStore } from './AppLocalStore';
import type { AppActivationResult, AppManifest, InstalledAppRecord, OAuthTokenSet } from './types';
import type { AppConnectionStatus } from './types';

function sanitizeServerName(input: string): string {
  const sanitized = input.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'app';
}

function tokenIsExpired(token: OAuthTokenSet): boolean {
  return typeof token.expiresAt === 'number' && token.expiresAt <= Date.now() + 60_000;
}

type StatusReporter = (appId: string, status: AppConnectionStatus, lastError?: string) => Promise<void>;

function providerRegistrationIsBlocked(manifest: AppManifest): boolean {
  const status = manifest.providerRegistration?.status;
  return status === 'required'
    || status === 'blocked'
    || status === 'needs_company_registration'
    || status === 'verification_pending'
    || status === 'restricted'
    || status === 'unsupported';
}

export class AppActivationService {
  constructor(
    private readonly store: AppLocalStore = new AppLocalStore(),
    private readonly credentials: AppCredentialStore = new AppCredentialStore(),
    private readonly managerFactory: () => Promise<IMCPManager> = () => MCPManager.getInstance('desktop'),
    private readonly statusReporter?: StatusReporter,
  ) {}

  async activate(appId: string): Promise<AppActivationResult> {
    const install = await this.store.getInstalledApp(appId);
    if (!install) {
      return { status: 'not_installed', appId, message: 'App is not installed on this device.' };
    }
    if (!install.enabled) {
      return { status: 'disabled', appId, message: 'App is disabled.' };
    }

    const manifest = await this.store.getManifest(appId);
    if (!manifest) {
      await this.store.patchInstalledApp(appId, { connectionStatus: 'missing_metadata' });
      return { status: 'error', appId, message: 'Installed app metadata is missing. Reinstall or resync the app.' };
    }
    if ((manifest.runtime.kind ?? manifest.runtime.type) !== 'mcp') {
      return { status: 'unsupported', appId, message: 'Only MCP apps can be activated in this MVP.' };
    }

    if (providerRegistrationIsBlocked(manifest)) {
      const providerStatus = manifest.providerRegistration?.status;
      const message = providerStatus === 'blocked' || providerStatus === 'restricted' || providerStatus === 'unsupported'
        ? 'Provider registration is blocked for this app.'
        : 'Apple Pi provider registration is required before this app can connect.';
      await this.patchStatus(appId, 'blocked_by_provider_registration', message);
      return { status: 'blocked_by_provider_registration', appId, message };
    }

    const authHeaders = await this.buildAuthHeaders(manifest);
    if (authHeaders === 'needs_auth') {
      await this.patchStatus(appId, 'needs_auth');
      return { status: 'needs_auth', appId, message: 'Connect this app account before activation.' };
    }

    const manager = await this.managerFactory();
    const serverName = sanitizeServerName(manifest.runtime.serverName ?? manifest.slug);
    const existingConnection = install.runtimeServerId ? manager.getConnection(install.runtimeServerId) : undefined;
    if (existingConnection?.status === 'connected') {
      try {
        await this.reportStatus(appId, 'connected');
      } catch (error) {
        console.warn('[AppActivationService] Failed to report app status:', error);
      }
      return {
        status: 'already_active',
        appId,
        serverName,
        toolNames: existingConnection.tools.map(tool => `${serverName}__${tool.name}`),
      };
    }

    let runtimeServerId: string | null = null;
    try {
      const endpoint = manifest.runtime.endpoint ?? manifest.runtime.url;
      if (!endpoint) {
        throw new Error('MCP endpoint is missing from the app manifest');
      }
      const server = await manager.addRuntimeServer({
        name: serverName,
        url: endpoint,
        transport: manifest.runtime.transport,
        timeout: manifest.runtime.timeoutMs ?? 30_000,
        platform: 'desktop',
        enabled: true,
      });
      runtimeServerId = server.id;

      await manager.connect(server.id, { headers: authHeaders });
      const connection = manager.getConnection(server.id);
      const toolNames = connection?.tools.map(tool => `${server.name}__${tool.name}`) ?? [];

      await this.patchStatus(appId, 'connected', undefined, {
        runtimeServerId: server.id,
        runtimeServerName: server.name,
        lastActivatedAt: Date.now(),
      });

      return {
        status: 'activated',
        appId,
        serverName: server.name,
        toolNames,
      };
    } catch (error) {
      if (runtimeServerId && manager.getServer(runtimeServerId)) {
        try {
          await manager.removeServer(runtimeServerId);
        } catch (cleanupError) {
          console.warn('[AppActivationService] Failed to remove failed runtime server:', cleanupError);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.patchStatus(appId, manifest.auth?.type && manifest.auth.type !== 'none' ? 'auth_error' : 'ready', message);
      return { status: 'error', appId, serverName, message };
    }
  }

  async deactivate(appId: string): Promise<AppActivationResult> {
    const install = await this.store.getInstalledApp(appId);
    if (!install) {
      return { status: 'not_installed', appId };
    }
    const manager = await this.managerFactory();
    if (install.runtimeServerId && manager.getServer(install.runtimeServerId)) {
      try {
        await manager.removeServer(install.runtimeServerId);
      } catch (error) {
        return { status: 'error', appId, message: error instanceof Error ? error.message : String(error) };
      }
    }

    await this.patchStatus(appId, install.enabled ? 'ready' : 'disabled', undefined, {
      runtimeServerId: undefined,
      runtimeServerName: undefined,
    });
    return { status: 'deactivated', appId, message: 'App deactivated.' };
  }

  async listActive(): Promise<Array<InstalledAppRecord & { toolNames: string[] }>> {
    const manager = await this.managerFactory();
    const installs = await this.store.listInstalledApps();
    return installs
      .filter(install => install.connectionStatus === 'connected' && !!install.runtimeServerId)
      .map(install => {
        const connection = install.runtimeServerId ? manager.getConnection(install.runtimeServerId) : undefined;
        const serverName = install.runtimeServerName ?? install.slug;
        return {
          ...install,
          toolNames: connection?.tools.map(tool => `${serverName}__${tool.name}`) ?? [],
        };
      });
  }

  private async buildAuthHeaders(manifest: AppManifest): Promise<Record<string, string> | 'needs_auth'> {
    const authType = manifest.auth?.type ?? 'none';
    if (authType === 'none') {
      return {};
    }

    if (authType === 'oauth2') {
      const token = await this.credentials.getOAuthToken(manifest.appId);
      if (!token) {
        return 'needs_auth';
      }
      if (tokenIsExpired(token)) {
        if (!token.refreshToken) {
          return 'needs_auth';
        }
        try {
          const refreshed = await new AppOAuthService(this.credentials).refreshToken(manifest);
          return {
            Authorization: `${refreshed.tokenType ?? 'Bearer'} ${refreshed.accessToken}`,
          };
        } catch {
          return 'needs_auth';
        }
      }
      return {
        Authorization: `${token.tokenType ?? 'Bearer'} ${token.accessToken}`,
      };
    }

    return 'needs_auth';
  }

  private async patchStatus(
    appId: string,
    connectionStatus: AppConnectionStatus,
    lastError?: string,
    patch: Partial<InstalledAppRecord> = {},
  ): Promise<void> {
    await this.store.patchInstalledApp(appId, {
      ...patch,
      connectionStatus,
      lastError,
    });
    if (!this.statusReporter) {
      return;
    }
    try {
      await this.reportStatus(appId, connectionStatus, lastError);
    } catch (error) {
      console.warn('[AppActivationService] Failed to report app status:', error);
    }
  }

  private async reportStatus(appId: string, connectionStatus: AppConnectionStatus, lastError?: string): Promise<void> {
    if (!this.statusReporter) {
      return;
    }
    await this.statusReporter(appId, connectionStatus, lastError);
  }
}
