/**
 * Extended error classes for model client error handling
 */

import { ModelClientError } from './ModelClient';
import { t } from '@/extension/sidepanel/lib/i18n';

/**
 * Plan type metadata for usage tracking
 */
export type PlanType = 'free' | 'pro' | 'team' | 'enterprise' | null;

/**
 * Rate limit metadata from API responses
 */
export interface RateLimitMetadata {
  /** Limit per time window */
  limit: number;
  /** Remaining requests in current window */
  remaining: number;
  /** Window reset time (Unix timestamp) */
  reset: number;
  /** Window duration in seconds */
  window: number;
  /** Retry after delay in milliseconds */
  retryAfter?: number;
}

/**
 * Usage limit metadata for plan-specific errors
 */
export interface UsageLimitMetadata {
  /** User's current plan type */
  planType: PlanType;
  /** Current usage amount */
  currentUsage: number;
  /** Plan limit (-1 for unlimited) */
  planLimit: number;
  /** Reset time for usage counter (Unix timestamp) */
  resetTime?: number;
  /** Suggested upgrade plan */
  suggestedPlan?: PlanType;
}

/**
 * Network error metadata
 */
export interface NetworkMetadata {
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Number of previous retry attempts */
  attempts: number;
  /** Original error code */
  code?: string;
  /** Whether connection was aborted */
  aborted: boolean;
}

/**
 * Error thrown when rate limits are exceeded
 */
export class RateLimitError extends ModelClientError {
  public readonly rateLimitMetadata: RateLimitMetadata;

  constructor(
    message: string,
    rateLimitMetadata: RateLimitMetadata,
    statusCode: number = 429,
    provider?: string
  ) {
    super(
      message,
      statusCode,
      provider,
      true, // Rate limit errors are retryable
      rateLimitMetadata.retryAfter
    );
    this.name = 'RateLimitError';
    this.rateLimitMetadata = rateLimitMetadata;
  }

  /**
   * Get human-readable rate limit description
   */
  getRateLimitDescription(): string {
    const resetDate = new Date(this.rateLimitMetadata.reset * 1000);
    return `Rate limit of ${this.rateLimitMetadata.limit} requests per ${this.rateLimitMetadata.window}s exceeded. ` +
           `${this.rateLimitMetadata.remaining} requests remaining. Resets at ${resetDate.toISOString()}.`;
  }
}

/**
 * Error thrown when usage limits are reached for a plan
 */
export class UsageLimitReachedError extends ModelClientError {
  public readonly usageLimitMetadata: UsageLimitMetadata;

  constructor(
    message: string,
    usageLimitMetadata: UsageLimitMetadata,
    statusCode: number = 402,
    provider?: string
  ) {
    super(
      message,
      statusCode,
      provider,
      false, // Usage limit errors are not retryable without plan upgrade
      undefined
    );
    this.name = 'UsageLimitReachedError';
    this.usageLimitMetadata = usageLimitMetadata;
  }

  /**
   * Get human-readable usage limit description
   */
  getUsageLimitDescription(): string {
    const { planType, currentUsage, planLimit } = this.usageLimitMetadata;
    if (planLimit === -1) {
      return `Unlimited usage for ${planType} plan, current usage: ${currentUsage}`;
    }
    return `Usage limit reached for ${planType} plan: ${currentUsage}/${planLimit}`;
  }

  /**
   * Check if upgrade is available
   */
  hasUpgradeSuggestion(): boolean {
    return this.usageLimitMetadata.suggestedPlan != null;
  }
}

/**
 * Error thrown for network-related failures
 */
export class NetworkError extends ModelClientError {
  public readonly networkMetadata: NetworkMetadata;

  constructor(
    message: string,
    networkMetadata: NetworkMetadata,
    statusCode?: number,
    provider?: string
  ) {
    super(
      message,
      statusCode,
      provider,
      !networkMetadata.aborted, // Retryable unless aborted
      undefined
    );
    this.name = 'NetworkError';
    this.networkMetadata = networkMetadata;
  }

  /**
   * Check if error was due to timeout
   */
  isTimeout(): boolean {
    return this.networkMetadata.code === 'ETIMEDOUT' ||
           this.networkMetadata.timeout != null;
  }

  /**
   * Check if error was due to connection issues
   */
  isConnectionError(): boolean {
    const connectionCodes = ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED'];
    return connectionCodes.indexOf(this.networkMetadata.code || '') !== -1;
  }
}

/**
 * Error thrown for authentication failures
 */
export class AuthenticationError extends ModelClientError {
  public readonly authSource: 'backend' | 'provider';

