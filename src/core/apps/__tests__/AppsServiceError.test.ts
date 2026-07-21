import { describe, expect, it } from 'vitest';
import { appsErrorForStatus } from '../AppsServiceError';

describe('appsErrorForStatus', () => {
  it.each([
    [401, 'APPS_INVALID_CREDENTIAL', false],
    [403, 'APPS_FORBIDDEN', false],
    [404, 'APPS_NOT_FOUND', false],
    [409, 'APPS_CONFLICT', false],
    [422, 'APPS_INVALID_ARGUMENT', false],
    [429, 'APPS_RATE_LIMITED', true],
    [500, 'APPS_UNAVAILABLE', true],
    [503, 'APPS_UNAVAILABLE', true],
  ] as const)('maps HTTP %s to %s', (status, errorCode, retryable) => {
    expect(appsErrorForStatus(status)).toMatchObject({
      errorCode,
      retryable,
      httpStatus: status,
    });
  });

  it('never reflects an upstream response body in a user-facing error', () => {
    expect(appsErrorForStatus(500).message).not.toContain('upstream');
    expect(appsErrorForStatus(401).message).not.toContain('credential-value');
  });
});
