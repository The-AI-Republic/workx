export type AppsAuthMethod = 'api-key';

export interface AppsPolicyCopy {
  title: string;
  description: string;
  action: string;
}

export interface AppsAccessPolicy {
  authMethod: 'api-key';
  setupCopy: AppsPolicyCopy;
  apiKeyManagementUrl: string;
}

export type AppsCredentialStatus =
  | 'unconfigured'
  | 'needs-api-key'
  | 'validating'
  | 'unverified'
  | 'ready'
  | 'invalid-credential'
  | 'forbidden';

export type AppsBackendStatus = 'unknown' | 'reachable' | 'unavailable';
export type AppsCapabilityStatus = 'unknown' | 'supported' | 'incompatible';
export type AppsCredentialSource = 'none' | 'stored-api-key' | 'managed-api-key';
export type AppsAccessReason =
  | 'catalog_unconfigured'
  | 'runtime_surface_unsupported'
  | 'api_key_missing'
  | 'credential_rejected'
  | 'insufficient_scope'
  | 'validation_unavailable'
  | 'backend_incompatible';

export interface AppsAccessState {
  configured: boolean;
  credentialStatus: AppsCredentialStatus;
  backendStatus: AppsBackendStatus;
  capabilityStatus: AppsCapabilityStatus;
  authMethod: AppsAuthMethod;
  credentialSource: AppsCredentialSource;
  hasCredential: boolean;
  allowedAppIds?: string[] | null;
  reason?: AppsAccessReason;
  revision: number;
  updatedAt: number;
}

export interface OpenHubCredential {
  method: AppsAuthMethod;
  token: string;
  source: Exclude<AppsCredentialSource, 'none'>;
  generation: number;
}

export interface AppsCredentialValidationResult {
  valid: true;
  credentialType: AppsAuthMethod;
  grantedScopes: string[];
  allowedAppIds: string[] | null;
}

export interface ManualSetupField {
  key: string;
  label: string;
  type: 'secret' | 'text';
  validation: string | null;
  placeholder: string | null;
  optional: boolean;
}

export interface AppAuthInfo {
  type: 'none' | 'oauth2' | 'api_key' | 'basic' | 'unknown';
  status: 'connected' | 'needs_auth' | 'expired' | 'auth_error' | 'ready' | 'unknown';
  connectionStatus: string | null;
  accountHint: string | null;
  manualFields: ManualSetupField[];
  setupUrl: string | null;
}

export interface MarketplaceApp {
  appId: string;
  slug: string;
  name: string;
  description: string | null;
  hasIcon: boolean;
  categories: string[];
  tags: string[];
  installStatus: string;
  enabled: boolean;
  isActivated: boolean;
  suggestedAction: string | null;
  version: string | null;
  monetizationTier: string | null;
  trustTier: string | null;
  auth: AppAuthInfo | null;
}

export interface MarketplacePage {
  items: MarketplaceApp[];
  nextCursor: string | null;
}

export interface OAuthStart {
  authorizationUrl: string;
  expiresIn: number | null;
}

export interface AppIconData {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export function needsAppAuth(info: AppAuthInfo | null | undefined): boolean {
  return Boolean(info && info.type !== 'none' && info.status !== 'connected');
}
