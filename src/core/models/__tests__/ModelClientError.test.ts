/**
 * Comprehensive unit tests for ModelClientError.ts
 *
 * Covers all error subclasses, factory methods, type guard functions,
 * human-readable descriptions, default values, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  ModelClientError,
  RateLimitError,
  UsageLimitReachedError,
  NetworkError,
  AuthenticationError,
  BackendRoutingError,
  QuotaExceededError,
  ModelError,
  ContentPolicyError,
  ErrorFactory,
  ErrorTypeGuards,
  type PlanType,
  type RateLimitMetadata,
  type UsageLimitMetadata,
  type NetworkMetadata,
} from '../ModelClientError';

// ---------------------------------------------------------------------------
// RateLimitError
// ---------------------------------------------------------------------------
describe('RateLimitError', () => {
  const baseMetadata: RateLimitMetadata = {
    limit: 60,
    remaining: 0,
    reset: 1700000000,
    window: 60,
    retryAfter: 3000,
  };

  it('should extend ModelClientError', () => {
    const err = new RateLimitError('rate limited', baseMetadata);
    expect(err).toBeInstanceOf(ModelClientError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should set name to RateLimitError', () => {
    const err = new RateLimitError('msg', baseMetadata);
    expect(err.name).toBe('RateLimitError');
  });

  it('should default statusCode to 429', () => {
    const err = new RateLimitError('msg', baseMetadata);
    expect(err.statusCode).toBe(429);
  });

  it('should accept a custom statusCode', () => {
    const err = new RateLimitError('msg', baseMetadata, 503);
    expect(err.statusCode).toBe(503);
  });

  it('should always be retryable', () => {
    const err = new RateLimitError('msg', baseMetadata);
    expect(err.retryable).toBe(true);
  });

  it('should propagate retryAfter from metadata', () => {
    const err = new RateLimitError('msg', baseMetadata);
    expect(err.retryAfter).toBe(3000);
  });

  it('should set retryAfter to undefined when metadata has no retryAfter', () => {
    const meta: RateLimitMetadata = { limit: 10, remaining: 0, reset: 0, window: 60 };
    const err = new RateLimitError('msg', meta);
    expect(err.retryAfter).toBeUndefined();
  });

  it('should store provider when provided', () => {
    const err = new RateLimitError('msg', baseMetadata, 429, 'anthropic');
    expect(err.provider).toBe('anthropic');
  });

  it('should leave provider undefined when not provided', () => {
    const err = new RateLimitError('msg', baseMetadata);
    expect(err.provider).toBeUndefined();
  });

  it('should expose rateLimitMetadata as readonly', () => {
    const err = new RateLimitError('msg', baseMetadata);
    expect(err.rateLimitMetadata).toEqual(baseMetadata);
  });

  describe('getRateLimitDescription', () => {
    it('should include limit, remaining, and ISO reset time', () => {
      const desc = new RateLimitError('msg', baseMetadata).getRateLimitDescription();
      expect(desc).toContain('Rate limit of 60 requests per 60s exceeded');
      expect(desc).toContain('0 requests remaining');
      const expectedDate = new Date(baseMetadata.reset * 1000).toISOString();
      expect(desc).toContain(expectedDate);
    });

    it('should handle zero limit and window', () => {
      const meta: RateLimitMetadata = { limit: 0, remaining: 0, reset: 0, window: 0 };
      const desc = new RateLimitError('msg', meta).getRateLimitDescription();
      expect(desc).toContain('Rate limit of 0 requests per 0s exceeded');
    });
  });
});

// ---------------------------------------------------------------------------
// UsageLimitReachedError
// ---------------------------------------------------------------------------
describe('UsageLimitReachedError', () => {
  const baseMeta: UsageLimitMetadata = {
    planType: 'free',
    currentUsage: 50,
    planLimit: 50,
    suggestedPlan: 'pro',
  };

  it('should extend ModelClientError', () => {
    const err = new UsageLimitReachedError('usage limit', baseMeta);
    expect(err).toBeInstanceOf(ModelClientError);
  });

  it('should set name to UsageLimitReachedError', () => {
    expect(new UsageLimitReachedError('m', baseMeta).name).toBe('UsageLimitReachedError');
  });

  it('should default statusCode to 402', () => {
    expect(new UsageLimitReachedError('m', baseMeta).statusCode).toBe(402);
  });

  it('should not be retryable', () => {
    expect(new UsageLimitReachedError('m', baseMeta).retryable).toBe(false);
  });

  it('should store usageLimitMetadata', () => {
    expect(new UsageLimitReachedError('m', baseMeta).usageLimitMetadata).toEqual(baseMeta);
  });

  describe('getUsageLimitDescription', () => {
    it('should format limited plan description', () => {
      const desc = new UsageLimitReachedError('m', baseMeta).getUsageLimitDescription();
      expect(desc).toBe('Usage limit reached for free plan: 50/50');
    });

    it('should format unlimited plan description (planLimit = -1)', () => {
      const meta: UsageLimitMetadata = { planType: 'enterprise', currentUsage: 9999, planLimit: -1 };
      const desc = new UsageLimitReachedError('m', meta).getUsageLimitDescription();
      expect(desc).toBe('Unlimited usage for enterprise plan, current usage: 9999');
    });

    it('should handle null planType', () => {
      const meta: UsageLimitMetadata = { planType: null, currentUsage: 10, planLimit: 100 };
      const desc = new UsageLimitReachedError('m', meta).getUsageLimitDescription();
      expect(desc).toContain('null');
    });
  });

  describe('hasUpgradeSuggestion', () => {
    it('should return true when suggestedPlan is set', () => {
      expect(new UsageLimitReachedError('m', baseMeta).hasUpgradeSuggestion()).toBe(true);
    });

    it('should return false when suggestedPlan is undefined', () => {
      const meta: UsageLimitMetadata = { planType: 'team', currentUsage: 100, planLimit: 100 };
      expect(new UsageLimitReachedError('m', meta).hasUpgradeSuggestion()).toBe(false);
    });

    it('should return false when suggestedPlan is null', () => {
      const meta: UsageLimitMetadata = { planType: 'team', currentUsage: 100, planLimit: 100, suggestedPlan: null };
      expect(new UsageLimitReachedError('m', meta).hasUpgradeSuggestion()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// NetworkError
// ---------------------------------------------------------------------------
describe('NetworkError', () => {
  const baseMeta: NetworkMetadata = { attempts: 1, aborted: false };

  it('should extend ModelClientError', () => {
    expect(new NetworkError('net err', baseMeta)).toBeInstanceOf(ModelClientError);
  });

  it('should set name to NetworkError', () => {
    expect(new NetworkError('m', baseMeta).name).toBe('NetworkError');
  });

  it('should be retryable when not aborted', () => {
    expect(new NetworkError('m', baseMeta).retryable).toBe(true);
  });

  it('should not be retryable when aborted', () => {
    expect(new NetworkError('m', { attempts: 0, aborted: true }).retryable).toBe(false);
  });

  it('should store networkMetadata', () => {
    const meta: NetworkMetadata = { attempts: 3, aborted: false, code: 'ENOTFOUND', timeout: 5000 };
    expect(new NetworkError('m', meta).networkMetadata).toEqual(meta);
  });

  describe('isTimeout', () => {
    it('should return true for ETIMEDOUT code', () => {
      expect(new NetworkError('m', { attempts: 0, aborted: false, code: 'ETIMEDOUT' }).isTimeout()).toBe(true);
    });

    it('should return true when timeout property is set', () => {
      expect(new NetworkError('m', { attempts: 0, aborted: false, timeout: 30000 }).isTimeout()).toBe(true);
    });

    it('should return false for non-timeout errors', () => {
      expect(new NetworkError('m', { attempts: 0, aborted: false, code: 'ECONNRESET' }).isTimeout()).toBe(false);
    });

    it('should return false when no code and no timeout', () => {
      expect(new NetworkError('m', baseMeta).isTimeout()).toBe(false);
    });
  });

  describe('isConnectionError', () => {
    it.each(['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED'] as const)(
      'should return true for %s',
      (code) => {
        expect(new NetworkError('m', { attempts: 0, aborted: false, code }).isConnectionError()).toBe(true);
      }
    );

    it('should return false for ETIMEDOUT', () => {
      expect(new NetworkError('m', { attempts: 0, aborted: false, code: 'ETIMEDOUT' }).isConnectionError()).toBe(false);
    });

    it('should return false when code is undefined', () => {
      expect(new NetworkError('m', baseMeta).isConnectionError()).toBe(false);
    });

    it('should return false for unknown codes', () => {
      expect(new NetworkError('m', { attempts: 0, aborted: false, code: 'EUNKNOWN' }).isConnectionError()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AuthenticationError
// ---------------------------------------------------------------------------
describe('AuthenticationError', () => {
  it('should extend ModelClientError', () => {
    expect(new AuthenticationError('auth fail')).toBeInstanceOf(ModelClientError);
  });

  it('should set name to AuthenticationError', () => {
    expect(new AuthenticationError('m').name).toBe('AuthenticationError');
  });

  it('should default statusCode to 401', () => {
    expect(new AuthenticationError('m').statusCode).toBe(401);
  });

  it('should default authSource to provider', () => {
    expect(new AuthenticationError('m').authSource).toBe('provider');
  });

  it('should not be retryable', () => {
    expect(new AuthenticationError('m').retryable).toBe(false);
  });

  it('should accept backend authSource', () => {
    const err = new AuthenticationError('m', 401, 'openai', 'backend');
    expect(err.authSource).toBe('backend');
  });

  describe('isBackendSessionError', () => {
    it('should return true for backend source', () => {
      expect(new AuthenticationError('m', 401, undefined, 'backend').isBackendSessionError()).toBe(true);
    });

    it('should return false for provider source', () => {
      expect(new AuthenticationError('m').isBackendSessionError()).toBe(false);
    });
  });

  describe('getActionMessage', () => {
    it('should return login message for backend auth', () => {
      const msg = new AuthenticationError('m', 401, undefined, 'backend').getActionMessage();
      expect(msg).toBe('Please log in again to continue using the AI agent.');
    });

    it('should return API key message for provider auth', () => {
      const msg = new AuthenticationError('m').getActionMessage();
      expect(msg).toBe('Please check your API key in settings.');
    });
  });
});

// ---------------------------------------------------------------------------
// BackendRoutingError
// ---------------------------------------------------------------------------
describe('BackendRoutingError', () => {
  it('should extend ModelClientError', () => {
    expect(new BackendRoutingError('m', 'backend_error')).toBeInstanceOf(ModelClientError);
  });

  it('should set name to BackendRoutingError', () => {
    expect(new BackendRoutingError('m', 'backend_error').name).toBe('BackendRoutingError');
  });

  it('should always set provider to Backend', () => {
    expect(new BackendRoutingError('m', 'session_expired').provider).toBe('Backend');
  });

  it('should be retryable only for backend_unreachable', () => {
    expect(new BackendRoutingError('m', 'backend_unreachable').retryable).toBe(true);
    expect(new BackendRoutingError('m', 'session_expired').retryable).toBe(false);
    expect(new BackendRoutingError('m', 'backend_error').retryable).toBe(false);
  });

  it('should store errorType', () => {
    expect(new BackendRoutingError('m', 'session_expired').errorType).toBe('session_expired');
  });

  describe('requiresReauth', () => {
    it('should return true for session_expired', () => {
      expect(new BackendRoutingError('m', 'session_expired').requiresReauth()).toBe(true);
    });

    it('should return false for backend_unreachable', () => {
      expect(new BackendRoutingError('m', 'backend_unreachable').requiresReauth()).toBe(false);
    });

    it('should return false for backend_error', () => {
      expect(new BackendRoutingError('m', 'backend_error').requiresReauth()).toBe(false);
    });
  });

  describe('getActionMessage', () => {
    it('should return session expired message', () => {
      expect(new BackendRoutingError('m', 'session_expired').getActionMessage())
        .toBe('Your session has expired. Please log in again.');
    });

    it('should return connection message for unreachable', () => {
      expect(new BackendRoutingError('m', 'backend_unreachable').getActionMessage())
        .toBe('Unable to reach the server. Please check your connection and try again.');
    });

    it('should return try-again message for backend error', () => {
      expect(new BackendRoutingError('m', 'backend_error').getActionMessage())
        .toBe('The server encountered an error. Please try again later.');
    });
  });
});

// ---------------------------------------------------------------------------
// QuotaExceededError
// ---------------------------------------------------------------------------
describe('QuotaExceededError', () => {
  it('should extend ModelClientError', () => {
    expect(new QuotaExceededError('q', 'pro')).toBeInstanceOf(ModelClientError);
  });

  it('should set name to QuotaExceededError', () => {
    expect(new QuotaExceededError('q', 'pro').name).toBe('QuotaExceededError');
  });

  it('should default statusCode to 402', () => {
    expect(new QuotaExceededError('q', 'free').statusCode).toBe(402);
  });

  it('should not be retryable', () => {
    expect(new QuotaExceededError('q', 'free').retryable).toBe(false);
  });

  it('should store planType', () => {
    expect(new QuotaExceededError('q', 'enterprise').planType).toBe('enterprise');
  });

  it('should handle null planType', () => {
    expect(new QuotaExceededError('q', null).planType).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ModelError
// ---------------------------------------------------------------------------
describe('ModelError', () => {
  it('should extend ModelClientError', () => {
    expect(new ModelError('m', 'gpt-4')).toBeInstanceOf(ModelClientError);
  });

  it('should set name to ModelError', () => {
    expect(new ModelError('m', 'gpt-4').name).toBe('ModelError');
  });

  it('should default retryable to false', () => {
    expect(new ModelError('m', 'gpt-4').retryable).toBe(false);
  });

  it('should accept retryable=true', () => {
    expect(new ModelError('m', 'gpt-4', 503, 'openai', true).retryable).toBe(true);
  });

  it('should store modelName', () => {
    expect(new ModelError('m', 'claude-3-opus').modelName).toBe('claude-3-opus');
  });
});

// ---------------------------------------------------------------------------
// ContentPolicyError
// ---------------------------------------------------------------------------
describe('ContentPolicyError', () => {
  it('should extend ModelClientError', () => {
    expect(new ContentPolicyError('m', 'violence')).toBeInstanceOf(ModelClientError);
  });

  it('should set name to ContentPolicyError', () => {
    expect(new ContentPolicyError('m').name).toBe('ContentPolicyError');
  });

  it('should default contentType to unknown', () => {
    expect(new ContentPolicyError('m').contentType).toBe('unknown');
  });

  it('should default statusCode to 400', () => {
    expect(new ContentPolicyError('m').statusCode).toBe(400);
  });

  it('should not be retryable', () => {
    expect(new ContentPolicyError('m').retryable).toBe(false);
  });

  it('should store custom contentType', () => {
    expect(new ContentPolicyError('m', 'hate_speech').contentType).toBe('hate_speech');
  });
});

// ---------------------------------------------------------------------------
// ErrorFactory
// ---------------------------------------------------------------------------
describe('ErrorFactory', () => {
  describe('createRateLimitError', () => {
    it('should parse all standard rate limit headers', () => {
      const headers: Record<string, string> = {
        'x-ratelimit-limit': '200',
        'x-ratelimit-remaining': '10',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-window': '60',
        'retry-after': '30',
      };
      const err = ErrorFactory.createRateLimitError(headers, 'openai');
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.rateLimitMetadata.limit).toBe(200);
      expect(err.rateLimitMetadata.remaining).toBe(10);
      expect(err.rateLimitMetadata.reset).toBe(1700000000);
      expect(err.rateLimitMetadata.window).toBe(60);
      expect(err.rateLimitMetadata.retryAfter).toBe(30000); // seconds * 1000
    });

    it('should default numeric fields to 0 when headers are empty', () => {
      const err = ErrorFactory.createRateLimitError({});
      expect(err.rateLimitMetadata.limit).toBe(0);
      expect(err.rateLimitMetadata.remaining).toBe(0);
      expect(err.rateLimitMetadata.reset).toBe(0);
      expect(err.rateLimitMetadata.window).toBe(3600); // default fallback
    });

    it('should set retryAfter to undefined when retry-after header missing', () => {
      const err = ErrorFactory.createRateLimitError({ 'x-ratelimit-limit': '100' });
      expect(err.rateLimitMetadata.retryAfter).toBeUndefined();
    });

    it('should set statusCode to 429', () => {
      expect(ErrorFactory.createRateLimitError({}).statusCode).toBe(429);
    });

    it('should build message containing remaining/limit', () => {
      const err = ErrorFactory.createRateLimitError({
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '3',
      });
      expect(err.message).toContain('3/50');
    });

    it('should set provider when supplied', () => {
      expect(ErrorFactory.createRateLimitError({}, 'anthropic').provider).toBe('anthropic');
    });

    it('should leave provider undefined when not supplied', () => {
      expect(ErrorFactory.createRateLimitError({}).provider).toBeUndefined();
    });
  });

  describe('createUsageLimitError', () => {
    it('should suggest pro for free plan', () => {
      const err = ErrorFactory.createUsageLimitError('free', 100, 100);
      expect(err.usageLimitMetadata.suggestedPlan).toBe('pro');
    });

    it('should suggest team for pro plan', () => {
      const err = ErrorFactory.createUsageLimitError('pro', 1000, 1000);
      expect(err.usageLimitMetadata.suggestedPlan).toBe('team');
    });

    it('should not suggest upgrade for team plan', () => {
      const err = ErrorFactory.createUsageLimitError('team', 5000, 5000);
      expect(err.usageLimitMetadata.suggestedPlan).toBeUndefined();
    });

    it('should not suggest upgrade for enterprise plan', () => {
      const err = ErrorFactory.createUsageLimitError('enterprise', 10000, -1);
      expect(err.usageLimitMetadata.suggestedPlan).toBeUndefined();
    });

    it('should not suggest upgrade for null plan', () => {
      const err = ErrorFactory.createUsageLimitError(null, 0, 0);
      expect(err.usageLimitMetadata.suggestedPlan).toBeUndefined();
    });

    it('should build correct message for limited plans', () => {
      const err = ErrorFactory.createUsageLimitError('pro', 500, 500, 'openai');
      expect(err.message).toContain('500/500');
      expect(err.message).toContain('pro');
    });

    it('should build correct message for unlimited plans (planLimit=-1)', () => {
      const err = ErrorFactory.createUsageLimitError('enterprise', 2000, -1);
      expect(err.message).toContain('Unexpected usage limit reached');
    });

    it('should always return status 402', () => {
      expect(ErrorFactory.createUsageLimitError('free', 10, 10).statusCode).toBe(402);
    });
  });

  describe('createNetworkError', () => {
    it('should map ETIMEDOUT to "Request timed out"', () => {
      expect(ErrorFactory.createNetworkError({ code: 'ETIMEDOUT' }).message).toBe('Request timed out');
    });

    it('should map ENOTFOUND to "DNS lookup failed"', () => {
      expect(ErrorFactory.createNetworkError({ code: 'ENOTFOUND' }).message).toBe('DNS lookup failed');
    });

    it('should map ECONNRESET to "Connection was reset"', () => {
      expect(ErrorFactory.createNetworkError({ code: 'ECONNRESET' }).message).toBe('Connection was reset');
    });

    it('should map ECONNREFUSED to "Connection was refused"', () => {
      expect(ErrorFactory.createNetworkError({ code: 'ECONNREFUSED' }).message).toBe('Connection was refused');
    });

    it('should map AbortError to "Request was aborted"', () => {
      const err = ErrorFactory.createNetworkError({ name: 'AbortError' });
      expect(err.message).toBe('Request was aborted');
      expect(err.networkMetadata.aborted).toBe(true);
      expect(err.retryable).toBe(false);
    });

    it('should fall back to generic message for unknown errors', () => {
      expect(ErrorFactory.createNetworkError({}).message).toBe('Network error occurred');
    });

    it('should default attempts to 0', () => {
      expect(ErrorFactory.createNetworkError({}).networkMetadata.attempts).toBe(0);
    });

    it('should propagate attempts argument', () => {
      expect(ErrorFactory.createNetworkError({}, 5).networkMetadata.attempts).toBe(5);
    });

    it('should propagate timeout from the original error', () => {
      const err = ErrorFactory.createNetworkError({ timeout: 15000 });
      expect(err.networkMetadata.timeout).toBe(15000);
    });
  });

  describe('createAuthError', () => {
    it.each([
      ['invalid_key', 'Invalid API key provided'],
      ['expired_key', 'API key has expired'],
      ['insufficient_permissions', 'API key has insufficient permissions'],
      ['unknown', 'Authentication failed'],
    ] as const)('should return correct message for reason=%s', (reason, expectedMsg) => {
      expect(ErrorFactory.createAuthError(reason).message).toBe(expectedMsg);
    });

    it('should default to unknown reason', () => {
      expect(ErrorFactory.createAuthError().message).toBe('Authentication failed');
    });

    it('should set provider and authSource', () => {
      const err = ErrorFactory.createAuthError('invalid_key', 'anthropic', 'backend');
      expect(err.provider).toBe('anthropic');
      expect(err.authSource).toBe('backend');
    });

    it('should default authSource to provider', () => {
      expect(ErrorFactory.createAuthError('unknown', 'openai').authSource).toBe('provider');
    });
  });

  describe('createBackendRoutingError', () => {
    it.each([
      ['session_expired', 'Session expired'],
      ['backend_unreachable', 'Unable to reach the backend server'],
      ['backend_error', 'Backend server error'],
    ] as const)('should contain relevant text for errorType=%s', (errorType, substring) => {
      const err = ErrorFactory.createBackendRoutingError(errorType);
      expect(err.message).toContain(substring);
      expect(err.errorType).toBe(errorType);
    });

    it('should pass statusCode through', () => {
      expect(ErrorFactory.createBackendRoutingError('session_expired', 401).statusCode).toBe(401);
    });

    it('should leave statusCode undefined when not provided', () => {
      expect(ErrorFactory.createBackendRoutingError('backend_error').statusCode).toBeUndefined();
    });
  });

  describe('createSessionExpiredError', () => {
    it('should create a session_expired BackendRoutingError', () => {
      const err = ErrorFactory.createSessionExpiredError();
      expect(err).toBeInstanceOf(BackendRoutingError);
      expect(err.errorType).toBe('session_expired');
      expect(err.statusCode).toBe(401);
    });

    it('should require re-authentication', () => {
      expect(ErrorFactory.createSessionExpiredError().requiresReauth()).toBe(true);
    });
  });

  describe('createModelError', () => {
    it.each([
      ['not_found', false, 404],
      ['unavailable', true, 503],
      ['deprecated', false, 400],
      ['unsupported_feature', false, 400],
      ['unknown', false, 400],
    ] as const)('reason=%s -> retryable=%s, statusCode=%i', (reason, retryable, statusCode) => {
      const err = ErrorFactory.createModelError('test-model', reason, 'openai');
      expect(err.retryable).toBe(retryable);
      expect(err.statusCode).toBe(statusCode);
      expect(err.modelName).toBe('test-model');
    });

    it('should include model name in message', () => {
      expect(ErrorFactory.createModelError('gpt-4o', 'not_found').message).toContain('gpt-4o');
    });
  });

  describe('createContentPolicyError', () => {
    it('should create ContentPolicyError with contentType in message', () => {
      const err = ErrorFactory.createContentPolicyError('violence', 'openai');
      expect(err).toBeInstanceOf(ContentPolicyError);
      expect(err.contentType).toBe('violence');
      expect(err.message).toContain('violence');
      expect(err.provider).toBe('openai');
    });

    it('should set statusCode to 400', () => {
      expect(ErrorFactory.createContentPolicyError('hate').statusCode).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// ErrorTypeGuards
// ---------------------------------------------------------------------------
describe('ErrorTypeGuards', () => {
  // Create one instance of every error type
  const rateLimitErr = new RateLimitError('rl', { limit: 1, remaining: 0, reset: 0, window: 60 });
  const usageLimitErr = new UsageLimitReachedError('ul', { planType: 'free', currentUsage: 1, planLimit: 1 });
  const networkErr = new NetworkError('ne', { attempts: 0, aborted: false });
  const authErr = new AuthenticationError('auth');
  const backendErr = new BackendRoutingError('br', 'backend_error');
  const quotaErr = new QuotaExceededError('q', 'free');
  const modelErr = new ModelError('me', 'gpt-4');
  const contentErr = new ContentPolicyError('cp');
  const baseErr = new ModelClientError('base');
  const plainError = new Error('plain');

  describe('isRateLimitError', () => {
    it('should return true for RateLimitError', () => expect(ErrorTypeGuards.isRateLimitError(rateLimitErr)).toBe(true));
    it('should return false for other ModelClientErrors', () => expect(ErrorTypeGuards.isRateLimitError(networkErr)).toBe(false));
    it('should return false for null', () => expect(ErrorTypeGuards.isRateLimitError(null)).toBe(false));
    it('should return false for undefined', () => expect(ErrorTypeGuards.isRateLimitError(undefined)).toBe(false));
    it('should return false for a string', () => expect(ErrorTypeGuards.isRateLimitError('error')).toBe(false));
  });

  describe('isUsageLimitError', () => {
    it('should return true for UsageLimitReachedError', () => expect(ErrorTypeGuards.isUsageLimitError(usageLimitErr)).toBe(true));
    it('should return false for other types', () => expect(ErrorTypeGuards.isUsageLimitError(rateLimitErr)).toBe(false));
    it('should return false for plain object', () => expect(ErrorTypeGuards.isUsageLimitError({})).toBe(false));
  });

  describe('isNetworkError', () => {
    it('should return true for NetworkError', () => expect(ErrorTypeGuards.isNetworkError(networkErr)).toBe(true));
    it('should return false for plain Error', () => expect(ErrorTypeGuards.isNetworkError(plainError)).toBe(false));
    it('should return false for number', () => expect(ErrorTypeGuards.isNetworkError(42)).toBe(false));
  });

  describe('isAuthenticationError', () => {
    it('should return true for AuthenticationError', () => expect(ErrorTypeGuards.isAuthenticationError(authErr)).toBe(true));
    it('should return false for BackendRoutingError', () => expect(ErrorTypeGuards.isAuthenticationError(backendErr)).toBe(false));
  });

  describe('isBackendRoutingError', () => {
    it('should return true for BackendRoutingError', () => expect(ErrorTypeGuards.isBackendRoutingError(backendErr)).toBe(true));
    it('should return false for AuthenticationError', () => expect(ErrorTypeGuards.isBackendRoutingError(authErr)).toBe(false));
  });

  describe('isQuotaError', () => {
    it('should return true for QuotaExceededError', () => expect(ErrorTypeGuards.isQuotaError(quotaErr)).toBe(true));
    it('should return false for UsageLimitReachedError', () => expect(ErrorTypeGuards.isQuotaError(usageLimitErr)).toBe(false));
  });

  describe('isModelError', () => {
    it('should return true for ModelError', () => expect(ErrorTypeGuards.isModelError(modelErr)).toBe(true));
    it('should return false for ContentPolicyError', () => expect(ErrorTypeGuards.isModelError(contentErr)).toBe(false));
  });

  describe('isContentPolicyError', () => {
    it('should return true for ContentPolicyError', () => expect(ErrorTypeGuards.isContentPolicyError(contentErr)).toBe(true));
    it('should return false for ModelError', () => expect(ErrorTypeGuards.isContentPolicyError(modelErr)).toBe(false));
  });

  describe('isModelClientError', () => {
    it('should return true for base ModelClientError', () => expect(ErrorTypeGuards.isModelClientError(baseErr)).toBe(true));
    it('should return true for all subclasses', () => {
      expect(ErrorTypeGuards.isModelClientError(rateLimitErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(usageLimitErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(networkErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(authErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(backendErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(quotaErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(modelErr)).toBe(true);
      expect(ErrorTypeGuards.isModelClientError(contentErr)).toBe(true);
    });
    it('should return false for plain Error', () => expect(ErrorTypeGuards.isModelClientError(plainError)).toBe(false));
    it('should return false for null', () => expect(ErrorTypeGuards.isModelClientError(null)).toBe(false));
    it('should return false for undefined', () => expect(ErrorTypeGuards.isModelClientError(undefined)).toBe(false));
    it('should return false for non-error object', () => expect(ErrorTypeGuards.isModelClientError({ name: 'ModelClientError' })).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// Error inheritance chain verification
// ---------------------------------------------------------------------------
describe('Error inheritance chains', () => {
  it('all subclasses should be instances of Error', () => {
    const errors = [
      new RateLimitError('rl', { limit: 1, remaining: 0, reset: 0, window: 60 }),
      new UsageLimitReachedError('ul', { planType: 'free', currentUsage: 0, planLimit: 0 }),
      new NetworkError('ne', { attempts: 0, aborted: false }),
      new AuthenticationError('auth'),
      new BackendRoutingError('br', 'backend_error'),
      new QuotaExceededError('q', 'free'),
      new ModelError('me', 'model'),
      new ContentPolicyError('cp'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ModelClientError);
    }
  });

  it('all subclasses should have a proper stack trace', () => {
    const err = new RateLimitError('rl', { limit: 1, remaining: 0, reset: 0, window: 60 });
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });
});
