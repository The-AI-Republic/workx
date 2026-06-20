import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { RuntimeStateController } from './runtime-state';

export interface RuntimeServiceDeps {
  runtimeState: RuntimeStateController;
}

export function createRuntimeServices(deps: RuntimeServiceDeps): Record<string, ServiceHandler> {
  return {
    'runtime.getStateSnapshot': async () => deps.runtimeState.getSnapshot(),
    'runtime.getUrlConfig': async () => deps.runtimeState.getUrls(),
  };
}

