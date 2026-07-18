import { getInitializedUIClient } from '@/core/messaging';
import type { ComponentRuntimeStatus, ComponentView } from '@/core/components';

async function request<T>(service: string, params?: Record<string, unknown>): Promise<T> {
  const client = await getInitializedUIClient();
  return client.serviceRequest<T>(service, params);
}

export const componentsClient = {
  status: () => request<ComponentRuntimeStatus>('components.status'),
  list: () => request<ComponentView[]>('components.list'),
  install: (componentId: string) => request<ComponentView>('components.install', { componentId }),
  verify: (componentId: string) => request<ComponentView>('components.verify', { componentId }),
  uninstall: (componentId: string) => request<void>('components.uninstall', { componentId }),
};

export function componentUiError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The component operation failed. Try again or reload this page.';
}
