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

export function createCredentialServices(_deps: CredentialServiceDeps): Record<string, ServiceHandler> {
  return {
    'credentials.get': async (params) => {
      const { service, account } = params as { service: string; account: string };
      return { value: await requireStore().get(service, account) };
    },
    'credentials.set': async (params) => {
      const { service, account, password } = params as {
        service: string;
        account: string;
        password: string;
      };
      await requireStore().set(service, account, password);
      return { ok: true };
    },
    'credentials.delete': async (params) => {
      const { service, account } = params as { service: string; account: string };
      await requireStore().delete(service, account);
      return { ok: true };
    },
    'credentials.listAccounts': async (params) => {
      const { service } = params as { service: string };
      return { accounts: await requireStore().listAccounts(service) };
    },
  };
}
