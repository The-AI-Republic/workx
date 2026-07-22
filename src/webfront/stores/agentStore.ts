/**
 * Agent Store for Side Panel UI
 *
 * Stores agent ready state and authentication mode information.
 * Used to reactively display warnings and status in the UI.
 */

import { writable, type Writable } from 'svelte/store';
import { t } from '../lib/i18n';
import type { AgentAccessMode, AgentAccessState } from '@/core/services/runtime-state';

/**
 * Agent state interface
 */
export interface AgentState {
  /** Whether the agent is ready to process requests */
  ready: boolean;
  /** Current authentication mode */
  authMode: AgentAccessMode;
  /** Status message for the user */
  message?: string;
  /** Current provider name */
  provider?: string;
  /** Current model name */
  model?: string;
}

const DEFAULT_STATE: AgentState = {
  ready: false,
  authMode: 'none',
  message: t('Checking agent status...'),
};

/**
 * Create the agent store
 */
function createAgentStore() {
  const { subscribe, set, update }: Writable<AgentState> = writable(DEFAULT_STATE);

  return {
    subscribe,

    /**
     * Set agent as ready with API key mode
     */
    setApiKeyMode: (provider?: string, model?: string) => {
      set({
        ready: true,
        authMode: 'api_key',
        message: undefined,
        provider,
        model,
      });
    },

    /**
     * Set agent as not ready with no access
     */
    setNoAccess: (message?: string, provider?: string, model?: string) => {
      set({
        ready: false,
        authMode: 'none',
        message: message || t('No access configured. Please configure an API key.'),
        provider,
        model,
      });
    },

    /**
     * Update state from health check response
     */
    updateFromHealthCheck: (response: {
      ready: boolean;
      message?: string;
      provider?: string;
      model?: string;
      authMode?: AgentAccessMode;
    }) => {
      set({
        ready: response.ready,
        authMode: response.authMode || 'none',
        message: response.message,
        provider: response.provider,
        model: response.model,
      });
    },

    /**
     * Update state from the runtime-owned access state contract.
     */
    updateFromAccessState: (access: AgentAccessState) => {
      set({
        ready: access.ready,
        authMode: access.mode,
        message: access.reason,
        provider: access.provider,
        model: access.model,
      });
    },

    /**
     * Set loading state
     */
    setLoading: () => {
      update((state) => ({
        ...state,
        message: t('Checking agent status...'),
      }));
    },

    /**
     * Reset to default state
     */
    reset: () => {
      set(DEFAULT_STATE);
    },
  };
}

export const agentStore = createAgentStore();
