import type { AgentConfig } from '../../config/AgentConfig';
import type { RepublicAgent, EventDispatcher, RebuildReason } from '../RepublicAgent';
import type { SessionServices } from '../session/state/SessionServices';
import type { AuthContext } from '../auth/AuthContext';
import type { AgentMode } from '../../prompts/PromptComposer';
import type { SessionWorkspace } from '../TurnExecutionContext';
import type { RolloutItem } from '../../storage/rollout/types';
import type { SubAgentRunner } from '../../tools/AgentTool/SubAgentRunner';

export interface RolloutSnapshot {
  sessionId: string;
  revision: number;
  items: readonly RolloutItem[];
}

export type ThreadTitleSource = 'generated' | 'manual' | 'fallback';
export type ThreadOrigin = 'new' | 'resumed' | 'forked' | 'imported';

export type ManagerAction = 'reload-hooks' | 'reload-approval' | 'rebind-plugins';

export interface AssembleInput {
  sessionId: string;
  kind: 'new' | 'resume' | 'fork';
  history: RolloutSnapshot;
  historyAlreadyPersisted: boolean;
  sourceSessionId?: string;
  workspace?: SessionWorkspace;
  config: AgentConfig;
  auth: AuthContext;
  services: SessionServices;
  preferences: { agentMode: AgentMode };
  metadata: {
    title: string;
    titleSource: ThreadTitleSource;
    origin: ThreadOrigin;
  };
  eventDispatcher: EventDispatcher;
}

export type AgentDisposeReason =
  | 'suspend'
  | 'compat-close'
  | 'delete'
  | 'shutdown'
  | 'completed'
  | 'error'
  | 'tab-closed'
  | 'manual'
  | 'assembly-failed';

export interface DisposeReport {
  ok: boolean;
  failedSteps: string[];
}

export interface AssembledAgent {
  readonly agent: RepublicAgent;
  readonly subAgentRunner: SubAgentRunner | null;
  applyManagerActions(actions: ReadonlySet<ManagerAction>): Promise<void>;
  applyConfigImpact?(
    rebuild: ReadonlySet<RebuildReason>,
    actions: ReadonlySet<ManagerAction>,
  ): Promise<void>;
  drainConfigImpact?(): Promise<void>;
  flushRollout(): Promise<void>;
  dispose(reason: AgentDisposeReason): Promise<DisposeReport>;
}

export interface AgentAssembler {
  supportsMode?(mode: AgentMode): boolean;
  assemble(input: AssembleInput): Promise<AssembledAgent>;
}

export interface CleanupStep {
  readonly id: string;
  run(reason: AgentDisposeReason): Promise<void> | void;
}

/**
 * Idempotent assembled-graph owner. Every step is attempted in reverse
 * construction order and repeat disposal returns the same report promise.
 */
export class AssembledAgentHandle implements AssembledAgent {
  private disposePromise: Promise<DisposeReport> | null = null;
  private disposing = false;
  private readonly pendingManagerActions = new Set<ManagerAction>();
  private readonly pendingRebuildReasons = new Set<RebuildReason>();
  private managerActionTail: Promise<void> = Promise.resolve();

  constructor(
    readonly agent: RepublicAgent,
    readonly subAgentRunner: SubAgentRunner | null,
    private readonly cleanupSteps: readonly CleanupStep[] = [],
    private readonly managerActionHandler?: (
      actions: ReadonlySet<ManagerAction>,
    ) => Promise<void>,
  ) {
  }

  applyManagerActions(actions: ReadonlySet<ManagerAction>): Promise<void> {
    return this.applyConfigImpact(new Set(), actions);
  }

  applyConfigImpact(
    rebuild: ReadonlySet<RebuildReason>,
    actions: ReadonlySet<ManagerAction>,
  ): Promise<void> {
    if (this.disposing) return Promise.resolve();
    for (const reason of rebuild) this.pendingRebuildReasons.add(reason);
    for (const action of actions) this.pendingManagerActions.add(action);
    if (this.agent.getSession().hasLiveBackgroundWork()) return Promise.resolve();
    return this.drainManagerActions();
  }

  drainConfigImpact(): Promise<void> {
    if (this.disposing || this.agent.getSession().hasLiveBackgroundWork()) {
      return Promise.resolve();
    }
    return this.drainManagerActions();
  }

  flushRollout(): Promise<void> {
    return this.agent.getSession().flushRollout();
  }

  dispose(reason: AgentDisposeReason): Promise<DisposeReport> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeOnce(reason);
    return this.disposePromise;
  }

  private async disposeOnce(reason: AgentDisposeReason): Promise<DisposeReport> {
    this.disposing = true;
    this.pendingManagerActions.clear();
    this.pendingRebuildReasons.clear();
    await this.managerActionTail.catch(() => undefined);
    const steps: CleanupStep[] = [
      { id: 'agent', run: () => this.agent.dispose(reason) },
      ...this.cleanupSteps,
    ];
    const failedSteps: string[] = [];
    for (const step of steps.reverse()) {
      try {
        await step.run(reason);
      } catch {
        failedSteps.push(step.id);
      }
    }
    return { ok: failedSteps.length === 0, failedSteps };
  }

  private drainManagerActions(): Promise<void> {
    const drain = async () => {
      while (
        !this.disposing
        && (this.pendingManagerActions.size > 0 || this.pendingRebuildReasons.size > 0)
        && !this.agent.getSession().hasLiveBackgroundWork()
      ) {
        const actions = new Set(this.pendingManagerActions);
        const rebuild = new Set(this.pendingRebuildReasons);
        this.pendingManagerActions.clear();
        this.pendingRebuildReasons.clear();
        try {
          await this.agent.applyManagerActions(actions);
          await this.managerActionHandler?.(actions);
          if (rebuild.size > 0) await this.agent.rebuildExecutionContext(rebuild);
        } catch (error) {
          // Nothing is silently lost. A later idle notification/config change
          // can retry the coalesced action set, and the tail remains usable.
          for (const action of actions) this.pendingManagerActions.add(action);
          for (const reason of rebuild) this.pendingRebuildReasons.add(reason);
          throw error;
        }
      }
    };
    this.managerActionTail = this.managerActionTail.then(drain, drain);
    return this.managerActionTail;
  }
}

export function rebuildReasonsForManagerActions(
  actions: ReadonlySet<ManagerAction>,
): ReadonlySet<RebuildReason> {
  const reasons = new Set<RebuildReason>();
  if (actions.has('rebind-plugins')) {
    reasons.add('tools');
    reasons.add('prompt');
  }
  return reasons;
}
