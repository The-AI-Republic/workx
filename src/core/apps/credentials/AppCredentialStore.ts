import { getCredentialStore, type CredentialStore } from '../../storage/CredentialStore';
import type { OAuthClientRegistration, OAuthTokenSet } from '../types';

const TOKEN_ACCOUNT = 'oauth-token';
const REGISTRATION_ACCOUNT = 'oauth-client-registration';

function tokenService(appId: string): string {
  return `apps:${appId}`;
}

export class AppCredentialStore {
  constructor(private readonly credentials: CredentialStore = getCredentialStore()) {}

  async getOAuthToken(appId: string): Promise<OAuthTokenSet | null> {
    const raw = await this.credentials.get(tokenService(appId), TOKEN_ACCOUNT);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as OAuthTokenSet;
    } catch (error) {
      console.warn(`[AppCredentialStore] Invalid OAuth token payload for app ${appId}:`, error);
      return null;
    }
  }

  async saveOAuthToken(appId: string, token: OAuthTokenSet): Promise<void> {
    await this.credentials.set(tokenService(appId), TOKEN_ACCOUNT, JSON.stringify(token));
  }

  async deleteOAuthToken(appId: string): Promise<void> {
    await this.credentials.delete(tokenService(appId), TOKEN_ACCOUNT);
  }

  async getOAuthClientRegistration(appId: string): Promise<OAuthClientRegistration | null> {
    const raw = await this.credentials.get(tokenService(appId), REGISTRATION_ACCOUNT);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as OAuthClientRegistration;
    } catch (error) {
      console.warn(`[AppCredentialStore] Invalid OAuth registration payload for app ${appId}:`, error);
      return null;
    }
  }

  async saveOAuthClientRegistration(appId: string, registration: OAuthClientRegistration): Promise<void> {
    await this.credentials.set(tokenService(appId), REGISTRATION_ACCOUNT, JSON.stringify(registration));
  }

  async deleteOAuthClientRegistration(appId: string): Promise<void> {
    await this.credentials.delete(tokenService(appId), REGISTRATION_ACCOUNT);
  }

  async deleteAppSecrets(appId: string): Promise<void> {
    await Promise.all([
      this.deleteOAuthToken(appId),
      this.deleteOAuthClientRegistration(appId),
    ]);
  }
}
