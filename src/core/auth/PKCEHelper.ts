/**
 * PKCE Helper
 *
 * Shared Authorization Code + PKCE (RFC 7636) primitives used by both the
 * ChatGPT OAuth flow and the desktop OIDC login flow. Centralising these keeps
 * verifier/challenge generation identical across flows.
 *
 * @module core/auth/PKCEHelper
 */

/** A PKCE verifier/challenge pair (S256). */
export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generate a PKCE challenge pair for a new authorization-code flow.
 * Code verifier: 32 random bytes, base64url-encoded.
 * Code challenge: SHA-256 hash of the verifier, base64url-encoded (S256).
 */
export async function generatePKCEChallenge(): Promise<PKCEChallenge> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(randomBytes);

  const data = new TextEncoder().encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = base64UrlEncode(new Uint8Array(hashBuffer));

  return { codeVerifier, codeChallenge };
}

/**
 * Generate a random URL-safe token suitable for an OAuth `state` or OIDC
 * `nonce`. Returns a base64url-encoded string from `byteLength` random bytes.
 */
export function randomUrlToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Base64url-encode bytes without padding (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
