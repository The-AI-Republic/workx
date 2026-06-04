import type { MCPTransportType } from '../mcp/types';

export type AppTrustTier = 'first_party' | 'verified' | 'community' | 'unverified';
export type AppInstallState = 'installed' | 'uninstalled';
export type AppConnectionStatus =
  | 'missing_metadata'
  | 'ready'
  | 'needs_auth'
  | 'connected'
  | 'auth_error'
  | 'disabled'
  | 'blocked_by_provider_registration';
export type AppAuthType = 'none' | 'oauth2' | 'api_key';

export interface AppRuntimeManifest {
  kind: 'mcp';
  type?: 'mcp';
  transport: MCPTransportType;
  serverName?: string;
  endpoint: string;
  url?: string;
  timeoutMs?: number;
}

export interface AppToolSummary {
  name: string;
  description?: string;
  category?: string;
  readOnly?: boolean;
}

export interface AppAuthManifest {
  type: AppAuthType;
  scopes?: string[];
  provider?: string;
  authorizationServer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  extraAuthorizationParams?: Record<string, string>;
}

export interface AppProviderRegistration {
  status?:
    | 'ready'
    | 'not_required'
    | 'approved'
    | 'needs_company_registration'
    | 'verification_pending'
    | 'restricted'
    | 'unsupported'
    | 'required'
    | 'blocked';
  instructions?: string;
}

export interface AppManifest {
  schemaVersion: number;
  appId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  publisher?: string;
  trustTier?: AppTrustTier;
  categories?: string[];
  tags?: string[];
  capabilities?: string[];
  runtime: AppRuntimeManifest;
  auth?: AppAuthManifest;
  providerRegistration?: AppProviderRegistration;
  tools?: AppToolSummary[];
}

export interface AppCredentialRef {
  service: string;
  account: string;
}

export interface InstalledAppRecord {
  appId: string;
  slug: string;
  name: string;
  version: string;
  installState: AppInstallState;
  enabled: boolean;
  priority: number;
  connectionStatus: AppConnectionStatus;
  credentialRef?: AppCredentialRef;
  runtimeServerId?: string;
  runtimeServerName?: string;
  installedAt: number;
  updatedAt: number;
  lastActivatedAt?: number;
  lastError?: string;
}

export interface AppLocalState {
  schemaVersion: number;
  deviceId?: string;
  installedApps: Record<string, InstalledAppRecord>;
  manifests: Record<string, AppManifest>;
  metadataMarkdown: Record<string, string>;
  syncQueue: AppSyncQueueItem[];
}

export interface AppSyncQueueItem {
  id: string;
  op: 'install' | 'uninstall' | 'device_status';
  appId: string;
  createdAt: number;
  payload?: Record<string, unknown>;
  attempts?: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  registrationClientUri?: string;
  registrationAccessToken?: string;
}

export interface MarketplaceAppCard {
  appId: string;
  slug: string;
  name: string;
  description: string;
  iconUrl?: string;
  version?: string;
  latestVersion?: string;
  trustTier?: AppTrustTier;
  installState?: AppInstallState;
  connectionStatus?: AppConnectionStatus;
  install?: {
    status?: AppInstallState;
    enabled?: boolean;
    priority?: number;
  };
  categories?: string[];
  tags?: string[];
  capabilities?: string[];
}

export interface CloudAppInstallation {
  appId: string;
  status: AppInstallState;
  enabled: boolean;
  priority: number;
  version: string;
  manifestSha256?: string | null;
  metadataSha256?: string | null;
  deviceStatus?: AppConnectionStatus;
  metadataStatus?: 'missing' | 'synced' | string;
  runtimeStatus?: 'inactive' | 'active' | string;
}

export interface AppSyncResult {
  deviceId: string;
  pulled: string[];
  removed: string[];
  pushed: string[];
  failed: Array<{ op: string; appId: string; error: string }>;
}

export interface AppSearchResult {
  appId: string;
  slug: string;
  name: string;
  version: string;
  score: number;
  status: AppConnectionStatus;
  enabled: boolean;
  priority: number;
  summary: string;
  matchedText: string[];
  suggestedAction: 'activate' | 'connect_auth' | 'install_metadata' | 'none';
}

export interface AppActivationResult {
  status:
    | 'activated'
    | 'deactivated'
    | 'already_active'
    | 'needs_auth'
    | 'not_installed'
    | 'disabled'
    | 'unsupported'
    | 'blocked_by_provider_registration'
    | 'error';
  appId: string;
  serverName?: string;
  toolNames?: string[];
  message?: string;
}
