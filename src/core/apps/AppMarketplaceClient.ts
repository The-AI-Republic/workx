import type { AppConnectionStatus, AppManifest, CloudAppInstallation, MarketplaceAppCard } from './types';

export interface AppMarketplaceClientOptions {
  baseUrl: string;
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class AppMarketplaceClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AppMarketplaceClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listMarketplace(): Promise<MarketplaceAppCard[]> {
    const data = await this.request<{ apps?: MarketplaceAppCard[]; items?: MarketplaceAppCard[] }>('/api/v1/apps/marketplace');
    return data.apps ?? data.items ?? [];
  }

  async listInstallations(deviceId?: string): Promise<CloudAppInstallation[]> {
    const suffix = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : '';
    const data = await this.request<{ apps?: CloudAppInstallation[]; items?: CloudAppInstallation[] }>(`/api/v1/apps/installations${suffix}`);
    return data.apps ?? data.items ?? [];
  }

  async getManifest(appId: string): Promise<AppManifest> {
    return this.request<AppManifest>(`/api/v1/apps/${encodeURIComponent(appId)}/manifest`);
  }

  async getMetadataMarkdown(appId: string): Promise<string> {
    return this.requestText(`/api/v1/apps/${encodeURIComponent(appId)}/metadata.md`);
  }

  async install(appId: string, deviceId: string): Promise<void> {
    await this.request(`/api/v1/apps/${encodeURIComponent(appId)}/install`, {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    });
  }

  async uninstall(appId: string, deviceId: string): Promise<void> {
    await this.request(`/api/v1/apps/${encodeURIComponent(appId)}/installation`, {
      method: 'DELETE',
      body: JSON.stringify({ deviceId }),
    });
  }

  async setPriority(appId: string, priority: 1 | 2): Promise<void> {
    await this.request(`/api/v1/apps/${encodeURIComponent(appId)}/priority`, {
      method: 'PATCH',
      body: JSON.stringify({ priority }),
    });
  }

  async reportDeviceStatus(appId: string, deviceId: string, connectionStatus: AppConnectionStatus, lastError?: string): Promise<void> {
    await this.request(`/api/v1/apps/${encodeURIComponent(appId)}/device-status`, {
      method: 'POST',
      body: JSON.stringify({
        deviceId,
        connectionStatus,
        metadataStatus: connectionStatus === 'missing_metadata' ? 'missing' : 'synced',
        runtimeStatus: connectionStatus === 'connected' ? 'active' : 'inactive',
        lastError,
      }),
    });
  }

  private buildUrl(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async headers(extra?: HeadersInit): Promise<HeadersInit> {
    const headers = new Headers(extra);
    headers.set('Accept', 'application/json');
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const token = await this.options.getAccessToken?.();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return headers;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.buildUrl(path), {
      ...init,
      headers: await this.headers(init.headers),
    });
    if (!response.ok) {
      throw new Error(`App marketplace request failed (${response.status}): ${await response.text()}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return await response.json() as T;
  }

  private async requestText(path: string): Promise<string> {
    const headers = new Headers(await this.headers());
    headers.set('Accept', 'text/markdown, text/plain, */*');
    headers.delete('Content-Type');

    const response = await this.fetchImpl(this.buildUrl(path), { headers });
    if (!response.ok) {
      throw new Error(`App marketplace request failed (${response.status}): ${await response.text()}`);
    }
    return await response.text();
  }
}
