import {
  DataSourceError,
  dataQueryParameterTypes,
  renderDataSourceContext,
  type DataAccessPrincipal,
  type DataDescribeRequest,
  type DataQueryRequest,
  type DataSourceRuntime,
  type DataTurnAccessSnapshot,
  type LearnDataContextRequest,
} from '@/core/data-sources';
import type { ToolContext } from '@/tools/BaseTool';
import type { ToolRegistry } from '@/tools/ToolRegistry';
import type { ToolProgressData } from '@/tools/runtimeMetadata';
import { DataContextRiskAssessor } from './DataContextRiskAssessor';
import { DataQueryRiskAssessor } from './DataQueryRiskAssessor';
import {
  DATA_DESCRIBE_TOOL,
  DATA_GET_CONTEXT_TOOL,
  DATA_LEARN_CONTEXT_TOOL,
  DATA_LIST_SOURCES_TOOL,
  DATA_QUERY_TOOL,
} from './definitions';
import { StaticRiskAssessor } from '@/core/approval/assessors/StaticRiskAssessor';
import { registerPromptExtension } from '@/core/PromptLoader';
import { DATA_ANALYSIS_PROMPT } from './prompt';

function principalFromContext(context: ToolContext): {
  principal: DataAccessPrincipal;
  snapshot: DataTurnAccessSnapshot;
} {
  const snapshot = context.metadata?.dataTurnSnapshot as DataTurnAccessSnapshot | undefined;
  if (!snapshot)
    throw new DataSourceError(
      'DATA_ACCESS_ORIGIN_DENIED',
      'Original desktop-turn metadata is missing.'
    );
  return {
    snapshot,
    principal: {
      sessionId: context.sessionId,
      turnId: context.turnId,
      origin: snapshot.origin,
      attended: snapshot.attended,
      desktopUiSession:
        snapshot.origin.channel === 'local' &&
        snapshot.origin.channelId === 'desktop-runtime-main' &&
        snapshot.origin.channelType === 'tauri',
    },
  };
}

function emitProgress(context: ToolContext, data: ToolProgressData): void {
  context.onProgress?.({
    toolUseID: context.callId ?? `${context.toolName}:${context.turnId}`,
    data,
  });
}

function exposure(displayName: string, searchHint: string) {
  return {
    mode: 'deferred' as const,
    source: 'builtin' as const,
    displayName,
    searchHint,
  };
}

