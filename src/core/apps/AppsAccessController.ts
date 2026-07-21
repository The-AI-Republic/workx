import { AppsServiceError } from './AppsServiceError';
import type { OpenHubAppsClient } from './OpenHubAppsClient';
import type { OpenHubCredentialProvider } from './OpenHubCredentialProvider';
import type {
  AppsAccessReason,
  AppsAccessState,
  AppsCredentialValidationResult,
  AppsAccessPolicy,
} from './types';

export interface AppsAccessControllerOptions {
  configured: boolean;
  policy: AppsAccessPolicy;
  provider: OpenHubCredentialProvider;
  client?: OpenHubAppsClient;
  emitState?: (state: AppsAccessState) => void | Promise<void>;
  reconnectMcp?: () => void | Promise<void>;
  disconnectMcp?: () => void | Promise<void>;
}

export class AppsAccessController {
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  private state: AppsAccessState;

  constructor(private readonly options: AppsAccessControllerOptions) {
    const now = Date.now();
    this.state = {
      configured: options.configured,
      credentialStatus: options.configured
        ? options.policy.authMethod === 'api-key'
          ? 'needs-api-key'
          : 'needs-login'
        : 'unconfigured',
      backendStatus: 'unknown',
      capabilityStatus: 'unknown',
      authMethod: options.policy.authMethod,
      credentialSource: 'none',
      hasCredential: false,
      reason: options.configured
        ? options.policy.authMethod === 'api-key'
          ? 'api_key_missing'
          : 'login_required'
        : 'catalog_unconfigured',
      revision: this.revision,
      updatedAt: now,
    };
    options.client?.setObserver({
      onReachable: () => this.updateObservation({ backendStatus: 'reachable' }),
      onUnavailable: () => this.updateObservation({ backendStatus: 'unavailable' }),
      onRejected: (status) => this.rejectCurrent(status),
    });
  }

  get policy(): AppsAccessPolicy {
    return this.options.policy;
  }

  getState(): AppsAccessState {
    return {
      ...this.state,
      allowedAppIds: this.state.allowedAppIds
        ? [...this.state.allowedAppIds]
        : this.state.allowedAppIds,
    };
  }

  async initialize(): Promise<AppsAccessState> {
    return this.enqueue(() => this.refreshUnlocked());
  }

  requireReady(): void {
    if (!this.state.configured)
      throw new AppsServiceError('APPS_NOT_CONFIGURED', 'The Apps catalog is not configured.');
    if (this.state.capabilityStatus === 'incompatible')
      throw new AppsServiceError(
        'APPS_BACKEND_INCOMPATIBLE',
        'This OpenHub deployment is not compatible with WorkX Apps.'
      );
    if (this.state.credentialStatus === 'ready') return;
    if (this.state.credentialStatus === 'needs-api-key')
      throw new AppsServiceError('APPS_API_KEY_REQUIRED', 'Add an OpenHub API key in Settings.');
    if (this.state.credentialStatus === 'needs-login')
      throw new AppsServiceError('APPS_LOGIN_REQUIRED', 'Sign in to use Apps.');
    if (this.state.credentialStatus === 'forbidden')
      throw new AppsServiceError(
        'APPS_FORBIDDEN',
        'The current credential lacks Apps permissions.'
      );
    if (this.state.credentialStatus === 'invalid-credential')
      throw new AppsServiceError(
        'APPS_INVALID_CREDENTIAL',
        'OpenHub rejected the current credential.'
      );
    throw new AppsServiceError(
      'APPS_UNAVAILABLE',
      'Apps credential validation has not completed.',
      true
    );
  }

  async validateCandidate(candidate: string): Promise<AppsCredentialValidationResult> {
    this.requireApiKeyPolicy();
    const normalized = this.normalizeCandidate(candidate);
    if (!this.options.client)
      throw new AppsServiceError('APPS_NOT_CONFIGURED', 'The Apps catalog is not configured.');
    try {
      const result = await this.options.client.validateCredential({
        method: 'api-key',
        token: normalized,
      });
      await this.updateObservation({ backendStatus: 'reachable', capabilityStatus: 'supported' });
      return result;
    } catch (error) {
      await this.observeValidationError(error);
      throw error;
    }
  }

