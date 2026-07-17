import { ComponentError, type ComponentManager, type ComponentProgress } from '@/core/components';
import type { DataTurnAccessSnapshot } from '@/core/data-sources';
import { StaticRiskAssessor } from '@/core/approval/assessors/StaticRiskAssessor';
import { registerPromptExtension } from '@/core/PromptLoader';
import type { ToolContext } from '@/tools/BaseTool';
import type { ToolRegistry } from '@/tools/ToolRegistry';
import { ComponentInstallRiskAssessor } from './ComponentInstallRiskAssessor';
import { COMPONENT_INSTALL_TOOL, COMPONENT_LIST_TOOL } from './definitions';
import { MANAGED_COMPONENTS_PROMPT } from './prompt';

function assertLocalDesktopTurn(context: ToolContext): void {
  const snapshot = context.metadata?.dataTurnSnapshot as DataTurnAccessSnapshot | undefined;
  if (
    !snapshot?.attended ||
    snapshot.origin.channel !== 'local' ||
    snapshot.origin.channelId !== 'desktop-runtime-main' ||
    snapshot.origin.channelType !== 'tauri'
  ) {
    throw new ComponentError(
      'COMPONENT_ACCESS_DENIED',
      'Managed components can be installed only from an attended WorkX Desktop conversation.'
    );
  }
}

function emitProgress(context: ToolContext, progress: ComponentProgress): void {
  context.onProgress?.({
    toolUseID: context.callId ?? `${context.toolName}:${context.turnId}`,
    data: {
      type: 'component_install',
      status: progress.stage,
      componentId: progress.componentId,
      ...('receivedBytes' in progress
        ? {
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
          }
        : {}),
    },
  });
}

export async function registerComponentTools(
  registry: ToolRegistry,
  manager: ComponentManager
): Promise<void> {
  registerPromptExtension('managed-components', (context) =>
    context.toolRegistry?.getTool('component_install') ? MANAGED_COMPONENTS_PROMPT : ''
  );

  await registry.register(
    COMPONENT_LIST_TOOL,
    async (_parameters, context) => {
      assertLocalDesktopTurn(context);
      return manager.list();
    },
    {
      riskAssessor: new StaticRiskAssessor(0),
      exposure: {
        mode: 'deferred',
        source: 'builtin',
        displayName: 'List WorkX Components',
        searchHint: 'optional local tools runtime duckdb install components',
      },
      runtime: {
        concurrency: {
          isConcurrencySafe: () => true,
          isReadOnly: () => true,
          isDestructive: () => false,
        },
        ui: {
          isSearchOrReadCommand: () => ({ isSearch: true, isRead: true, isList: true }),
        },
        result: { maxResultSizeChars: 20_000 },
      },
    }
  );

  await registry.register(
    COMPONENT_INSTALL_TOOL,
    async (parameters, context) => {
      assertLocalDesktopTurn(context);
      const componentId = String(parameters.component_id ?? '');
      return manager.install(componentId, {
        signal: context.signal,
        onProgress: (progress) => emitProgress(context, progress),
      });
    },
    {
      riskAssessor: new ComponentInstallRiskAssessor(),
      exposure: {
        mode: 'deferred',
        source: 'builtin',
        displayName: 'Install WorkX Component',
        searchHint: 'download install optional local tool duckdb runtime',
      },
      runtime: {
        concurrency: {
          isConcurrencySafe: () => false,
          isReadOnly: () => false,
          isDestructive: () => false,
        },
        ui: { getActivityDescription: () => 'Installing a WorkX-managed component' },
        result: { maxResultSizeChars: 10_000 },
      },
    }
  );
}
