import { RepublicAgent } from '../../core/RepublicAgent';
import { createPromptLoader } from '../../core/PromptLoader';
import { UserNotifier } from '../../core/UserNotifier';
import { ApprovalGate } from '../../core/approval/ApprovalGate';
import { PolicyRulesEngine } from '../../core/approval/PolicyRulesEngine';
import { getDefaultRules } from '../../core/approval/defaultRules';
import { DomainSensitivityEnhancer } from '../../core/approval/enhancers/DomainSensitivityEnhancer';
import { SemanticElementEnhancer } from '../../core/approval/enhancers/SemanticElementEnhancer';
import { ApprovalConfigStorage } from '../../core/approval/ApprovalConfigStorage';
import { getConfigStorage } from '../../core/storage/ConfigStorageProvider';
import {
  createPaymentCapability,
  getX402Config,
  isX402Enabled,
  NoopSigner,
} from '../../core/payments/x402';
import { registerSubAgentTool } from '../../tools/AgentTool/register';
import { registerPlanReviewTools } from '../../tools/planReview/PlanReviewTools';
import type { SubAgentRunner } from '../../tools/AgentTool/SubAgentRunner';
import type { IPlatformAdapter } from '../../core/platform/IPlatformAdapter';
import type {
  AgentAssembler,
  AssembleInput,
  AssembledAgent,
  CleanupStep,
  ManagerAction,
} from '../../core/assembly/AgentAssembler';
import { AssembledAgentHandle } from '../../core/assembly/AgentAssembler';
import { supportsAgentMode, type AgentMode } from '../../prompts/PromptComposer';

export interface ExtensionAssemblyContribution {
  dispose?: () => Promise<void> | void;
  applyManagerActions?: (actions: ReadonlySet<ManagerAction>) => Promise<void>;
}

export interface ExtensionAgentAssemblerOptions {
  platformAdapterFactory: (sessionId: string) => IPlatformAdapter;
  bindAgent?: (
    agent: RepublicAgent,
    context: { subAgentRunner: SubAgentRunner | null },
  ) => Promise<ExtensionAssemblyContribution | void> | ExtensionAssemblyContribution | void;
}

/** Owns the complete extension runtime graph and its reverse-order teardown. */
export class ExtensionAgentAssembler implements AgentAssembler {
  constructor(private readonly options: ExtensionAgentAssemblerOptions) {}

  supportsMode(mode: AgentMode): boolean {
    return supportsAgentMode('workx', mode);
  }

  async assemble(input: AssembleInput): Promise<AssembledAgent> {
    const platformAdapter = this.options.platformAdapterFactory(input.sessionId);
    let agent: RepublicAgent | null = null;
    let contribution: ExtensionAssemblyContribution | void;
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
        new UserNotifier(),
        input.services,
        {
          authContext: input.auth,
          sessionStartReason: input.kind === 'new' ? 'create' : 'hydrate',
          promptLoader: createPromptLoader({
            agentType: 'workx',
            staticPlatformContext: {
              browserConnection: 'extension',
              personaName: input.config.getConfig().preferences?.personaName,
            },
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

      await this.configureApproval(agent);
      const approvalGate = agent.getToolRegistry().getApprovalGate();
      if (approvalGate) {
        await registerPlanReviewTools({
          registry: agent.getToolRegistry(),
          approvalManager: agent.getApprovalManager(),
          approvalGate,
          platformId: 'extension',
          recordPlanArtifact: (payload) =>
            agent!.getSession().persistRolloutItems([{ type: 'plan_artifact', payload }]),
        });
      }
      this.configurePayments(agent);

      const engine = agent.getEngine();
      const subAgentRunner = engine ? await registerSubAgentTool(engine) : null;
      contribution = await this.options.bindAgent?.(agent, { subAgentRunner });
      const cleanupSteps: CleanupStep[] = [
        ...(contribution?.dispose
          ? [{ id: 'extension-contribution', run: () => contribution!.dispose!() }]
          : []),
      ];
      return new AssembledAgentHandle(
        agent,
        subAgentRunner,
        cleanupSteps,
        contribution?.applyManagerActions,
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

  private async configureApproval(agent: RepublicAgent): Promise<void> {
    const approvalGate = new ApprovalGate(
      agent.getApprovalManager(),
      new PolicyRulesEngine(getDefaultRules('extension')),
    );
    approvalGate.addEnhancer(new DomainSensitivityEnhancer());
    approvalGate.addEnhancer(new SemanticElementEnhancer());
    approvalGate.setHookDispatcher(agent.getHookDispatcher());
    const configStorage = new ApprovalConfigStorage(() => getConfigStorage());
    approvalGate.setConfigStorage(configStorage);
    const storedConfig = await configStorage.loadConfig();
    approvalGate.setMode(storedConfig.mode);
    approvalGate.setTrustedDomains(storedConfig.trustedDomains || []);
    approvalGate.setBlockedDomains(storedConfig.blockedDomains || []);
    agent.getToolRegistry().setApprovalGate(approvalGate);
  }

  private configurePayments(agent: RepublicAgent): void {
    agent.getToolRegistry().setPaymentCapability(
      createPaymentCapability({
        platform: 'extension',
        isEnabled: isX402Enabled,
        getCaps: async () => {
          const config = await getX402Config();
          return {
            network: config.network,
            maxPaymentPerRequestUSD: config.maxPaymentPerRequestUSD,
            maxSessionSpendUSD: config.maxSessionSpendUSD,
          };
        },
        signer: new NoopSigner(),
        audit: (level, message, data) => {
          const log = level === 'warn'
            ? console.warn
            : level === 'error'
              ? console.error
              : console.log;
          log(`[x402] ${message}`, data ?? '');
        },
      }),
    );
  }
}