  async saveCandidate(candidate: string): Promise<AppsAccessState> {
    return this.enqueue(async () => {
      this.requireApiKeyPolicy();
      const normalized = this.normalizeCandidate(candidate);
      if (!this.options.client)
        throw new AppsServiceError('APPS_NOT_CONFIGURED', 'The Apps catalog is not configured.');
      let result: AppsCredentialValidationResult;
      try {
        result = await this.options.client.validateCredential({
          method: 'api-key',
          token: normalized,
        });
      } catch (error) {
        await this.observeValidationErrorUnlocked(error);
        throw error;
      }
      await this.options.provider.saveApiKey(normalized);
      await this.commit({
        credentialStatus: 'ready',
        backendStatus: 'reachable',
        capabilityStatus: 'supported',
        credentialSource: 'stored-api-key',
        hasCredential: true,
        allowedAppIds: result.allowedAppIds,
        reason: undefined,
      });
      await this.reconnectMcpBestEffort();
      return this.getState();
    });
  }

  async removeStoredKey(): Promise<AppsAccessState> {
    return this.enqueue(async () => {
      this.requireApiKeyPolicy();
      await this.options.provider.removeApiKey();
      await this.disconnectMcpBestEffort();
      return this.refreshUnlocked();
    });
  }

  async refresh(): Promise<AppsAccessState> {
    return this.enqueue(() => this.refreshUnlocked());
  }

  async sessionEnded(reason: AppsAccessReason = 'login_required'): Promise<AppsAccessState> {
    return this.enqueue(async () => {
      this.options.provider.bumpGeneration();
      await this.disconnectMcpBestEffort();
      return this.commit({
        credentialStatus: 'needs-login',
        credentialSource: 'none',
        hasCredential: false,
        allowedAppIds: undefined,
        reason,
      });
    });
  }

  private async refreshUnlocked(): Promise<AppsAccessState> {
    if (!this.options.configured || !this.options.client) {
      return this.commit({
        credentialStatus: 'unconfigured',
        credentialSource: 'none',
        hasCredential: false,
        reason: 'catalog_unconfigured',
      });
    }
    const credential = await this.options.provider.getCredential();
    if (!credential) {
      await this.disconnectMcpBestEffort();
      return this.commit({
        credentialStatus:
          this.options.policy.authMethod === 'api-key' ? 'needs-api-key' : 'needs-login',
        credentialSource: 'none',
        hasCredential: false,
        allowedAppIds: undefined,
        reason: this.options.policy.authMethod === 'api-key' ? 'api_key_missing' : 'login_required',
      });
    }
    const wasReady = this.state.credentialStatus === 'ready';
    if (!wasReady) {
      await this.commit({
        credentialStatus: 'validating',
        credentialSource: credential.source,
        hasCredential: true,
        reason: undefined,
      });
    }
    try {
      const result = await this.options.client.validateCredential(credential);
      await this.commit({
        credentialStatus: 'ready',
        backendStatus: 'reachable',
        capabilityStatus: 'supported',
        credentialSource: credential.source,
        hasCredential: true,
        allowedAppIds: result.allowedAppIds,
        reason: undefined,
      });
      if (!wasReady) await this.reconnectMcpBestEffort();
    } catch (error) {
      await this.applyValidationError(error, credential.source, wasReady);
    }
    return this.getState();
  }

