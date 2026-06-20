import type { PostTurnContext } from '../sessionSummary/SessionSummaryHook';
import type { Session } from '../Session';
import type { ModelClient } from '../models/ModelClient';
import { shouldAutoCompactTokens } from './tokenPressure';

export const MAX_CONSECUTIVE_AUTO_COMPACT_FAILURES = 3;

export interface AutoCompactHookOptions {
  session: Session;
  getModelClient: () => ModelClient | undefined;
  submitCompact: () => string;
  maxConsecutiveFailures?: number;
}

export class AutoCompactHook {
  private readonly session: Session;
  private readonly getModelClient: () => ModelClient | undefined;
  private readonly submitCompact: () => string;
  private readonly maxConsecutiveFailures: number;

  private unregisterPostTurn?: () => void;
  private pending = false;
  private consecutiveFailures = 0;
  private queuedAtCompactionCount: number | undefined;
  private lastQueuedTokenTotal = 0;

  constructor(options: AutoCompactHookOptions) {
    this.session = options.session;
    this.getModelClient = options.getModelClient;
    this.submitCompact = options.submitCompact;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_AUTO_COMPACT_FAILURES;
  }

  attach(registerPostTurnHook: (fn: (ctx: PostTurnContext) => Promise<void>) => () => void): void {
    if (this.unregisterPostTurn) return;
    this.unregisterPostTurn = registerPostTurnHook((ctx) => this.handlePostTurn(ctx));
  }

  detach(): void {
    this.unregisterPostTurn?.();
    this.unregisterPostTurn = undefined;
    this.pending = false;
  }

  handleCompactionCompleted(success: boolean): void {
    this.pending = false;
    this.queuedAtCompactionCount = undefined;
    this.lastQueuedTokenTotal = 0;
    if (success) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }
  }

  async handlePostTurn(ctx: PostTurnContext): Promise<void> {
    if (ctx.sessionId !== this.session.getSessionId()) return;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) return;

    const currentCompactionCount = this.session.getCompactionCount();
    if (this.pending) {
      if (
        this.queuedAtCompactionCount !== undefined &&
        currentCompactionCount > this.queuedAtCompactionCount
      ) {
        this.pending = false;
      } else {
        return;
      }
    }

    const currentTokens = ctx.totalTokenUsage?.total_tokens;
    const modelClient = this.getModelClient();
    const contextWindow = modelClient?.getModelContextWindow?.();
    const autoCompactLimit = modelClient?.getAutoCompactTokenLimit?.();

    if (!shouldAutoCompactTokens(currentTokens, contextWindow, autoCompactLimit)) {
      return;
    }

    if (
      typeof currentTokens === 'number' &&
      this.lastQueuedTokenTotal > 0 &&
      currentTokens <= this.lastQueuedTokenTotal &&
      currentCompactionCount === this.queuedAtCompactionCount
    ) {
      return;
    }

    this.pending = true;
    this.queuedAtCompactionCount = currentCompactionCount;
    this.lastQueuedTokenTotal = currentTokens ?? 0;

    try {
      this.submitCompact();
    } catch (err) {
      this.pending = false;
      this.consecutiveFailures += 1;
      throw err;
    }
  }
}
