/**
 * Credential Service Handlers
 *
 * Platform-agnostic `credentials.*` service handlers that expose the runtime's
 * credential store (OS keychain on desktop, chrome.storage in the extension
 * service worker) to callers that cannot reach it directly.
 *
 * The desktop **webview** has no access to the OS keychain — that store is only
 * initialized in the `desktop-runtime` sidecar (`ServerAgentBootstrap`). Without
 * these handlers, a webview-side `AgentConfig` silently drops BYOK API keys
 * (`AgentConfig.getCredentials()` returns null), so saved keys vanish on reload.
 * The webview's `RuntimeRelayCredentialStore` forwards get/set/delete/list here
 * so credential operations execute where the real store lives.
 *
 * @module core/services/credentials-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import { getCredentialStore, isCredentialStoreInitialized } from '@/core/storage';

export interface CredentialServiceDeps {
  /**
   * Reserved for future injected dependencies. The handlers use the runtime's
   * global credential-store singleton, but a deps object is still required so
   * `registerAllServices` wires the factory.
   */
  enabled?: boolean;
}

function requireStore() {
  if (!isCredentialStoreInitialized()) {
    throw new Error('Credential store is not initialized in this runtime');
  }
  return getCredentialStore();
}

const MODEL_SERVICE = 'workx';
const MODEL_ACCOUNT = /^provider-apikey-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireModelCredential(
  params: Record<string, unknown>,
  requireAccount = true
): { service: string; account?: string } {
  const service = params.service;
  const account = params.account;
  if (service !== MODEL_SERVICE) {
    throw new Error('Credential namespace is not available through the generic relay');
  }
  if (requireAccount && (typeof account !== 'string' || !MODEL_ACCOUNT.test(account))) {
    throw new Error('Credential account is not available through the generic relay');
  }
  return { service, account: typeof account === 'string' ? account : undefined };
}

export function createCredentialServices(
  _deps: CredentialServiceDeps
): Record<string, ServiceHandler> {
  return {
    'credentials.get': async (params) => {
      const { service, account } = requireModelCredential(params);
      return { value: await requireStore().get(service, account!) };
    },
    'credentials.set': async (params) => {
      const { service, account } = requireModelCredential(params);
      const password = params.password;
      if (typeof password !== 'string' || password.length > 64 * 1024)
        throw new Error('Invalid credential value');
      await requireStore().set(service, account!, password);
      return { ok: true };
    },
    'credentials.delete': async (params) => {
      const { service, account } = requireModelCredential(params);
      await requireStore().delete(service, account!);
      return { ok: true };
    },
    'credentials.listAccounts': async (params) => {
      const { service } = requireModelCredential(params, false);
      const accounts = await requireStore().listAccounts(service);
      return { accounts: accounts.filter((account) => MODEL_ACCOUNT.test(account)) };
    },
  };
}
