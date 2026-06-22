export type AuthConfigSource = 'env' | 'default';

export interface AuthCookieNames {
  access: string;
  refresh: string;
  csrf: string;
  status: string;
  userName: string;
  userEmail: string;
}

export interface AuthRoutePaths {
  login: string | null;
  /** OIDC authorization endpoint (Authorization Code + PKCE). */
  authorize: string | null;
  /** OIDC token endpoint (code -> tokens exchange). */
  token: string | null;
  desktopSession: string | null;
  desktopRefresh: string | null;
  profile: string | null;
  userCenter: string | null;
  pricing: string | null;
}

export interface AuthConfig {
  authBaseUrl: string | null;
  cookieDomain: string | null;
  cookieNames: AuthCookieNames;
  routes: AuthRoutePaths;
  /** OIDC public client id for the desktop app (PKCE, no secret). */
  oidcClientId: string | null;
  source: {
    authBaseUrl: AuthConfigSource;
    cookieDomain: AuthConfigSource;
    cookieNames: AuthConfigSource;
    routes: AuthConfigSource;
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

function routePath(
  env: Record<string, string | undefined>,
  vite: Record<string, string | undefined>,
  name: string,
): string | null {
  return firstNonEmpty(
    env[`WORKX_AUTH_${name}_PATH`],
    env[`VITE_AUTH_${name}_PATH`],
    vite[`VITE_AUTH_${name}_PATH`],
  ) ?? null;
}

export function resolveAuthConfig(): AuthConfig {
  const env = processEnv();
  const vite = viteEnv();

  const authBaseUrl = firstNonEmpty(
    env.WORKX_AUTH_BASE_URL,
    env.WORKX_HOME_PAGE_BASE_URL,
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
  const routes: AuthRoutePaths = {
    login: routePath(env, vite, 'LOGIN'),
    authorize: routePath(env, vite, 'AUTHORIZE'),
    token: routePath(env, vite, 'TOKEN'),
    desktopSession: routePath(env, vite, 'DESKTOP_SESSION'),
    desktopRefresh: routePath(env, vite, 'DESKTOP_REFRESH'),
    profile: routePath(env, vite, 'PROFILE'),
    userCenter: routePath(env, vite, 'USER_CENTER'),
    pricing: routePath(env, vite, 'PRICING'),
  };

  const oidcClientId = firstNonEmpty(
    env.WORKX_AUTH_OIDC_CLIENT_ID,
    env.VITE_AUTH_OIDC_CLIENT_ID,
    vite.VITE_AUTH_OIDC_CLIENT_ID,
  ) ?? null;

  const usesDefaultCookieNames = Object.entries(cookieNames).every(
    ([key, value]) => value === DEFAULT_COOKIE_NAMES[key as keyof AuthCookieNames],
  );
  const usesDefaultRoutes = Object.values(routes).every((route) => route === null);

  return {
    authBaseUrl,
    cookieDomain,
    cookieNames,
    routes,
    oidcClientId,
    source: {
      authBaseUrl: authBaseUrl ? 'env' : 'default',
      cookieDomain: cookieDomain ? 'env' : 'default',
      cookieNames: usesDefaultCookieNames ? 'default' : 'env',
      routes: usesDefaultRoutes ? 'default' : 'env',
    },
  };
}
