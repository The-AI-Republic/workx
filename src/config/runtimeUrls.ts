export type RuntimeUrlSource = 'env' | 'default';

export interface RuntimeUrlConfig {
  homePageBaseUrl: string;
  backendApiBaseUrl: string | null;
  llmApiUrl: string | null;
  deeplinkRedirectUrl: 'applepi://auth/callback';
  source: {
    homePageBaseUrl: RuntimeUrlSource;
    backendApiBaseUrl: RuntimeUrlSource;
    llmApiUrl: RuntimeUrlSource;
    deeplinkRedirectUrl: 'default';
  };
}

function viteEnv(): Record<string, string | undefined> {
  return typeof import.meta !== 'undefined'
    ? ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {})
    : {};
}

function processEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' ? process.env : {};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

export function resolveRuntimeUrls(): RuntimeUrlConfig {
  const env = processEnv();
  const vite = viteEnv();

  const homeFromEnv = firstNonEmpty(
    env.APPLEPI_HOME_PAGE_BASE_URL,
    env.VITE_HOME_PAGE_BASE_URL,
    vite.VITE_HOME_PAGE_BASE_URL,
  );
  const backendFromEnv = firstNonEmpty(
    env.APPLEPI_BACKEND_API_BASE_URL,
    env.VITE_BACKEND_API_BASE_URL,
    vite.VITE_BACKEND_API_BASE_URL,
  );

  const homePageBaseUrl = homeFromEnv ?? 'https://airepublic.com';
  const backendApiBaseUrl = backendFromEnv ?? null;

  return {
    homePageBaseUrl,
    backendApiBaseUrl,
    llmApiUrl: backendApiBaseUrl ? `${backendApiBaseUrl}/api/llm` : '/api/llm',
    deeplinkRedirectUrl: 'applepi://auth/callback',
    source: {
      homePageBaseUrl: homeFromEnv ? 'env' : 'default',
      backendApiBaseUrl: backendFromEnv ? 'env' : 'default',
      llmApiUrl: backendFromEnv ? 'env' : 'default',
      deeplinkRedirectUrl: 'default',
    },
  };
}

