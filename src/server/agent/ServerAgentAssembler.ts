import { RepublicAgent } from '../../core/RepublicAgent';
import { createPromptLoader } from '../../core/PromptLoader';
import { AssembledAgentHandle } from '../../core/assembly/AgentAssembler';
import type {
  AgentAssembler,
  AssembleInput,
  AssembledAgent,
  CleanupStep,
  ManagerAction,
} from '../../core/assembly/AgentAssembler';
import type { IPlatformAdapter } from '../../core/platform/IPlatformAdapter';
import type { SubAgentRunner } from '../../tools/AgentTool/SubAgentRunner';
import type { RuntimeContext } from '../../prompts/PromptComposer';

export interface ServerAssemblyWiring {
  subAgentRunner: SubAgentRunner | null;
  cleanupSteps?: readonly CleanupStep[];
  applyManagerActions?: (actions: ReadonlySet<ManagerAction>) => Promise<void>;
}

export interface ServerAgentAssemblerOptions {
  createPlatformAdapter: (sessionId: string) => Promise<IPlatformAdapter> | IPlatformAdapter;
  agentType: 'workx-server' | 'workx-desktop';
  promptStaticContext: Readonly<Partial<RuntimeContext>>;
  wireAgent: (
    agent: RepublicAgent,
    input: AssembleInput,
  ) => Promise<ServerAssemblyWiring>;
}

/** Construction owner shared by headless server and desktop runtime. */
export class ServerAgentAssembler implements AgentAssembler {
  constructor(private readonly options: ServerAgentAssemblerOptions) {}

  async assemble(input: AssembleInput): Promise<AssembledAgent> {
    const platformAdapter = await this.options.createPlatformAdapter(input.sessionId);
    let agent: RepublicAgent | null = null;
    try {
      await platformAdapter.initialize();
      const initialHistory = input.kind === 'new'
        ? { mode: 'new' as const, sessionId: input.sessionId }
        : input.kind === 'resume'
          ? {
              mode: 'resumed' as const,
              sessionId: input.sessionId,
              rolloutItems: [...input.history.items],
            }
          : {
              mode: 'forked' as const,
              sessionId: input.sessionId,
              sourceConversationId: input.sourceSessionId
                ?? (() => { throw new Error('Fork assembly requires sourceSessionId'); })(),
              rolloutItems: [...input.history.items],
              historyAlreadyPersisted: input.historyAlreadyPersisted,
            };
      agent = new RepublicAgent(
        input.config,
        platformAdapter,
        initialHistory,
        undefined,
        undefined,
        input.services,
        {
          authContext: input.auth,
          sessionStartReason: input.kind === 'new' ? 'create' : 'hydrate',
          promptLoader: createPromptLoader({
            agentType: this.options.agentType,
            staticPlatformContext: this.options.promptStaticContext,
          }),
        },
      );
      agent.getSession().setAgentMode(input.preferences.agentMode);
      agent.setEventDispatcher(input.eventDispatcher);
      await agent.initialize();
      if (agent.getSession().sessionId !== input.sessionId) {
        throw new Error(
          `Agent assembly session ID mismatch: reserved ${input.sessionId}, received ${agent.getSession().sessionId}`,
        );
      }
      const wiring = await this.options.wireAgent(agent, input);
      return new AssembledAgentHandle(
        agent,
        wiring.subAgentRunner,
        wiring.cleanupSteps,
        wiring.applyManagerActions,
      );
    } catch (error) {
      if (agent) {
        await agent.dispose('assembly-failed').catch(() => undefined);
      } else {
        await platformAdapter.dispose().catch(() => undefined);
      }
      throw error;
    }
  }
}
