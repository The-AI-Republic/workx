import { ComponentError, type ComponentRuntimeHandle } from '@/core/components';
import type { SubmissionContext } from '@/core/channels/types';

export interface ComponentServiceDeps {
  handle: ComponentRuntimeHandle;
}

function guardDesktop(context: SubmissionContext): void {
  if (context.channelId !== 'desktop-runtime-main' || context.channelType !== 'tauri') {
    throw new ComponentError(
      'COMPONENT_ACCESS_DENIED',
      'Managed components are available only in WorkX Desktop.'
    );
  }
}

function componentId(params: Record<string, unknown>): string {
  const value = params.componentId;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ComponentError('COMPONENT_NOT_FOUND', 'componentId is required.');
  }
  return value;
}

export function createComponentServices(deps: ComponentServiceDeps) {
  const guarded =
    <T>(handler: (params: Record<string, unknown>) => Promise<T> | T) =>
    async (params: Record<string, unknown>, context: SubmissionContext): Promise<T> => {
      guardDesktop(context);
      return handler(params);
    };

  return {
    'components.status': guarded(() => deps.handle.status()),
    'components.list': guarded(() => deps.handle.requireManager().list()),
    'components.install': guarded((params) =>
      deps.handle.requireManager().install(componentId(params))
    ),
    'components.verify': guarded((params) =>
      deps.handle.requireManager().verify(componentId(params))
    ),
    'components.uninstall': guarded((params) =>
      deps.handle.requireManager().uninstall(componentId(params))
    ),
  };
}
