import { getInitializedUIClient } from '@/core/messaging';
import type {
  CreateDataSourceInput,
  DataContextRevisionSummary,
  DataSourceContext,
  DataSourcePublicView,
  DataSourcesStatus,
  DataSourceTestResult,
  ManualContextUpdate,
  SavedDataSourceTestResult,
  TestDataSourceCandidateInput,
  UpdateDataSourceInput,
} from '@/core/data-sources/types';

async function request<T>(service: string, params?: Record<string, unknown>): Promise<T> {
  const client = await getInitializedUIClient();
  return client.serviceRequest<T>(service, params);
}

export const dataSourcesClient = {
  status: () => request<DataSourcesStatus>('dataSources.status'),
  list: () => request<DataSourcePublicView[]>('dataSources.list'),
  get: (sourceId: string) => request<DataSourcePublicView>('dataSources.get', { sourceId }),
  create: (input: CreateDataSourceInput) =>
    request<DataSourcePublicView>(
      'dataSources.create',
      input as unknown as Record<string, unknown>
    ),
  update: (sourceId: string, input: UpdateDataSourceInput) =>
    request<DataSourcePublicView>('dataSources.update', { sourceId, input }),
  delete: (sourceId: string, expectedRevision: number) =>
    request<void>('dataSources.delete', { sourceId, expectedRevision }),
  test: (sourceId: string, expectedRevision: number) =>
    request<SavedDataSourceTestResult>('dataSources.test', { sourceId, expectedRevision }),
  testCandidate: (input: TestDataSourceCandidateInput) =>
    request<DataSourceTestResult>(
      'dataSources.testCandidate',
      input as unknown as Record<string, unknown>
    ),
  getContext: (sourceId: string, assessStale = false) =>
    request<DataSourceContext>('dataSources.getContext', { sourceId, assessStale }),
  updateContext: (sourceId: string, input: ManualContextUpdate) =>
    request<DataSourceContext>('dataSources.updateContext', { sourceId, input }),
  listContextRevisions: (sourceId: string) =>
    request<DataContextRevisionSummary[]>('dataSources.listContextRevisions', { sourceId }),
  revertContext: (sourceId: string, targetRevision: number, expectedCurrentRevision: number) =>
    request<DataSourceContext>('dataSources.revertContext', {
      sourceId,
      targetRevision,
      expectedCurrentRevision,
    }),
  refreshSchema: (sourceId: string) => request<void>('dataSources.refreshSchema', { sourceId }),
};

export function dataSourceUiError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The data-source operation failed. Try again or reload this page.';
}
