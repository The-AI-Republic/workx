export type AuthConfigSource = 'env' | 'default';

export interface AuthCookieNames {
  access: string;
  refresh: string;
  csrf: string;
  status: string;
  userName: string;
  userEmail: string;
}

export interface AuthConfig {
  authBaseUrl: string | null;
  cookieDomain: string | null;
  cookieNames: AuthCookieNames;
  source: {
    authBaseUrl: AuthConfigSource;
    cookieDomain: AuthConfigSource;
    cookieNames: AuthConfigSource;
  };
}

const DEFAULT_COOKIE_NAMES: AuthCookieNames = {
  access: 'access_token',
  refresh: 'refresh_token',
  csrf: 'csrf_token',
  status: 'auth_status',
  userName: 'user_name',
  userEmail: 'user_email',
};

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

export function resolveAuthConfig(): AuthConfig {
  const env = processEnv();
  const vite = viteEnv();

  const authBaseUrl = firstNonEmpty(
    env.APPLEPI_AUTH_BASE_URL,
    env.APPLEPI_HOME_PAGE_BASE_URL,
    env.VITE_AUTH_BASE_URL,
    env.VITE_HOME_PAGE_BASE_URL,
    vite.VITE_AUTH_BASE_URL,
    vite.VITE_HOME_PAGE_BASE_URL,
  ) ?? null;
  const cookieDomain = firstNonEmpty(
    env.VITE_AUTH_COOKIE_DOMAIN,
    env.VITE_COOKIE_DOMAIN,
    vite.VITE_AUTH_COOKIE_DOMAIN,
    vite.VITE_COOKIE_DOMAIN,
  ) ?? null;

  const cookieNames: AuthCookieNames = {
    access: firstNonEmpty(env.VITE_AUTH_ACCESS_COOKIE_NAME, vite.VITE_AUTH_ACCESS_COOKIE_NAME) ?? DEFAULT_COOKIE_NAMES.access,
    refresh: firstNonEmpty(env.VITE_AUTH_REFRESH_COOKIE_NAME, vite.VITE_AUTH_REFRESH_COOKIE_NAME) ?? DEFAULT_COOKIE_NAMES.refresh,
    csrf: firstNonEmpty(env.VITE_AUTH_CSRF_COOKIE_NAME, vite.VITE_AUTH_CSRF_COOKIE_NAME) ?? DEFAULT_COOKIE_NAMES.csrf,
    status: firstNonEmpty(env.VITE_AUTH_STATUS_COOKIE_NAME, vite.VITE_AUTH_STATUS_COOKIE_NAME) ?? DEFAULT_COOKIE_NAMES.status,
    userName: firstNonEmpty(env.VITE_AUTH_USER_NAME_COOKIE_NAME, vite.VITE_AUTH_USER_NAME_COOKIE_NAME) ?? DEFAULT_COOKIE_NAMES.userName,
    userEmail: firstNonEmpty(env.VITE_AUTH_USER_EMAIL_COOKIE_NAME, vite.VITE_AUTH_USER_EMAIL_COOKIE_NAME) ?? DEFAULT_COOKIE_NAMES.userEmail,
  };

  const usesDefaultCookieNames = Object.entries(cookieNames).every(
    ([key, value]) => value === DEFAULT_COOKIE_NAMES[key as keyof AuthCookieNames],
  );

  return {
    authBaseUrl,
    cookieDomain,
    cookieNames,
    source: {
      authBaseUrl: authBaseUrl ? 'env' : 'default',
      cookieDomain: cookieDomain ? 'env' : 'default',
      cookieNames: usesDefaultCookieNames ? 'default' : 'env',
    },
  };
}
