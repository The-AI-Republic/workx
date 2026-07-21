export type AppsServiceErrorCode =
  | 'APPS_NOT_CONFIGURED'
  | 'APPS_BACKEND_INCOMPATIBLE'
  | 'APPS_AUTH_METHOD_DISABLED'
  | 'APPS_API_KEY_REQUIRED'
  | 'APPS_LOGIN_REQUIRED'
  | 'APPS_INVALID_CREDENTIAL'
  | 'APPS_FORBIDDEN'
  | 'APPS_INVALID_ARGUMENT'
  | 'APPS_NOT_FOUND'
  | 'APPS_CONFLICT'
  | 'APPS_RATE_LIMITED'
  | 'APPS_UNAVAILABLE'
  | 'APPS_INVALID_RESPONSE';

export class AppsServiceError extends Error {
  constructor(
    readonly errorCode: AppsServiceErrorCode,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = 'AppsServiceError';
  }
}

export function appsErrorForStatus(status: number): AppsServiceError {
  if (status === 401)
    return new AppsServiceError(
      'APPS_INVALID_CREDENTIAL',
      'OpenHub rejected the credential.',
      false,
      status
    );
  if (status === 403)
    return new AppsServiceError(
      'APPS_FORBIDDEN',
      'This credential does not have the required Apps permissions.',
      false,
      status
    );
  if (status === 404)
    return new AppsServiceError(
      'APPS_NOT_FOUND',
      'The requested app was not found.',
      false,
      status
    );
  if (status === 409)
    return new AppsServiceError(
      'APPS_CONFLICT',
      'The app changed state. Refresh and try again.',
      false,
      status
    );
  if (status === 429)
    return new AppsServiceError(
      'APPS_RATE_LIMITED',
      'OpenHub is receiving too many requests. Try again shortly.',
      true,
      status
    );
  if (status >= 500)
    return new AppsServiceError(
      'APPS_UNAVAILABLE',
      'OpenHub is temporarily unavailable.',
      true,
      status
    );
  return new AppsServiceError(
    'APPS_INVALID_ARGUMENT',
    'OpenHub rejected the request.',
    false,
    status
  );
}