  constructor(
    message: string,
    statusCode: number = 401,
    provider?: string,
    authSource: 'backend' | 'provider' = 'provider'
  ) {
    super(
      message,
      statusCode,
      provider,
      false // Auth errors are not retryable without credential update
    );
    this.name = 'AuthenticationError';
    this.authSource = authSource;
  }

  /**
   * Check if error is from backend session (vs provider API key)
   */
  isBackendSessionError(): boolean {
    return this.authSource === 'backend';
  }

  /**
   * Get user-friendly action message
   */
  getActionMessage(): string {
    if (this.authSource === 'backend') {
      return t('Please log in again to continue using the AI agent.');
    }
    return t('Please check your API key in settings.');
  }
}

/**
 * Error thrown specifically for backend routing failures
 */
export class BackendRoutingError extends ModelClientError {
  public readonly errorType: 'session_expired' | 'backend_unreachable' | 'backend_error';

  constructor(
    message: string,
    errorType: 'session_expired' | 'backend_unreachable' | 'backend_error',
    statusCode?: number
  ) {
    super(
      message,
      statusCode,
      'Backend',
      errorType === 'backend_unreachable' // Only unreachable errors are potentially retryable
    );
    this.name = 'BackendRoutingError';
    this.errorType = errorType;
  }

  /**
   * Check if error requires re-authentication
   */
  requiresReauth(): boolean {
    return this.errorType === 'session_expired';
  }

  /**
   * Get user-friendly action message
   */
  getActionMessage(): string {
    switch (this.errorType) {
      case 'session_expired':
        return t('Your session has expired. Please log in again.');
      case 'backend_unreachable':
        return t('Unable to reach the server. Please check your connection and try again.');
      case 'backend_error':
        return t('The server encountered an error. Please try again later.');
    }
  }
}

/**
 * Error thrown for quota/billing issues
 */
export class QuotaExceededError extends ModelClientError {
  public readonly planType: PlanType;

  constructor(
    message: string,
    planType: PlanType,
    statusCode: number = 402,
    provider?: string
  ) {
    super(
      message,
      statusCode,
      provider,
      false // Quota errors are not retryable without payment
    );
    this.name = 'QuotaExceededError';
    this.planType = planType;
  }
}

/**
 * Error thrown for model-specific issues
 */
export class ModelError extends ModelClientError {
  public readonly modelName: string;

  constructor(
    message: string,
    modelName: string,
    statusCode?: number,
    provider?: string,
    retryable: boolean = false
  ) {
    super(message, statusCode, provider, retryable);
    this.name = 'ModelError';
    this.modelName = modelName;
  }
}

/**
 * Error thrown for content policy violations
 */
export class ContentPolicyError extends ModelClientError {
  public readonly contentType: string;

  constructor(
    message: string,
    contentType: string = 'unknown',
    statusCode: number = 400,
    provider?: string
  ) {
    super(
      message,
      statusCode,
      provider,
      false // Content policy errors are not retryable
    );
    this.name = 'ContentPolicyError';
    this.contentType = contentType;
  }
}

/**
 * Factory functions for creating common error scenarios
 */
export class ErrorFactory {
  /**
   * Create a rate limit error from API response headers
   */
  static createRateLimitError(
    headers: Record<string, string>,
    provider?: string
  ): RateLimitError {
    const rateLimitMetadata: RateLimitMetadata = {
      limit: parseInt(headers['x-ratelimit-limit'] || '0'),
      remaining: parseInt(headers['x-ratelimit-remaining'] || '0'),
      reset: parseInt(headers['x-ratelimit-reset'] || '0'),
      window: parseInt(headers['x-ratelimit-window'] || '3600'),
      retryAfter: headers['retry-after'] ? parseInt(headers['retry-after']) * 1000 : undefined,
    };

    const message = `Rate limit exceeded: ${rateLimitMetadata.remaining}/${rateLimitMetadata.limit} requests remaining`;
    return new RateLimitError(message, rateLimitMetadata, 429, provider);
  }

  /**
   * Create a usage limit error for specific plan types
   */
  static createUsageLimitError(
    planType: PlanType,
    currentUsage: number,
    planLimit: number,
    provider?: string
  ): UsageLimitReachedError {
    const usageLimitMetadata: UsageLimitMetadata = {
      planType,
      currentUsage,
      planLimit,
      suggestedPlan: planType === 'free' ? 'pro' : planType === 'pro' ? 'team' : undefined,
    };

    let message: string;
    if (planLimit === -1) {
      message = `Unexpected usage limit reached for ${planType} plan`;
    } else {
      message = `Usage limit reached: ${currentUsage}/${planLimit} for ${planType} plan`;
    }

    return new UsageLimitReachedError(message, usageLimitMetadata, 402, provider);
  }

