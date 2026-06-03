import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition } from '../BaseTool';
import type {
  ToolExposureBuildInput,
  ToolExposureBuildResult,
  ToolExposureDecision,
  ToolExposureMode,
  ToolExposureProfile,
  ToolExposureReason,
  ToolRegistryExposureEntry,
} from './ToolExposureTypes';
import { ToolSelectionStore } from './ToolSelectionStore';

const DEFAULT_DYNAMIC_THRESHOLD_PERCENT = 2;
const DEFERRED_BY_DEFAULT = new Set(['mcp', 'a2a', 'plugin']);

export class ToolExposureManager {
  constructor(private readonly selectionStore: ToolSelectionStore) {}

  buildExposure(input: ToolExposureBuildInput): ToolExposureBuildResult {
    const classified = input.entries.map((entry) => this.classify(entry, input));
    const always = classified.filter((d) => d.mode === 'always');
    const deferred = classified.filter((d) => d.mode === 'deferred');
    const hidden = classified.filter((d) => d.mode === 'hidden');
    const estimatedDeferredSchemaChars = estimateSchemaChars(deferred.map((d) => d.definition));
    const estimatedDeferredSchemaTokens = Math.ceil(estimatedDeferredSchemaChars / 4);
    const dynamicEnabled = this.isDynamicEnabled(input.toolsConfig, estimatedDeferredSchemaTokens, input.modelContextWindow);

    if (!dynamicEnabled) {
      const exposed = classified
        .filter((d) => d.mode !== 'hidden' && d.name !== 'tool_search')
        .map((d) => ({ ...d, mode: 'always' as ToolExposureMode, reason: d.mode === 'deferred' ? 'dynamic-disabled' as ToolExposureReason : d.reason }));
      return {
        tools: exposed.map((d) => d.definition),
        always: exposed,
        deferred,
        hidden,
        selected: [],
        diagnostics: {
          dynamicEnabled: false,
          alwaysCount: exposed.length,
          deferredCount: deferred.length,
          hiddenCount: hidden.length,
          selectedCount: 0,
          estimatedDeferredSchemaChars,
          estimatedDeferredSchemaTokens,
          thresholdTokens: this.thresholdTokens(input.toolsConfig, input.modelContextWindow),
        },
      };
    }

    const selected = deferred.filter((d) => d.selected);
    const includeToolSearch = deferred.length > 0;
    const exposed = [
      ...always.filter((d) => d.name !== 'tool_search'),
      ...(includeToolSearch ? always.filter((d) => d.name === 'tool_search') : []),
      ...selected,
    ];

    return {
      tools: exposed.map((d) => d.definition),
      always: always.filter((d) => d.name !== 'tool_search' || includeToolSearch),
      deferred,
      hidden,
      selected,
      reminder: this.buildReminder(deferred),
      diagnostics: {
        dynamicEnabled: true,
        alwaysCount: always.length,
        deferredCount: deferred.length,
        hiddenCount: hidden.length,
        selectedCount: selected.length,
        estimatedDeferredSchemaChars,
        estimatedDeferredSchemaTokens,
        thresholdTokens: this.thresholdTokens(input.toolsConfig, input.modelContextWindow),
      },
    };
  }

  getSearchableDeferredTools(input: ToolExposureBuildInput): ToolExposureDecision[] {
    return this.buildExposure(input).deferred;
  }

