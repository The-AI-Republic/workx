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
  desktopSession: string | null;
  desktopRefresh: string | null;
  profile: string | null;
  userCenter: string | null;
  pricing: string | null;
}

/**
 * OIDC authorization-code + PKCE login configuration. Present only when an
 * OIDC `client_id` is configured (via `WORKX_AUTH_CLIENT_ID` / `VITE_AUTH_CLIENT_ID`).
 * When absent, the client uses the legacy deep-link token flow.
 */
export interface AuthOidcConfig {
  clientId: string;
  authorizePath: string;
  tokenPath: string;
  redirectUri: string;
  scopes: string[];
}

export interface AuthConfig {
  authBaseUrl: string | null;
  cookieDomain: string | null;
  cookieNames: AuthCookieNames;
  routes: AuthRoutePaths;
  oidc: AuthOidcConfig | null;
  source: {
    authBaseUrl: AuthConfigSource;
    cookieDomain: AuthConfigSource;
    cookieNames: AuthConfigSource;
    routes: AuthConfigSource;
    oidc: AuthConfigSource;
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

function authSeam(
  env: Record<string, string | undefined>,
  vite: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return firstNonEmpty(
    env[`WORKX_AUTH_${name}`],
    env[`VITE_AUTH_${name}`],
    vite[`VITE_AUTH_${name}`],
  );
}

function resolveOidcConfig(
  env: Record<string, string | undefined>,
  vite: Record<string, string | undefined>,
): AuthOidcConfig | null {
  const clientId = authSeam(env, vite, 'CLIENT_ID');
  // OIDC is opt-in: without a client id we fall back to the legacy deep-link flow.
  if (!clientId) return null;

  const scopes = (authSeam(env, vite, 'SCOPES') ?? 'openid profile email')
    .split(/\s+/)
    .filter((scope) => scope.length > 0);

  return {
    clientId,
    authorizePath: authSeam(env, vite, 'AUTHORIZE_PATH') ?? '/auth/authorize',
    tokenPath: authSeam(env, vite, 'TOKEN_PATH') ?? '/auth/token',
    redirectUri: authSeam(env, vite, 'REDIRECT_URI') ?? 'workx://auth/callback',
    scopes: scopes.length > 0 ? scopes : ['openid', 'profile', 'email'],
  };
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
    desktopSession: routePath(env, vite, 'DESKTOP_SESSION'),
    desktopRefresh: routePath(env, vite, 'DESKTOP_REFRESH'),
    profile: routePath(env, vite, 'PROFILE'),
    userCenter: routePath(env, vite, 'USER_CENTER'),
    pricing: routePath(env, vite, 'PRICING'),
  };

  const oidc = resolveOidcConfig(env, vite);

  const usesDefaultCookieNames = Object.entries(cookieNames).every(
    ([key, value]) => value === DEFAULT_COOKIE_NAMES[key as keyof AuthCookieNames],
  );
  const usesDefaultRoutes = Object.values(routes).every((route) => route === null);

  return {
    authBaseUrl,
    cookieDomain,
    cookieNames,
    routes,
    oidc,
    source: {
      authBaseUrl: authBaseUrl ? 'env' : 'default',
      cookieDomain: cookieDomain ? 'env' : 'default',
      cookieNames: usesDefaultCookieNames ? 'default' : 'env',
      routes: usesDefaultRoutes ? 'default' : 'env',
      oidc: oidc ? 'env' : 'default',
    },
  };
}
