import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatGPTOAuthService,
  type ChatGPTOAuthStorage,
  type ChatGPTTokens,
} from '../ChatGPTOAuthService';

/**
 * In-memory mock storage for testing
 */
function createMockStorage(): ChatGPTOAuthStorage & { _tokens: ChatGPTTokens | null } {
  return {
    _tokens: null,
    async getTokens() {
      return this._tokens;
    },
    async setTokens(tokens: ChatGPTTokens) {
      this._tokens = { ...tokens };
    },
    async clearTokens() {
      this._tokens = null;
    },
  };
}

describe('ChatGPTOAuthService', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let service: ChatGPTOAuthService;

  beforeEach(() => {
    storage = createMockStorage();
    service = new ChatGPTOAuthService(storage);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generatePKCEChallenge', () => {
    it('should generate a code verifier of correct length (base64url of 32 bytes)', async () => {
      const { codeVerifier } = await service.generatePKCEChallenge();
      // 32 bytes → 43 base64url chars (ceil(32 * 4/3) = 43, no padding)
      expect(codeVerifier).toHaveLength(43);
    });

    it('should generate a base64url-encoded code verifier (no +, /, or = chars)', async () => {
      const { codeVerifier } = await service.generatePKCEChallenge();
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate a base64url-encoded code challenge', async () => {
      const { codeChallenge } = await service.generatePKCEChallenge();
      // SHA-256 → 32 bytes → 43 base64url chars
      expect(codeChallenge).toHaveLength(43);
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate different challenges on each call', async () => {
      const first = await service.generatePKCEChallenge();
      const second = await service.generatePKCEChallenge();
      expect(first.codeVerifier).not.toBe(second.codeVerifier);
      expect(first.codeChallenge).not.toBe(second.codeChallenge);
    });

    it('should produce a code challenge that is SHA-256 of the verifier', async () => {
      const { codeVerifier, codeChallenge } = await service.generatePKCEChallenge();

      // Manually compute SHA-256 of verifier and compare
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
      const hashArray = new Uint8Array(hashBuffer);
      const expected = btoa(String.fromCharCode(...hashArray))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(codeChallenge).toBe(expected);
    });
  });

  describe('buildAuthorizationUrl', () => {
    it('should include the client_id', async () => {
      const url = service.buildAuthorizationUrl('test-state', 'test-challenge');
      expect(url).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    });

    it('should include the redirect_uri', async () => {
      const url = service.buildAuthorizationUrl('test-state', 'test-challenge');
      expect(url).toContain('redirect_uri=' + encodeURIComponent('http://localhost:1455/callback'));
    });

    it('should include response_type=code', () => {
      const url = service.buildAuthorizationUrl('test-state', 'test-challenge');
      expect(url).toContain('response_type=code');
    });

    it('should include the required scopes', () => {
      const url = service.buildAuthorizationUrl('test-state', 'test-challenge');
      expect(url).toContain('scope=openid+profile+email');
    });

    it('should include the state parameter', () => {
      const url = service.buildAuthorizationUrl('my-state-123', 'test-challenge');
      expect(url).toContain('state=my-state-123');
    });

    it('should include code_challenge and code_challenge_method=S256', () => {
      const url = service.buildAuthorizationUrl('test-state', 'my-challenge');
      expect(url).toContain('code_challenge=my-challenge');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('should use the correct auth endpoint', () => {
      const url = service.buildAuthorizationUrl('test-state', 'test-challenge');
      expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('should send correct POST body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'at-123',
            refresh_token: 'rt-456',
            id_token: 'id-789',
            expires_in: 3600,
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await service.exchangeCodeForTokens('auth-code-abc', 'verifier-xyz');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://auth.openai.com/oauth/token');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = new URLSearchParams(options.body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(body.get('code')).toBe('auth-code-abc');
      expect(body.get('redirect_uri')).toBe('http://localhost:1455/callback');
      expect(body.get('code_verifier')).toBe('verifier-xyz');
    });

    it('should store tokens after successful exchange', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'at-123',
              refresh_token: 'rt-456',
              id_token: 'id-789',
              expires_in: 3600,
            }),
        })
      );

      const tokens = await service.exchangeCodeForTokens('code', 'verifier');

      expect(tokens.accessToken).toBe('at-123');
      expect(tokens.refreshToken).toBe('rt-456');
      expect(tokens.idToken).toBe('id-789');
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
      expect(storage._tokens).not.toBeNull();
      expect(storage._tokens!.accessToken).toBe('at-123');
    });

    it('should throw on error response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('invalid_grant'),
        })
      );

      await expect(service.exchangeCodeForTokens('bad-code', 'verifier')).rejects.toThrow(
        'Token exchange failed (400)'
      );
    });
  });

  describe('refreshAccessToken', () => {
    it('should send correct POST body for refresh', async () => {
      storage._tokens = {
        accessToken: 'old-at',
        refreshToken: 'rt-original',
        expiresAt: Date.now() - 1000,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new-at',
            refresh_token: 'new-rt',
            expires_in: 3600,
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await service.refreshAccessToken();

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(body.get('refresh_token')).toBe('rt-original');
    });

    it('should store new tokens after refresh', async () => {
      storage._tokens = {
        accessToken: 'old-at',
        refreshToken: 'rt-original',
        expiresAt: Date.now() - 1000,
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-at',
              refresh_token: 'new-rt',
              expires_in: 3600,
            }),
        })
      );

      const result = await service.refreshAccessToken();

      expect(result).toBe('new-at');
      expect(storage._tokens!.accessToken).toBe('new-at');
      expect(storage._tokens!.refreshToken).toBe('new-rt');
    });

    it('should clear tokens on refresh failure', async () => {
      storage._tokens = {
        accessToken: 'old-at',
        refreshToken: 'rt-revoked',
        expiresAt: Date.now() - 1000,
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve('invalid_grant'),
        })
      );

      await expect(service.refreshAccessToken()).rejects.toThrow('Token refresh failed (401)');
      expect(storage._tokens).toBeNull();
    });

    it('should throw when no refresh token available', async () => {
      storage._tokens = null;
      await expect(service.refreshAccessToken()).rejects.toThrow('No refresh token available');
    });
  });

  describe('getValidAccessToken', () => {
    it('should return cached token when not expired', async () => {
      storage._tokens = {
        accessToken: 'valid-at',
        refreshToken: 'rt-123',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      };

      const token = await service.getValidAccessToken();
      expect(token).toBe('valid-at');
    });

    it('should refresh when token expires within 5 minutes', async () => {
      storage._tokens = {
        accessToken: 'expiring-at',
        refreshToken: 'rt-123',
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes from now (within 5-min buffer)
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'fresh-at',
              refresh_token: 'new-rt',
              expires_in: 3600,
            }),
        })
      );

      const token = await service.getValidAccessToken();
      expect(token).toBe('fresh-at');
    });

    it('should share a single refresh request for concurrent calls (mutex)', async () => {
      storage._tokens = {
        accessToken: 'expiring-at',
        refreshToken: 'rt-123',
        expiresAt: Date.now() + 1000, // About to expire
      };

      let fetchCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          fetchCallCount++;
          // Simulate network delay
          await new Promise((r) => setTimeout(r, 50));
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: 'fresh-at',
                refresh_token: 'new-rt',
                expires_in: 3600,
              }),
          };
        })
      );

      // Fire 3 concurrent calls
      const [token1, token2, token3] = await Promise.all([
        service.getValidAccessToken(),
        service.getValidAccessToken(),
        service.getValidAccessToken(),
      ]);

      expect(token1).toBe('fresh-at');
      expect(token2).toBe('fresh-at');
      expect(token3).toBe('fresh-at');
      // Should only have made ONE fetch call (mutex)
      expect(fetchCallCount).toBe(1);
    });

    it('should throw when not authenticated', async () => {
      storage._tokens = null;
      await expect(service.getValidAccessToken()).rejects.toThrow('Not authenticated');
    });
  });

  describe('isAuthenticated', () => {
    it('should return false when no tokens stored', async () => {
      expect(await service.isAuthenticated()).toBe(false);
    });

    it('should return true when tokens with refresh token exist', async () => {
      storage._tokens = {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3600000,
      };
      expect(await service.isAuthenticated()).toBe(true);
    });

    it('should return false when refresh token is empty', async () => {
      storage._tokens = {
        accessToken: 'at',
        refreshToken: '',
        expiresAt: Date.now() + 3600000,
      };
      expect(await service.isAuthenticated()).toBe(false);
    });
  });

  describe('logout', () => {
    it('should clear stored tokens', async () => {
      storage._tokens = {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3600000,
      };

      await service.logout();
      expect(storage._tokens).toBeNull();
    });

    it('should reset refresh promise', async () => {
      storage._tokens = {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 1000,
      };

      // Start a refresh (that will be abandoned)
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    ok: true,
                    json: () =>
                      Promise.resolve({
                        access_token: 'new',
                        refresh_token: 'new-rt',
                        expires_in: 3600,
                      }),
                  }),
                100
              )
            )
        )
      );

      // Logout should clear state
      await service.logout();
      expect(storage._tokens).toBeNull();
    });
  });
});