  private classify(entry: ToolRegistryExposureEntry, input: ToolExposureBuildInput): ToolExposureDecision {
    const profile = normalizeProfile(entry);
    const description = getToolDescription(entry.definition);
    const selectedNames = new Set(this.selectionStore.getSelected({
      sessionId: input.sessionId,
      taskId: input.taskId,
    }));

    if (input.isToolAllowed && !input.isToolAllowed(entry.name)) {
      return decision(entry, profile, 'hidden', 'active-allow-list', false, description);
    }
    if (input.toolsConfig.disabled?.includes(entry.name) || input.toolsConfig.hiddenTools?.includes(entry.name)) {
      return decision(entry, profile, 'hidden', input.toolsConfig.disabled?.includes(entry.name) ? 'disabled' : 'config-hidden', false, description);
    }
    if (profile.source === 'mcp' && !(input.toolsConfig.enable_all_tools || input.toolsConfig.mcpTools === true)) {
      return decision(entry, profile, 'hidden', 'mcp-disabled', false, description);
    }
    if (entry.name === 'tool_search') {
      return decision(entry, profile, 'always', 'tool-search', false, description);
    }
    if (input.toolsConfig.alwaysLoadTools?.includes(entry.name)) {
      return decision(entry, profile, 'always', 'config-always', false, description);
    }
    if (input.toolsConfig.deferTools?.includes(entry.name)) {
      return decision(entry, profile, 'deferred', 'config-deferred', selectedNames.has(entry.name), description);
    }
    if (profile.mode === 'hidden') {
      return decision(entry, profile, 'hidden', 'default-hidden', false, description);
    }
    if (profile.mode === 'always') {
      return decision(entry, profile, 'always', 'default-always', false, description);
    }
    if (profile.mode === 'deferred' || DEFERRED_BY_DEFAULT.has(profile.source ?? 'builtin')) {
      return decision(entry, profile, 'deferred', 'default-deferred-source', selectedNames.has(entry.name), description);
    }
    return decision(entry, profile, 'always', 'default-always', false, description);
  }

  private isDynamicEnabled(config: IToolsConfig, estimatedDeferredSchemaTokens: number, contextWindow?: number): boolean {
    const mode = config.dynamicToolLoading ?? 'auto';
    if (mode === true) return true;
    if (mode === false) return false;
    const threshold = this.thresholdTokens(config, contextWindow);
    return threshold !== undefined && estimatedDeferredSchemaTokens >= threshold;
  }

  private thresholdTokens(config: IToolsConfig, contextWindow?: number): number | undefined {
    if (!contextWindow || contextWindow <= 0) return undefined;
    const pct = config.dynamicToolLoadingThresholdPercent ?? DEFAULT_DYNAMIC_THRESHOLD_PERCENT;
    return Math.max(1, Math.floor(contextWindow * (pct / 100)));
  }

  private buildReminder(deferred: ToolExposureDecision[]): string | undefined {
    if (deferred.length === 0) return undefined;
    const lines = deferred.slice(0, 30).map((tool) => {
      const source = tool.profile.serverName ?? tool.profile.source ?? 'tool';
      return `- [${source}] ${tool.name}: ${tool.description}`;
    });
    const suffix = deferred.length > lines.length
      ? `\n- ...and ${deferred.length - lines.length} more. Use tool_search with a specific query.`
      : '';
    return `Deferred tools are available through tool_search. Search and select one before using it.\n${lines.join('\n')}${suffix}`;
  }
}

function normalizeProfile(entry: ToolRegistryExposureEntry): ToolExposureProfile {
  return {
    source: 'builtin',
    ...entry.exposure,
  };
}

function decision(
  entry: ToolRegistryExposureEntry,
  profile: ToolExposureProfile,
  mode: ToolExposureMode,
  reason: ToolExposureReason,
  selected: boolean,
  description: string,
): ToolExposureDecision {
  return {
    name: entry.name,
    definition: entry.definition,
    profile,
    mode,
    reason: selected && mode === 'deferred' ? 'selected' : reason,
    selected,
    description,
  };
}

function getToolDescription(tool: ToolDefinition): string {
  if (tool.type === 'function') return tool.function.description;
  if (tool.type === 'custom') return tool.custom.description;
  if (tool.type === 'local_shell') return 'Execute local shell commands';
  if (tool.type === 'web_search') return 'Search the web';
  return '';
}

function estimateSchemaChars(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
}
