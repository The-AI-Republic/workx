/**
 * Runtime-relay credential store (rendered Desktop/extension Webfront).
 *
 * The desktop webview cannot reach the OS keychain — that store lives in the
 * Node `desktop-runtime` sidecar. This implementation satisfies the
 * `CredentialStore` interface by forwarding every operation over the runtime
 * channel (`credentials.*` service handlers) so the real keychain set/get/delete
 * happens in the sidecar. Installing it via `setCredentialStore()` at desktop
 * boot makes the webview's `AgentConfig` persist BYOK API keys correctly instead
 * of silently dropping them.
 *
 * @module webfront/credentials/RuntimeRelayCredentialStore
 */

import type { CredentialStore } from '@/core/storage/CredentialStore';
import { getInitializedUIClient } from '@/core/messaging';

export class RuntimeRelayCredentialStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | null> {
    const client = await getInitializedUIClient();
    const { value } = await client.serviceRequest<{ value: string | null }>('credentials.get', {
      service,
      account,
    });
    return value ?? null;
  }

  async set(service: string, account: string, password: string): Promise<void> {
    const client = await getInitializedUIClient();
    await client.serviceRequest('credentials.set', { service, account, password });
  }

  async delete(service: string, account: string): Promise<void> {
    const client = await getInitializedUIClient();
    await client.serviceRequest('credentials.delete', { service, account });
  }

  async listAccounts(service: string): Promise<string[]> {
    const client = await getInitializedUIClient();
    const { accounts } = await client.serviceRequest<{ accounts: string[] }>(
      'credentials.listAccounts',
      { service }
    );
    return accounts ?? [];
  }
}
