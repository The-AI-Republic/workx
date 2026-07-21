/** Typed Webfront client for runtime-owned OpenHub Apps services. */
import { getInitializedUIClient } from '@/core/messaging';
import type {
  AppAuthInfo,
  AppIconData,
  AppsAccessPolicy,
  AppsAccessState,
  AppsCredentialValidationResult,
  MarketplaceApp,
  MarketplacePage,
  ManualSetupField,
  OAuthStart,
} from '@/core/apps/types';
import { needsAppAuth } from '@/core/apps/types';

export type {
  AppAuthInfo,
  AppIconData,
  AppsAccessPolicy,
  AppsAccessState,
  AppsCredentialValidationResult,
  MarketplaceApp,
  MarketplacePage,
  ManualSetupField,
  OAuthStart,
};

export const needsAuth = needsAppAuth;

export class AppsApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'AppsApiError';
  }
}

async function request<T>(service: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    const client = await getInitializedUIClient();
    return await client.serviceRequest<T>(service, params);
  } catch (error) {
    if (error && typeof error === 'object' && 'errorCode' in error) {
      const structured = error as { message?: unknown; errorCode?: unknown; retryable?: unknown };
      throw new AppsApiError(
        typeof structured.message === 'string' ? structured.message : 'Apps request failed.',
        typeof structured.errorCode === 'string' ? structured.errorCode : undefined,
        structured.retryable === true
      );
    }
    throw new AppsApiError(error instanceof Error ? error.message : String(error));
  }
}

export function getAppsState(): Promise<AppsAccessState> {
  return request('apps.getState');
}

export function getAppsPolicy(): Promise<AppsAccessPolicy> {
  return request('apps.getPolicy');
}

export function fetchMarketplace(
  options: { query?: string; cursor?: string; limit?: number } = {}
): Promise<MarketplacePage> {
  return request('apps.marketplace.list', options);
}

export function installApp(appId: string): Promise<MarketplaceApp | null> {
  return request('apps.install', { appId });
}

export function uninstallApp(appId: string): Promise<MarketplaceApp | null> {
  return request('apps.uninstall', { appId });
}

export function activateApp(appId: string): Promise<MarketplaceApp | null> {
  return request('apps.activate', { appId });
}

export function deactivateApp(appId: string): Promise<MarketplaceApp | null> {
  return request('apps.deactivate', { appId });
}

export function getAuthStatus(appId: string): Promise<AppAuthInfo | null> {
  return request('apps.auth.getStatus', { appId });
}

export function startOAuth(appId: string): Promise<OAuthStart> {
  return request('apps.auth.startOAuth', { appId });
}

export function submitApiKey(
  appId: string,
  fields: Record<string, string>,
  options: { accountHint?: string } = {}
): Promise<AppAuthInfo | null> {
  return request('apps.auth.submitCredentials', {
    appId,
    fields,
    accountHint: options.accountHint,
  });
}

export function validateAppsApiKey(apiKey: string): Promise<AppsCredentialValidationResult> {
  return request('apps.credentials.validate', { apiKey });
}

export function saveAppsApiKey(apiKey: string): Promise<AppsAccessState> {
  return request('apps.credentials.save', { apiKey });
}

export function removeAppsApiKey(): Promise<AppsAccessState> {
  return request('apps.credentials.remove');
}

export function fetchAppIcon(appId: string): Promise<AppIconData | null> {
  return request('apps.icon.get', { appId });
}
