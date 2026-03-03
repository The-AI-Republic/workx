/**
 * Connection Authentication
 *
 * Resolves auth mode from config and verifies credentials.
 *
 * @module server/connection/auth
 */

import { getServerConfig, type ServerConfig } from '../config/server-config';
import { unauthorized, type ErrorShape } from '@pi/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Auth modes
// ─────────────────────────────────────────────────────────────────────────

export type AuthMode = 'none' | 'token' | 'password' | 'trusted-proxy';

export interface AuthResult {
  authenticated: boolean;
  userId?: string;
  error?: ErrorShape;
}

// ─────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Verify authentication credentials based on the configured mode.
 */
export function verifyAuth(
  authParams: { token?: string; password?: string; deviceSignature?: string; deviceId?: string } | undefined,
  headers?: Record<string, string>,
  isLoopback?: boolean
): AuthResult {
  const config = getServerConfig();
  const mode = config.server.auth.mode;

  switch (mode) {
    case 'none':
      // Only allow on loopback
      if (isLoopback) {
        return { authenticated: true };
      }
      return {
        authenticated: false,
        error: unauthorized('Auth mode "none" only allowed on loopback connections'),
      };

    case 'token':
      return verifyToken(authParams?.token, config);

    case 'password':
      return verifyPassword(authParams?.password, config);

    case 'trusted-proxy':
      return verifyTrustedProxy(headers, config);

    default:
      return {
        authenticated: false,
        error: unauthorized(`Unknown auth mode: ${mode}`),
      };
  }
}

function verifyToken(
  token: string | undefined,
  config: ServerConfig
): AuthResult {
  const expected = config.server.auth.token;
  if (!expected) {
    return {
      authenticated: false,
      error: unauthorized('Token auth configured but no token set'),
    };
  }

  if (!token) {
    return {
      authenticated: false,
      error: unauthorized('Token required'),
    };
  }

  // Constant-time comparison
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
    return {
      authenticated: false,
      error: unauthorized('Invalid token'),
    };
  }

  return { authenticated: true };
}

function verifyPassword(
  password: string | undefined,
  config: ServerConfig
): AuthResult {
  const expected = config.server.auth.password;
  if (!expected) {
    return {
      authenticated: false,
      error: unauthorized('Password auth configured but no password set'),
    };
  }

  if (!password) {
    return {
      authenticated: false,
      error: unauthorized('Password required'),
    };
  }

  if (password.length !== expected.length || !timingSafeEqual(password, expected)) {
    return {
      authenticated: false,
      error: unauthorized('Invalid password'),
    };
  }

  return { authenticated: true };
}

function verifyTrustedProxy(
  headers: Record<string, string> | undefined,
  config: ServerConfig
): AuthResult {
  const user = headers?.['x-forwarded-user'];
  if (!user) {
    return {
      authenticated: false,
      error: unauthorized('Missing X-Forwarded-User header'),
    };
  }

  // In trusted-proxy mode, the proxy is responsible for authentication.
  // We trust the user header if it arrives at all (proxy IP validation
  // happens at the connection/accept level, not here).
  return { authenticated: true, userId: user };
}

// ─────────────────────────────────────────────────────────────────────────
// Timing-safe comparison
// ─────────────────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
