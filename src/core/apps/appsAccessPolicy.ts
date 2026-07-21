import type { AppsAccessPolicy } from './types';

function publicEnv(): Record<string, string | undefined> {
  const vite =
    typeof import.meta !== 'undefined'
      ? ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {})
      : {};
  const node = typeof process !== 'undefined' ? process.env : {};
  return { ...vite, ...node };
}

function resolveKeyManagementUrl(): string {
  const env = publicEnv();
  const raw =
    env.WORKX_OPENHUB_API_KEY_MANAGEMENT_URL ??
    env.VITE_OPENHUB_API_KEY_MANAGEMENT_URL ??
    'https://hub.airepublic.com/settings/api-keys';
  try {
    const url = new URL(raw);
    if (url.username || url.password) throw new Error('URL credentials are not allowed');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))
    ) {
      throw new Error('HTTPS is required');
    }
    return url.toString();
  } catch (error) {
    throw new Error(
      `Invalid OpenHub API-key management URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export const appsAccessPolicy: AppsAccessPolicy = {
  authMethod: 'api-key',
  apiKeyManagementUrl: resolveKeyManagementUrl(),
  setupCopy: {
    title: 'Connect Apps',
    description: 'Add your OpenHub API key to use OpenHub models and apps.',
    action: 'Add API key',
  },
};
