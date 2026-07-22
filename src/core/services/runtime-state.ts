import type { EventMsg } from '@/core/protocol/events';
import { resolveRuntimeUrls, type RuntimeUrlConfig } from '@/config/runtimeUrls';

export type AgentAccessMode = 'api_key' | 'none';
export type AgentAccessStatus = 'ready' | 'needs_api_key' | 'initializing' | 'error';

export interface AgentAccessState {
  status: AgentAccessStatus;
  mode: AgentAccessMode;
  ready: boolean;
  provider?: string;
  model?: string;
  reason?: string;
  updatedAt: number;
}

export interface RuntimeProcessStateSnapshot {
  status: 'starting' | 'ready' | 'reconnecting' | 'failed' | 'down' | 'unknown';
  lastError?: string | null;
}

export interface DesktopRuntimeStateSnapshot {
  runtime: RuntimeProcessStateSnapshot;
  access: AgentAccessState;
  effectiveConfig: Record<string, unknown>;
}

export interface RuntimeReadyLike {
  ready?: boolean;
  message?: string;
  provider?: string;
  model?: string;
  authMode?: 'api_key' | 'chatgpt_oauth' | 'none';
}

export interface RuntimeStateControllerOptions {
  emitStateUpdate?: (event: EventMsg) => void | Promise<void>;
  getEffectiveConfig?: () => Record<string, unknown>;
  getRuntimeStatus?: () => RuntimeProcessStateSnapshot;
  urls?: RuntimeUrlConfig;
}

const now = () => Date.now();

export function accessStateFromReadyState(status: RuntimeReadyLike): AgentAccessState {
  const mode: AgentAccessMode =
    status.authMode === 'api_key' || status.authMode === 'chatgpt_oauth' ? 'api_key' : 'none';
  return {
    status: status.ready === true ? 'ready' : 'needs_api_key',
    mode,
    ready: status.ready === true,
    provider: status.provider,
    model: status.model,
    reason: status.message,
    updatedAt: now(),
  };
}

export class RuntimeStateController {
  private access: AgentAccessState;
  private readonly urls: RuntimeUrlConfig;
  private accessWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeStateControllerOptions = {}) {
    this.urls = options.urls ?? resolveRuntimeUrls();
    this.access = {
      status: 'initializing',
      mode: 'none',
      ready: false,
      reason: 'Runtime initializing',
      updatedAt: now(),
    };
  }

  getAccessState(): AgentAccessState {
    return { ...this.access };
  }

  getUrls(): RuntimeUrlConfig {
    return { ...this.urls, source: { ...this.urls.source } };
  }

  async setAccessState(
    next: Partial<Omit<AgentAccessState, 'updatedAt'>>,
  ): Promise<AgentAccessState> {
    return this.enqueueAccessWrite(async () => {
      this.access = { ...this.access, ...next, updatedAt: now() };
      const snapshot = this.getAccessState();
      if (this.options.emitStateUpdate) {
        await this.options.emitStateUpdate({
          type: 'StateUpdate',
          data: { scope: 'desktop-runtime', kind: 'agent.accessChanged', access: snapshot },
        });
      }
      return snapshot;
    });
  }

  async setAccessFromReadyState(status: RuntimeReadyLike): Promise<AgentAccessState> {
    return this.setAccessState(accessStateFromReadyState(status));
  }

  getSnapshot(): DesktopRuntimeStateSnapshot {
    return {
      runtime: this.options.getRuntimeStatus?.() ?? { status: 'ready', lastError: null },
      access: this.getAccessState(),
      effectiveConfig: this.options.getEffectiveConfig?.() ?? {},
    };
  }

  private enqueueAccessWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.accessWriteQueue.then(write, write);
    this.accessWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
