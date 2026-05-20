/**
 * Runtime-side user profile fetch.
 *
 * After the Track 43 cutover, the desktop runtime owns the OAuth access
 * token (it lives in the keychain). The WebView must not be handed the
 * token across IPC, so any backend call that requires it has to happen
 * here in the runtime process. This module is the runtime counterpart to
 * the WebView's `fetchUserProfile()` — same endpoint, same response shape,
 * but no shared module dependencies with webfront.
 */

import { resolveRuntimeUrls } from '@/config/runtimeUrls';

export interface RuntimeUserProfile {
  id?: string;
  name?: string;
  email?: string;
  avatar?: string;
  /** 0 = free, higher values = paid tiers. */
  userType?: number;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function profileFromAccessToken(accessToken: string): RuntimeUserProfile | null {
  const [, payloadSegment] = accessToken.split('.');
  if (!payloadSegment) return null;
  const payload = decodeBase64UrlJson(payloadSegment);
  if (!payload) return null;
  const email = pickString(payload.email);
  const id = pickString(payload.sub) ?? pickString(payload.user_id) ?? pickString(payload.id);
  const name = pickString(payload.name) ?? pickString(payload.user_name) ?? pickString(payload.display_name);
  if (!email && !id && !name) return null;
  return {
    id,
    name,
    email,
    avatar: pickString(payload.avatar) ?? pickString(payload.avatar_url) ?? pickString(payload.picture),
    userType: typeof payload.user_type === 'number'
      ? payload.user_type
      : typeof payload.userType === 'number'
        ? payload.userType
        : 0,
  };
}

/**
 * Resolve the base URL for the auth backend. Identical default to the
 * webfront's `HOME_PAGE_BASE_URL`, overridable via env for tests / staging.
 */
function resolveAuthBaseUrl(): string {
  return resolveRuntimeUrls().homePageBaseUrl;
}

/**
 * Fetch the authenticated user profile using a known-good access token.
 * Returns null on any error — callers treat null as "no profile available"
 * without surfacing the failure to the user (UI still has a fallback path
 * that reads the stored token via `auth.getState`).
 */
export async function fetchUserProfileServerSide(
  accessToken: string,
): Promise<RuntimeUserProfile | null> {
  if (!accessToken) return null;
  const baseUrl = resolveAuthBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/v1/users/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      console.warn(`[runtime-auth] profile fetch failed from ${baseUrl}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = (await response.json()) as Record<string, unknown>;
    return {
      id: (data.id as string | undefined) ?? (data.user_id as string | undefined),
      name:
        (data.firstName as string | undefined) ??
        (data.name as string | undefined) ??
        (data.display_name as string | undefined) ??
        (data.username as string | undefined),
      email: data.email as string | undefined,
      avatar:
        (data.avatar as string | undefined) ??
        (data.avatar_url as string | undefined) ??
        (data.picture as string | undefined),
      userType: (data.user_type as number | undefined) ?? 0,
    };
  } catch (error) {
    console.warn(`[runtime-auth] profile fetch threw from ${baseUrl}:`, error);
    return profileFromAccessToken(accessToken);
  }
}
