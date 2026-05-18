/**
 * Check: the effective agent configuration is structurally valid.
 *
 * Reads the cross-platform `AgentConfig` singleton (its `core/storage`
 * provider, NOT `IPlatformAdapter.getConfigStorage()` which is a stub on
 * server/desktop) and runs the shared `validateConfig`.
 *
 * @module core/diagnostics/checks/config-valid
 */

import type { DiagnosticCheck, DiagnosticResult } from '../types';
import { isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';

export const configValidCheck: DiagnosticCheck = {
  id: 'config-valid',
  title: 'Configuration valid',
  platforms: ['extension', 'desktop', 'server'],
  async run(): Promise<DiagnosticResult> {
    if (!isConfigStorageInitialized()) {
      return {
        id: 'config-valid',
        title: 'Configuration valid',
        status: 'warn',
        detail: 'Config storage not initialized yet.',
      };
    }

    const { AgentConfig } = await import('@/config/AgentConfig');
    const { validateConfig } = await import('@/config/validators');

    const agentConfig = await AgentConfig.getInstance();
    const config = agentConfig.getConfig();
    const result = validateConfig(config);

    if (!result.valid) {
      return {
        id: 'config-valid',
        title: 'Configuration valid',
        status: 'fail',
        detail: `Invalid configuration${
          result.field ? ` (field: ${result.field})` : ''
        }: ${result.error ?? 'unknown error'}`,
        data: { field: result.field },
      };
    }

    return {
      id: 'config-valid',
      title: 'Configuration valid',
      status: 'pass',
      detail: 'Configuration is structurally valid.',
    };
  },
};
