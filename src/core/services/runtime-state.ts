import type { EventMsg } from '@/core/protocol/events';
import { resolveRuntimeUrls, type RuntimeUrlConfig } from '@/config/runtimeUrls';

export interface RuntimeUserProfileSnapshot {
  id?: string;
  email?: string;
  name?: string;
  avatar?: string;
  userType?: number;
}

export type RuntimeAuthMode = 'login' | 'own_api_key' | 'none';
export type RuntimeProfileStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface RuntimeAuthState {
  mode: RuntimeAuthMode;
  hasToken: boolean;
  /** Compatibility alias for pre-Track-44 desktop UI callers. */
  hasValidToken: boolean;
  profile: RuntimeUserProfileSnapshot | null;
  /** Compatibility alias for pre-Track-44 desktop UI callers. */
  user: RuntimeUserProfileSnapshot | null;
  profileStatus: RuntimeProfileStatus;
  updatedAt: number;
  lastError?: string;
}

export type AgentAccessMode = 'login' | 'api_key' | 'none';
export type AgentAccessStatus = 'ready' | 'needs_login' | 'needs_api_key' | 'initializing' | 'error';

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
  auth: RuntimeAuthState;
  access: AgentAccessState;
  effectiveConfig: Record<string, unknown>;
  urls: RuntimeUrlConfig;
}

export interface RuntimeReadyLike {
  ready?: boolean;
  message?: string;
  provider?: string;
  model?: string;
  authMode?: 'login' | 'api_key' | 'chatgpt_oauth' | 'none';
}

export interface RuntimeStateControllerOptions {
  emitStateUpdate?: (event: EventMsg) => void | Promise<void>;
  getEffectiveConfig?: () => Record<string, unknown>;
  getRuntimeStatus?: () => RuntimeProcessStateSnapshot;
  urls?: RuntimeUrlConfig;
}

function now(): number {
  return Date.now();
}

function cloneAuth(state: RuntimeAuthState): RuntimeAuthState {
  return {
    ...state,
    profile: state.profile ? { ...state.profile } : null,
    user: state.user ? { ...state.user } : null,
  };
}

function cloneAccess(state: AgentAccessState): AgentAccessState {
  return { ...state };
}

export function normalizeRuntimeProfile(profile: unknown): RuntimeUserProfileSnapshot | null {
  if (!profile || typeof profile !== 'object') return null;
  const value = profile as Record<string, unknown>;
  return {
    id: typeof value.id === 'string' ? value.id : typeof value.user_id === 'string' ? value.user_id : undefined,
    name: typeof value.name === 'string'
      ? value.name
      : typeof value.firstName === 'string'
        ? value.firstName
        : typeof value.display_name === 'string'
          ? value.display_name
          : typeof value.username === 'string'
            ? value.username
            : undefined,
    email: typeof value.email === 'string' ? value.email : undefined,
    avatar: typeof value.avatar === 'string'
      ? value.avatar
      : typeof value.avatar_url === 'string'
        ? value.avatar_url
        : typeof value.picture === 'string'
          ? value.picture
          : undefined,
    userType: typeof value.userType === 'number'
      ? value.userType
      : typeof value.user_type === 'number'
        ? value.user_type
        : undefined,
  };
}

export function accessStateFromReadyState(status: RuntimeReadyLike): AgentAccessState {
  const mode: AgentAccessMode =
    status.authMode === 'login' ? 'login' :
    status.authMode === 'api_key' || status.authMode === 'chatgpt_oauth' ? 'api_key' :
    'none';
  let accessStatus: AgentAccessStatus = 'initializing';
  if (status.ready === true) {
    accessStatus = 'ready';
  } else if (mode === 'api_key') {
    accessStatus = 'needs_api_key';
  } else if (mode === 'login' || mode === 'none') {
    accessStatus = 'needs_login';
  }
  return {
    status: accessStatus,
    mode,
    ready: status.ready === true,
    provider: status.provider,
    model: status.model,
    reason: status.message,
    updatedAt: now(),
  };
}

export class RuntimeStateController {
  private auth: RuntimeAuthState;
  private access: AgentAccessState;
  private readonly urls: RuntimeUrlConfig;

  constructor(private readonly options: RuntimeStateControllerOptions = {}) {
    this.urls = options.urls ?? resolveRuntimeUrls();
    const updatedAt = now();
    this.auth = {
      mode: 'none',
      hasToken: false,
      hasValidToken: false,
      profile: null,
      user: null,
      profileStatus: 'idle',
      updatedAt,
    };
    this.access = {
      status: 'initializing',
      mode: 'none',
      ready: false,
      reason: 'Runtime initializing',
      updatedAt,
    };
  }

  getAuthState(): RuntimeAuthState {
    return cloneAuth(this.auth);
  }

  getAccessState(): AgentAccessState {
    return cloneAccess(this.access);
  }

  getUrls(): RuntimeUrlConfig {
    return {
      ...this.urls,
      source: { ...this.urls.source },
    };
  }

  async setAuthState(next: Partial<Omit<RuntimeAuthState, 'hasValidToken' | 'user' | 'updatedAt'>>): Promise<RuntimeAuthState> {
    const profile = Object.prototype.hasOwnProperty.call(next, 'profile')
      ? (next.profile ? { ...next.profile } : null)
      : this.auth.profile;
    this.auth = {
      ...this.auth,
      ...next,
      profile,
      user: profile,
      hasValidToken: next.hasToken ?? this.auth.hasToken,
      updatedAt: now(),
    };
    await this.emit('auth.stateChanged', { auth: this.getAuthState() });
    return this.getAuthState();
  }

  async setAccessState(next: Partial<Omit<AgentAccessState, 'updatedAt'>>): Promise<AgentAccessState> {
    this.access = {
      ...this.access,
      ...next,
      updatedAt: now(),
    };
    await this.emit('agent.accessChanged', { access: this.getAccessState() });
    return this.getAccessState();
  }

  async setAccessFromReadyState(status: RuntimeReadyLike): Promise<AgentAccessState> {
    return this.setAccessState(accessStateFromReadyState(status));
  }

  getSnapshot(): DesktopRuntimeStateSnapshot {
    return {
      runtime: this.options.getRuntimeStatus?.() ?? { status: 'ready', lastError: null },
      auth: this.getAuthState(),
      access: this.getAccessState(),
      effectiveConfig: this.options.getEffectiveConfig?.() ?? {},
      urls: this.getUrls(),
    };
  }

  private async emit(kind: 'auth.stateChanged' | 'agent.accessChanged', payload: Record<string, unknown>): Promise<void> {
    if (!this.options.emitStateUpdate) return;
    await this.options.emitStateUpdate({
      type: 'StateUpdate',
      data: {
        scope: 'desktop-runtime',
        kind,
        ...payload,
      },
    });
  }
}

