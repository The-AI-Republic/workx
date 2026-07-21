import type { ComponentErrorCode } from './types';

export class ComponentError extends Error {
  constructor(
    public readonly code: ComponentErrorCode,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ComponentError';
  }
}
