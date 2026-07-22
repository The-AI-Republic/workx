import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ErrorFactory,
  ErrorTypeGuards,
  ModelClientError,
  NetworkError,
} from '../ModelClientError';

describe('ModelClientError OSS credentials', () => {
  it('directs authentication failures to API-key settings', () => {
    const error = new AuthenticationError('invalid', 401, 'OpenAI');
    expect(error.getActionMessage()).toContain('API key');
    expect(ErrorTypeGuards.isAuthenticationError(error)).toBe(true);
  });

  it('creates provider authentication errors', () => {
    expect(ErrorFactory.createAuthError('invalid_key', 'OpenAI'))
      .toBeInstanceOf(AuthenticationError);
  });

  it('keeps provider-independent network errors', () => {
    const error = new NetworkError('offline', { code: 'ECONNREFUSED', attempts: 1, aborted: false });
    expect(error).toBeInstanceOf(ModelClientError);
    expect(error.isConnectionError()).toBe(true);
  });
});
