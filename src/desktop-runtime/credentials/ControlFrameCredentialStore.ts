import type { CredentialStore } from '@/core/storage/CredentialStore';

export interface KeychainBridge {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, password: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
  listAccounts(service: string): Promise<string[]>;
}

export class ControlFrameCredentialStore implements CredentialStore {
  constructor(
    private readonly bridge: KeychainBridge,
    private readonly servicePrefix = 'applepi',
  ) {}

  private serviceName(service: string): string {
    return `${this.servicePrefix}-${service}`;
  }

  get(service: string, account: string): Promise<string | null> {
    return this.bridge.get(this.serviceName(service), account);
  }

  set(service: string, account: string, password: string): Promise<void> {
    return this.bridge.set(this.serviceName(service), account, password);
  }

  delete(service: string, account: string): Promise<void> {
    return this.bridge.delete(this.serviceName(service), account);
  }

  listAccounts(service: string): Promise<string[]> {
    return this.bridge.listAccounts(this.serviceName(service));
  }
}
