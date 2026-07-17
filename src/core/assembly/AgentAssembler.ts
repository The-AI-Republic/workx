import type { AgentConfig } from '../../config/AgentConfig';
import type { RepublicAgent, EventDispatcher, RebuildReason } from '../RepublicAgent';
import type { SessionServices } from '../session/state/SessionServices';
import type { AuthContext } from '../auth/AuthContext';
import type { AgentMode } from '../../prompts/PromptComposer';
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
  flushRollout(): Promise<void>;
  dispose(reason: AgentDisposeReason): Promise<DisposeReport>;
}

export interface AgentAssembler {
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
  private readonly pendingManagerActions = new Set<ManagerAction>();
  private managerActionTail: Promise<void> = Promise.resolve();
  private readonly workUnsubscribe: () => void;

  constructor(
    readonly agent: RepublicAgent,
    readonly subAgentRunner: SubAgentRunner | null,
    private readonly cleanupSteps: readonly CleanupStep[] = [],
    private readonly managerActionHandler?: (
      actions: ReadonlySet<ManagerAction>,
    ) => Promise<void>,
  ) {
    this.workUnsubscribe = this.agent.getSession().subscribeBackgroundWorkChanged((busy) => {
      if (!busy) void this.drainManagerActions();
    });
  }

  applyManagerActions(actions: ReadonlySet<ManagerAction>): Promise<void> {
    for (const action of actions) this.pendingManagerActions.add(action);
    if (this.agent.getSession().hasLiveBackgroundWork()) return Promise.resolve();
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
    this.workUnsubscribe();
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
    this.managerActionTail = this.managerActionTail.then(async () => {
      while (
        this.pendingManagerActions.size > 0
        && !this.agent.getSession().hasLiveBackgroundWork()
      ) {
        const actions = new Set(this.pendingManagerActions);
        this.pendingManagerActions.clear();
        await this.agent.applyManagerActions(actions);
        await this.managerActionHandler?.(actions);
      }
    });
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