export async function registerDataSourceTools(
  registry: ToolRegistry,
  runtime: DataSourceRuntime
): Promise<void> {
  registerPromptExtension('data-analysis', (context) =>
    context.toolRegistry?.getTool('data_query') ? DATA_ANALYSIS_PROMPT : ''
  );
  const readRuntime = {
    concurrency: {
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isDestructive: () => false,
    },
    ui: {
      isSearchOrReadCommand: () => ({
        isSearch: true,
        isRead: true,
        isList: true,
      }),
    },
    result: { maxResultSizeChars: 40_000 },
  };

  await registry.register(
    DATA_LIST_SOURCES_TOOL,
    async (parameters, context) => {
      const { principal } = principalFromContext(context);
      return runtime.listSources(
        { search: parameters.search, cursor: parameters.cursor },
        principal
      );
    },
    {
      riskAssessor: new StaticRiskAssessor(0),
      exposure: exposure(
        'List Data Sources',
        'database data source multi source analysis analytics sales tables warehouse'
      ),
      runtime: readRuntime,
    }
  );

  await registry.register(
    DATA_DESCRIBE_TOOL,
    async (parameters, context) => {
      const { principal } = principalFromContext(context);
      return runtime.describe(
        parameters as unknown as DataDescribeRequest,
        principal,
        context.signal
      );
    },
    {
      riskAssessor: new StaticRiskAssessor(0),
      exposure: exposure(
        'Describe Data',
        'database schema tables columns business definitions context'
      ),
      runtime: readRuntime,
    }
  );

  await registry.register(
    DATA_QUERY_TOOL,
    async (parameters, context) => {
      const request = parameters as unknown as DataQueryRequest;
      const { principal } = principalFromContext(context);
      const preview = await runtime.validateQueryForProgress(request, principal);
      const parameterTypes = dataQueryParameterTypes(request.parameters);
      const started = Date.now();
      emitProgress(context, {
        type: 'data_query',
        status: 'started',
        sourceName: preview.sourceName,
        connectorId: preview.connectorId,
        transport: preview.transport,
        purpose: request.purpose,
        sql: preview.safeSql,
        parameterTypes,
        parameterCount: parameterTypes.length,
      });
      try {
        const result = await runtime.query(request, principal, context.signal);
        emitProgress(context, {
          type: 'data_query',
          status: 'completed',
          sourceName: preview.sourceName,
          connectorId: preview.connectorId,
          transport: preview.transport,
          purpose: request.purpose,
          parameterTypes,
          parameterCount: parameterTypes.length,
          durationMs: Date.now() - started,
          rowCount: result.rowCount,
          truncated: result.truncated,
        });
        return result;
      } catch (error) {
        emitProgress(context, {
          type: 'data_query',
          status: 'failed',
          sourceName: preview.sourceName,
          connectorId: preview.connectorId,
          transport: preview.transport,
          purpose: request.purpose,
          parameterTypes,
          parameterCount: parameterTypes.length,
          durationMs: Date.now() - started,
          errorCode: error instanceof DataSourceError ? error.code : 'SOURCE_UNREACHABLE',
        });
        throw error;
      }
    },
    {
      riskAssessor: new DataQueryRiskAssessor(runtime),
      exposure: exposure(
        'Query Data',
        'run read only SQL database multi source analysis aggregate sales metrics'
      ),
      runtime: {
        concurrency: {
          isConcurrencySafe: () => false,
          isReadOnly: () => true,
          isDestructive: () => false,
        },
        ui: { getActivityDescription: () => 'Analyzing configured data' },
        result: { maxResultSizeChars: 45_000 },
      },
    }
  );

  await registry.register(
    DATA_GET_CONTEXT_TOOL,
    async (parameters, context) => {
      const { principal } = principalFromContext(context);
      const sourceId = String(parameters.source_id ?? '');
      const stored = await runtime.getContext(sourceId, principal, true, context.signal);
      const activeFacts = stored.facts.filter((fact) => fact.status === 'active' && !fact.stale);
      const result: Record<string, unknown> = {
        sourceId,
        revision: stored.revision,
        renderedContext: renderDataSourceContext(stored),
        activeFacts,
        updatedAt: stored.updatedAt,
      };
      while (activeFacts.length && JSON.stringify(result).length >= 40_000) activeFacts.pop();
      return result;
    },
    {
      riskAssessor: new StaticRiskAssessor(0),
      exposure: exposure(
        'Get Data Context',
        'business definitions metrics enum meanings units database context'
      ),
      runtime: readRuntime,
    }
  );

  await registry.register(
    DATA_LEARN_CONTEXT_TOOL,
    async (parameters, context) => {
      const { principal, snapshot } = principalFromContext(context);
      const currentUserText = context.metadata?.currentUserText;
      if (typeof currentUserText !== 'string') {
        throw new DataSourceError(
          'CONTEXT_EVIDENCE_MISSING',
          'Original user evidence is unavailable for context learning.'
        );
      }
      const result = await runtime.learnContext(parameters as unknown as LearnDataContextRequest, {
        principal,
        currentUserText,
        durableLearningEligible: snapshot.durableLearningEligible,
      });
      emitProgress(context, {
        type: 'data_context_learned',
        status: 'completed',
        sourceId: result.sourceId,
        sourceName: result.sourceName,
        summaries: result.addedFacts.map((fact) => fact.assertion.slice(0, 160)),
        priorRevision: result.priorRevision,
        currentRevision: result.currentRevision,
      });
      return result;
    },
    {
      riskAssessor: new DataContextRiskAssessor(runtime),
      exposure: exposure(
        'Learn Data Context',
        'remember database field enum unit metric business meaning'
      ),
      runtime: {
        concurrency: {
          isConcurrencySafe: () => false,
          isReadOnly: () => false,
          isDestructive: () => false,
        },
        ui: { getActivityDescription: () => 'Saving a business definition' },
        result: { maxResultSizeChars: 20_000 },
      },
    }
  );
}
