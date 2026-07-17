import type { IConfigChangeEvent } from '../../config/types';
import type { RebuildReason } from '../RepublicAgent';
import type { ManagerAction } from '../assembly/AgentAssembler';

export type ConfigSection = IConfigChangeEvent['section'];

export interface ConfigImpact {
  rebuild: readonly RebuildReason[];
  actions: readonly ManagerAction[];
}

export const CONFIG_IMPACT = {
  model: { rebuild: ['model', 'prompt'], actions: [] },
  efficientModel: { rebuild: [], actions: [] },
  provider: { rebuild: ['provider'], actions: [] },
  profile: { rebuild: ['full'], actions: [] },
  preferences: { rebuild: ['prompt'], actions: [] },
  cache: { rebuild: [], actions: [] },
  extension: { rebuild: [], actions: [] },
  security: { rebuild: [], actions: [] },
  approval: { rebuild: [], actions: ['reload-approval'] },
  hooks: { rebuild: [], actions: ['reload-hooks'] },
  tools: { rebuild: ['tools', 'prompt'], actions: [] },
  policy: {
    rebuild: ['full'],
    actions: ['reload-hooks', 'reload-approval', 'rebind-plugins'],
  },
  enabledPlugins: {
    rebuild: ['tools', 'prompt'],
    actions: ['rebind-plugins'],
  },
  appServer: { rebuild: [], actions: [] },
} as const satisfies Record<ConfigSection, ConfigImpact>;

export function getConfigImpact(section: ConfigSection): ConfigImpact {
  return CONFIG_IMPACT[section];
}
