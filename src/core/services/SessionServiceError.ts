export type SessionServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_DELETED'
  | 'SESSION_NOT_LIVE'
  | 'STALE_CONTROL'
  | 'CAPACITY_FULL'
  | 'QUEUE_FULL'
  | 'BUSY';

export class SessionServiceError extends Error {
  constructor(
    readonly errorCode: SessionServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SessionServiceError';
  }
}
