import type { AgentAssembler, AssembledAgent } from '../core/assembly/AgentAssembler';
import type { RepublicAgent } from '../core/RepublicAgent';
import type { RegistryConfig } from '../core/registry/types';

let submissionSequence = 0;

/** Minimal real-contract assembler for registry integration and performance tests. */
export function lifecycleTestRegistryConfig(
  overrides: RegistryConfig = {},
): RegistryConfig {
  const assembler: AgentAssembler = {
    async assemble(input): Promise<AssembledAgent> {
      const workListeners = new Set<(busy: boolean) => void>();
      const session = {
        sessionId: input.sessionId,
        getAgentMode: () => input.preferences.agentMode,
        hasLiveBackgroundWork: () => false,
        subscribeBackgroundWorkChanged(listener: (busy: boolean) => void) {
          workListeners.add(listener);
          return () => workListeners.delete(listener);
        },
        abortAllTasks: async () => undefined,
        cancelLifecycleWork: async () => undefined,
        flushRollout: async () => undefined,
      };
      const agent = {
        getSession: () => session,
        submitOperation: async () => `sub_${++submissionSequence}`,
        rebuildExecutionContext: async () => undefined,
        applyManagerActions: async () => undefined,
        dispose: async () => undefined,
        getEngine: () => null,
      } as unknown as RepublicAgent;
      return {
        agent,
        subAgentRunner: null,
        applyManagerActions: async () => undefined,
        flushRollout: async () => undefined,
        dispose: async () => ({ ok: true, failedSteps: [] }),
      };
    },
  };
  return {
    agentAssembler: assembler,
    assemblyServicesFactory: async () => ({} as never),
    ...overrides,
  };
}