  /**
   * Create a network error from a caught exception
   */
  static createNetworkError(
    error: any,
    attempts: number = 0,
    provider?: string
  ): NetworkError {
    const networkMetadata: NetworkMetadata = {
      attempts,
      code: error.code,
      aborted: error.name === 'AbortError',
      timeout: error.timeout,
    };

    let message = t('Network error occurred');
    if (error.code === 'ETIMEDOUT') {
      message = t('Request timed out');
    } else if (error.code === 'ENOTFOUND') {
      message = t('DNS lookup failed');
    } else if (error.code === 'ECONNRESET') {
      message = t('Connection was reset');
    } else if (error.code === 'ECONNREFUSED') {
      message = t('Connection was refused');
    } else if (networkMetadata.aborted) {
      message = t('Request was aborted');
    }

    return new NetworkError(message, networkMetadata, undefined, provider);
  }

  /**
   * Create an authentication error
   */
  static createAuthError(
    reason: 'invalid_key' | 'expired_key' | 'insufficient_permissions' | 'unknown' = 'unknown',
    provider?: string,
    authSource: 'backend' | 'provider' = 'provider'
  ): AuthenticationError {
    const messages = {
      invalid_key: t('Invalid API key provided'),
      expired_key: t('API key has expired'),
      insufficient_permissions: t('API key has insufficient permissions'),
      unknown: t('Authentication failed'),
    };

    return new AuthenticationError(messages[reason], 401, provider, authSource);
  }

  /**
   * Create a backend routing error
   */
  static createBackendRoutingError(
    errorType: 'session_expired' | 'backend_unreachable' | 'backend_error',
    statusCode?: number
  ): BackendRoutingError {
    const messages = {
      session_expired: t('Session expired - please log in again to continue using the AI agent'),
      backend_unreachable: t('Unable to reach the backend server - please check your connection'),
      backend_error: t('Backend server error - please try again later'),
    };

    return new BackendRoutingError(messages[errorType], errorType, statusCode);
  }

  /**
   * Create a backend session expired error (convenience method)
   */
  static createSessionExpiredError(): BackendRoutingError {
    return ErrorFactory.createBackendRoutingError('session_expired', 401);
  }

  /**
   * Create a model-specific error
   */
  static createModelError(
    modelName: string,
    reason: 'not_found' | 'unavailable' | 'deprecated' | 'unsupported_feature' | 'unknown',
    provider?: string
  ): ModelError {
    const messages = {
      not_found: `Model '${modelName}' not found`,
      unavailable: `Model '${modelName}' is currently unavailable`,
      deprecated: `Model '${modelName}' is deprecated`,
      unsupported_feature: `Model '${modelName}' does not support the requested feature`,
      unknown: `Error with model '${modelName}'`,
    };

    const retryable = reason === 'unavailable';
    const statusCode = reason === 'not_found' ? 404 : reason === 'unavailable' ? 503 : 400;

    return new ModelError(messages[reason], modelName, statusCode, provider, retryable);
  }

  /**
   * Create a content policy error
   */
  static createContentPolicyError(
    contentType: string,
    provider?: string
  ): ContentPolicyError {
    const message = t(`Content violates policy: ${contentType} content is not allowed`);
    return new ContentPolicyError(message, contentType, 400, provider);
  }
}

/**
 * Type guard functions for error identification
 */
export class ErrorTypeGuards {
  static isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }

  static isUsageLimitError(error: unknown): error is UsageLimitReachedError {
    return error instanceof UsageLimitReachedError;
  }

  static isNetworkError(error: unknown): error is NetworkError {
    return error instanceof NetworkError;
  }

  static isAuthenticationError(error: unknown): error is AuthenticationError {
    return error instanceof AuthenticationError;
  }

  static isBackendRoutingError(error: unknown): error is BackendRoutingError {
    return error instanceof BackendRoutingError;
  }

  static isQuotaError(error: unknown): error is QuotaExceededError {
    return error instanceof QuotaExceededError;
  }

  static isModelError(error: unknown): error is ModelError {
    return error instanceof ModelError;
  }

  static isContentPolicyError(error: unknown): error is ContentPolicyError {
    return error instanceof ContentPolicyError;
  }

  static isModelClientError(error: unknown): error is ModelClientError {
    return error instanceof ModelClientError;
  }
}

// Re-export the base ModelClientError for convenience
export { ModelClientError } from './ModelClient';