import type { KeychainBridge } from '@/desktop-runtime/credentials/ControlFrameCredentialStore';
import type { DesktopRuntimeFrame } from './frames';
import { StdioFrameCarrier } from './stdioCarrier';

interface PendingControl {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class DesktopRuntimeControlBridge {
  private pending = new Map<string, PendingControl>();

  readonly keychain: KeychainBridge = {
    get: (service, account) => this.request<string | null>('keychain.get', { service, account }),
    set: async (service, account, password) => {
      await this.request('keychain.set', { service, account, password });
    },
    delete: async (service, account) => {
      await this.request('keychain.delete', { service, account });
    },
    listAccounts: (service) => this.request<string[]>('keychain.listAccounts', { service }),
  };

  constructor(private readonly carrier: StdioFrameCarrier) {}

  handleFrame(frame: DesktopRuntimeFrame): boolean {
    if (frame.type !== 'control-response') return false;
    const pending = this.pending.get(frame.id);
    if (!pending) return true;

    clearTimeout(pending.timeout);
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      pending.reject(new Error(frame.error ?? 'Control request failed'));
    }
    return true;
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = crypto.randomUUID();
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Control request timed out: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });

    this.carrier.send({ type: 'control-request', id, method, params });
    return promise;
  }
}

let bridge: DesktopRuntimeControlBridge | null = null;

export function setDesktopRuntimeControlBridge(nextBridge: DesktopRuntimeControlBridge): void {
  bridge = nextBridge;
}

export function getDesktopRuntimeControlBridge(): DesktopRuntimeControlBridge {
  if (!bridge) {
    throw new Error('Desktop runtime control bridge is not initialized');
  }
  return bridge;
}
