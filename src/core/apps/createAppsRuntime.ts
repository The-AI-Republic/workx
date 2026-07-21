import type { CredentialStore } from '@/core/storage/CredentialStore';
import type { RuntimeUrlConfig } from '@/config/runtimeUrls';
import { appsAccessPolicy } from './appsAccessPolicy';
import { AppsAccessController } from './AppsAccessController';
import { OpenHubAppsClient } from './OpenHubAppsClient';
import { OpenHubCredentialProvider } from './OpenHubCredentialProvider';
import type { AppsAccessState, OpenHubCredential } from './types';

export interface CreateAppsRuntimeOptions {
  urls: RuntimeUrlConfig;
  credentialStore: CredentialStore;
  getSessionToken?: () => Promise<string | null>;
  refreshSessionToken?: () => Promise<string | null>;
  emitState?: (state: AppsAccessState) => void | Promise<void>;
  reconnectMcp?: () => void | Promise<void>;
  disconnectMcp?: () => void | Promise<void>;
  oauthReturnUrl?: string | null;
  fetch?: typeof globalThis.fetch;
}

export function createAppsRuntime(options: CreateAppsRuntimeOptions): {
  provider: OpenHubCredentialProvider;
  client?: OpenHubAppsClient;
  access: AppsAccessController;
  getGatewayCredential: () => ReturnType<OpenHubCredentialProvider['getCredential']>;
  handleGatewayUnauthorized: (failedToken: string | null) => Promise<string | null>;
  getMcpCredential: () => Promise<string | null>;
  handleMcpUnauthorized: (failedToken: string | null) => Promise<string | null>;
} {
  const provider = new OpenHubCredentialProvider({
    policy: appsAccessPolicy,
    credentialStore: options.credentialStore,
    managedApiKey: appsAccessPolicy.authMethod === 'api-key' ? options.urls.gatewayMcpApiKey : null,
    getSessionToken: options.getSessionToken,
    refreshSessionToken: options.refreshSessionToken,
  });
  const baseUrl = options.urls.gatewayCatalogApiBaseUrl;
  const client = baseUrl
    ? new OpenHubAppsClient({
        catalogApiBaseUrl: baseUrl,
        credentials: provider,
        oauthReturnUrl: options.oauthReturnUrl,
        fetch: options.fetch,
      })
    : undefined;
  const access = new AppsAccessController({
    configured: Boolean(baseUrl),
    policy: appsAccessPolicy,
    provider,
    client,
    emitState: options.emitState,
    reconnectMcp: options.reconnectMcp,
    disconnectMcp: options.disconnectMcp,
  });

  const getMcpCredential = async (): Promise<string | null> => {
    if (access.getState().credentialStatus !== 'ready') return null;
    return (await provider.getCredential())?.token ?? null;
  };
  const getGatewayCredential = () => provider.getCredential();
  const handleGatewayUnauthorized = async (failedToken: string | null): Promise<string | null> => {
    const current = await provider.getCredential();
    if (!current) return null;
    if (failedToken && current.token !== failedToken) return current.token;
    const next = await provider.handleUnauthorized(current as OpenHubCredential);
    if (next) return next.token;
    void access.refresh();
    return null;
  };
  const handleMcpUnauthorized = handleGatewayUnauthorized;

  return {
    provider,
    client,
    access,
    getGatewayCredential,
    handleGatewayUnauthorized,
    getMcpCredential,
    handleMcpUnauthorized,
  };
}
