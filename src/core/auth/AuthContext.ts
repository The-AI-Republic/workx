import type { IAuthManager } from '../models/types/Auth';

export type AuthChangeReason =
  | 'login'
  | 'logout'
  | 'routing'
  | 'credentials-refreshed';

export interface AuthChangedEvent {
  generation: number;
  previous: IAuthManager | null;
  current: IAuthManager | null;
  reason: AuthChangeReason;
}

export interface AuthContext {
  current(): IAuthManager | null;
  generation(): number;
  subscribe(listener: (event: AuthChangedEvent) => void): () => void;
}

export interface MutableAuthContext extends AuthContext {
  update(next: IAuthManager | null, reason: AuthChangeReason): void;
}

export class MutableAuthContextImpl implements MutableAuthContext {
  private value: IAuthManager | null;
  private currentGeneration = 0;
  private readonly listeners = new Set<(event: AuthChangedEvent) => void>();

  constructor(initial: IAuthManager | null = null) {
    this.value = initial;
  }

  current(): IAuthManager | null {
    return this.value;
  }

  generation(): number {
    return this.currentGeneration;
  }

  subscribe(listener: (event: AuthChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(next: IAuthManager | null, reason: AuthChangeReason): void {
    const previous = this.value;
    this.value = next;
    this.currentGeneration += 1;
    const event: AuthChangedEvent = {
      generation: this.currentGeneration,
      previous,
      current: next,
      reason,
    };
    for (const listener of [...this.listeners]) listener(event);
  }
}

export function createMutableAuthContext(initial: IAuthManager | null = null): MutableAuthContext {
  return new MutableAuthContextImpl(initial);
}

export const TestAuthContext = {
  none(): MutableAuthContext {
    return createMutableAuthContext(null);
  },
};
