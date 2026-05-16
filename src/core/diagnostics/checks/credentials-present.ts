/**
 * Check: model-provider credentials are present.
 *
 * Reads the cross-platform `AgentConfig` + `CredentialStore` singletons.
 * Server-only sub-branch: a missing `VITE_VAULT_SECRET` makes every
 * `FileCredentialStore` read throw, so it is a hard fail on server.
 *
 * Never places a key value in `detail`/`data` — only presence booleans.
 *
 * @module core/diagnostics/checks/credentials-present
 */

import type {
  DiagnosticCheck,
  DiagnosticContext,
  DiagnosticResult,
} from '../types';
import { isCredentialStoreInitialized } from '@/core/storage/CredentialStore';

const ID = 'credentials-present';
const TITLE = 'Provider credentials present';

export const credentialsPresentCheck: DiagnosticCheck = {
  id: ID,
  title: TITLE,
  platforms: ['extension', 'desktop', 'server'],
  async run(ctx: DiagnosticContext): Promise<DiagnosticResult> {
    if (
      ctx.platformId === 'server' &&
      typeof process !== 'undefined' &&
      !process.env?.VITE_VAULT_SECRET
    ) {
      return {
        id: ID,
        title: TITLE,
        status: 'fail',
        detail:
          'VITE_VAULT_SECRET is not set — the encrypted credential store cannot be read on this server.',
      };
    }

    if (!isCredentialStoreInitialized()) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'Credential store not initialized yet.',
      };
    }

    const { AgentConfig } = await import('@/config/AgentConfig');
    const agentConfig = await AgentConfig.getInstance();
    const providers = agentConfig.getConfig().providers ?? {};
    const ids = Object.keys(providers);

    if (ids.length === 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'No providers configured.',
      };
    }

    const missing: string[] = [];
    for (const id of ids) {
      const marker = providers[id]?.apiKey === '[SECURED]';
      const key = marker ? '[SECURED]' : await agentConfig.getProviderApiKey(id);
      if (!key) missing.push(id);
    }

    if (missing.length === ids.length) {
      return {
        id: ID,
        title: TITLE,
        status: 'fail',
        detail: `No provider has a credential (${ids.length} configured).`,
        data: { configured: ids.length, withCredential: 0 },
      };
    }
    if (missing.length > 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: `${missing.length} of ${ids.length} provider(s) missing a credential: ${missing.join(', ')}.`,
        data: { configured: ids.length, missing },
      };
    }
    return {
      id: ID,
      title: TITLE,
      status: 'pass',
      detail: `All ${ids.length} configured provider(s) have a credential.`,
      data: { configured: ids.length, withCredential: ids.length },
    };
  },
};