  private async applyValidationError(
    error: unknown,
    source: AppsAccessState['credentialSource'],
    preserveReady = false
  ): Promise<void> {
    if (error instanceof AppsServiceError) {
      if (error.errorCode === 'APPS_BACKEND_INCOMPATIBLE') {
        await this.commit({
          credentialStatus: 'unverified',
          backendStatus: 'reachable',
          capabilityStatus: 'incompatible',
          credentialSource: source,
          hasCredential: true,
          reason: 'backend_incompatible',
        });
        return;
      }
      if (error.errorCode === 'APPS_INVALID_CREDENTIAL') {
        await this.disconnectMcpBestEffort();
        await this.commit({
          credentialStatus: 'invalid-credential',
          backendStatus: 'reachable',
          credentialSource: source,
          hasCredential: true,
          reason: 'credential_rejected',
        });
        return;
      }
      if (error.errorCode === 'APPS_FORBIDDEN') {
        await this.disconnectMcpBestEffort();
        await this.commit({
          credentialStatus: 'forbidden',
          backendStatus: 'reachable',
          capabilityStatus: 'supported',
          credentialSource: source,
          hasCredential: true,
          reason: 'insufficient_scope',
        });
        return;
      }
    }
    await this.commit({
      credentialStatus: preserveReady ? 'ready' : 'unverified',
      backendStatus: 'unavailable',
      credentialSource: source,
      hasCredential: true,
      reason: preserveReady ? undefined : 'validation_unavailable',
    });
  }

  private async observeValidationError(error: unknown): Promise<void> {
    await this.enqueue(() => this.observeValidationErrorUnlocked(error));
  }

  private async observeValidationErrorUnlocked(error: unknown): Promise<void> {
    if (error instanceof AppsServiceError && error.errorCode === 'APPS_BACKEND_INCOMPATIBLE') {
      await this.commit({ backendStatus: 'reachable', capabilityStatus: 'incompatible' });
    } else if (
      error instanceof AppsServiceError &&
      ['APPS_INVALID_CREDENTIAL', 'APPS_FORBIDDEN'].includes(error.errorCode)
    ) {
      await this.commit({ backendStatus: 'reachable' });
    } else {
      await this.commit({ backendStatus: 'unavailable' });
    }
  }

  private async rejectCurrent(status: 401 | 403): Promise<void> {
    await this.enqueue(async () => {
      await this.disconnectMcpBestEffort();
      if (status === 401 && this.options.policy.authMethod === 'session-jwt') {
        this.options.provider.bumpGeneration();
        await this.commit({
          credentialStatus: 'needs-login',
          backendStatus: 'reachable',
          credentialSource: 'none',
          hasCredential: false,
          allowedAppIds: undefined,
          reason: 'session_expired',
        });
        return;
      }
      await this.commit(
        status === 401
          ? {
              credentialStatus: 'invalid-credential',
              backendStatus: 'reachable',
              reason: 'credential_rejected',
            }
          : {
              credentialStatus: 'forbidden',
              backendStatus: 'reachable',
              reason: 'insufficient_scope',
            }
      );
    });
  }

  private async updateObservation(patch: Partial<AppsAccessState>): Promise<void> {
    await this.enqueue(async () => {
      if (
        Object.entries(patch).every(
          ([key, value]) => this.state[key as keyof AppsAccessState] === value
        )
      )
        return;
      await this.commit(patch);
    });
  }

  private async commit(patch: Partial<AppsAccessState>): Promise<AppsAccessState> {
    this.revision++;
    this.state = { ...this.state, ...patch, revision: this.revision, updatedAt: Date.now() };
    const snapshot = this.getState();
    await this.options.emitState?.(snapshot);
    return snapshot;
  }

  private requireApiKeyPolicy(): void {
    if (this.options.policy.authMethod !== 'api-key') {
      throw new AppsServiceError(
        'APPS_AUTH_METHOD_DISABLED',
        'API-key configuration is disabled for this WorkX build.'
      );
    }
  }

  private normalizeCandidate(candidate: string): string {
    if (typeof candidate !== 'string')
      throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Enter an OpenHub API key.');
    const normalized = candidate.trim();
    if (!normalized || new TextEncoder().encode(normalized).byteLength > 16 * 1024) {
      throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Enter a valid OpenHub API key.');
    }
    return normalized;
  }

  private async reconnectMcpBestEffort(): Promise<void> {
    try {
      await this.options.reconnectMcp?.();
    } catch {
      // Credential state remains authoritative; MCP's own connection state
      // reports and retries a transport failure.
    }
  }

  private async disconnectMcpBestEffort(): Promise<void> {
    try {
      await this.options.disconnectMcp?.();
    } catch {
      // The runtime detaches its provider/state even if remote close fails.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
