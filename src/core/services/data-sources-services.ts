import { DataSourceError, type DataSourceRuntimeHandle } from '@/core/data-sources';
import type { SubmissionContext } from '@/core/channels/types';

export interface DataSourceServiceDeps {
  handle: DataSourceRuntimeHandle;
}

function guardDesktop(context: SubmissionContext): void {
  if (context.channelId !== 'desktop-runtime-main' || context.channelType !== 'tauri') {
    throw new DataSourceError(
      'SERVICE_FORBIDDEN',
      'Data-source management is available only in WorkX Desktop.'
    );
  }
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || !value)
    throw new DataSourceError('SOURCE_NOT_FOUND', `${name} is required.`);
  return value;
}

function integerParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new DataSourceError('SOURCE_REVISION_CONFLICT', `${name} must be a positive integer.`);
  }
  return Number(value);
}

export function createDataSourceServices(deps: DataSourceServiceDeps) {
  const guarded =
    <T>(handler: (params: Record<string, unknown>) => Promise<T> | T) =>
    async (params: Record<string, unknown>, context: SubmissionContext): Promise<T> => {
      guardDesktop(context);
      return handler(params);
    };

  return {
    'dataSources.status': guarded(() => deps.handle.getStatus()),
    'dataSources.list': guarded(() => deps.handle.requireRuntime().listManagementSources()),
    'dataSources.get': guarded((params) =>
      deps.handle.requireRuntime().getSource(stringParam(params, 'sourceId'))
    ),
    'dataSources.create': guarded((params) =>
      deps.handle.requireRuntime().createSource(params as never)
    ),
    'dataSources.update': guarded((params) =>
      deps.handle
        .requireRuntime()
        .updateSource(stringParam(params, 'sourceId'), (params.input ?? {}) as never)
    ),
    'dataSources.delete': guarded((params) =>
      deps.handle
        .requireRuntime()
        .deleteSource(stringParam(params, 'sourceId'), integerParam(params, 'expectedRevision'))
    ),
    'dataSources.test': guarded((params) =>
      deps.handle
        .requireRuntime()
        .testSource(stringParam(params, 'sourceId'), integerParam(params, 'expectedRevision'))
    ),
    'dataSources.testCandidate': guarded((params) =>
      deps.handle.requireRuntime().testCandidate(params as never)
    ),
    'dataSources.getContext': guarded((params) =>
      deps.handle
        .requireRuntime()
        .getContext(stringParam(params, 'sourceId'), undefined, params.assessStale === true)
    ),
    'dataSources.updateContext': guarded((params) =>
      deps.handle
        .requireRuntime()
        .updateContext(stringParam(params, 'sourceId'), (params.input ?? {}) as never)
    ),
    'dataSources.listContextRevisions': guarded((params) =>
      deps.handle.requireRuntime().listContextRevisions(stringParam(params, 'sourceId'))
    ),
    'dataSources.revertContext': guarded((params) =>
      deps.handle
        .requireRuntime()
        .revertContext(
          stringParam(params, 'sourceId'),
          integerParam(params, 'targetRevision'),
          integerParam(params, 'expectedCurrentRevision')
        )
    ),
    'dataSources.refreshSchema': guarded((params) =>
      deps.handle.requireRuntime().refreshSchema(stringParam(params, 'sourceId'))
    ),
  };
}
