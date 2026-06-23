/**
 * OIDC authorization-code + PKCE helpers for the desktop login flow.
 *
 * These are pure, transport-only helpers (no UI, no storage). The desktop login
 * flow generates a PKCE pair + state, opens the authorize URL in the system
 * browser, receives the `workx://auth/callback?code=...&state=...` deep link,
 * validates the state, and exchanges the code for tokens at the token endpoint.
 */

import type { AuthOidcConfig } from '@/config/authConfig';

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface AuthCodeCallback {
  code: string;
  state: string | null;
}

export interface OidcTokens {
  accessToken: string;
  refreshToken: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** A high-entropy, URL-safe `state` value for CSRF protection. */
export function randomState(): string {
  return randomBase64Url(16);
}

/** Generate a PKCE verifier and its S256 challenge (RFC 7636). */
export async function generatePkce(): Promise<PkcePair> {
  const codeVerifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

/** Build the `/authorize` URL for the auth-code + PKCE flow. */
export function buildAuthorizeUrl(
  authBaseUrl: string,
  oidc: AuthOidcConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(oidc.authorizePath, authBaseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', oidc.redirectUri);
  url.searchParams.set('scope', oidc.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Parse the redirect callback URL; throws on an `error` response. */
export function parseCallback(callbackUrl: string): AuthCodeCallback {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    throw new Error(description ? `${error}: ${description}` : error);
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('Authorization callback is missing the code parameter');
  }
  return { code, state: url.searchParams.get('state') };
}

/**
 * Exchange an authorization code for tokens at the OIDC token endpoint.
 * Public PKCE client: no client secret, the `code_verifier` proves possession.
 */
export async function exchangeAuthorizationCode(
  authBaseUrl: string,
  oidc: AuthOidcConfig,
  params: { code: string; codeVerifier: string },
): Promise<OidcTokens> {
  const tokenUrl = new URL(oidc.tokenPath, authBaseUrl).toString();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: oidc.redirectUri,
    client_id: oidc.clientId,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // ignore body read failures
    }
    throw new Error(`Token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  const data = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) {
    throw new Error(
      'Token endpoint did not return both access and refresh tokens — ensure the IdP ' +
        'issues a refresh token for this client (e.g. request the "offline_access" scope)',
    );
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}
