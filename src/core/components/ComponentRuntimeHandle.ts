import { ComponentError } from './errors';
import type { ComponentManager, ComponentRuntimeStatus } from './types';

export class ComponentRuntimeHandle {
  private manager: ComponentManager | null = null;
  private currentStatus: ComponentRuntimeStatus = {
    state: 'unavailable',
    available: false,
    errorCode: 'COMPONENTS_UNAVAILABLE',
  };

  setReady(manager: ComponentManager): void {
    this.manager = manager;
    this.currentStatus = manager.status();
  }

  setUnavailable(errorCode: ComponentRuntimeStatus['errorCode'] = 'COMPONENTS_UNAVAILABLE'): void {
    this.manager = null;
    this.currentStatus = { state: 'unavailable', available: false, errorCode };
  }

  markStopping(): void {
    this.currentStatus = { ...this.currentStatus, state: 'stopping', available: false };
  }

  status(): ComponentRuntimeStatus {
    return { ...this.currentStatus };
  }

  getManager(): ComponentManager | null {
    return this.manager;
  }

  requireManager(): ComponentManager {
    if (!this.manager || !this.currentStatus.available) {
      throw new ComponentError(
        'COMPONENTS_UNAVAILABLE',
        'WorkX managed components are unavailable.',
        true
      );
    }
    return this.manager;
  }
}
