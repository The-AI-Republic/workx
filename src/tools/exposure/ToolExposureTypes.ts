import type { IToolsConfig } from '../../config/types';
import type { ToolDefinition } from '../BaseTool';

export type ToolExposureMode = 'always' | 'deferred' | 'hidden';

export type ToolExposureSource =
  | 'builtin'
  | 'mcp'
  | 'a2a'
  | 'skill'
  | 'plugin'
  | 'custom';

export interface ToolExposureProfile {
  mode?: ToolExposureMode;
  source?: ToolExposureSource;
  searchHint?: string;
  displayName?: string;
  serverName?: string;
  alwaysLoadReason?: string;
  /**
   * True for tools from a builtin MCP server (e.g. the AI Hub gateway). These
   * are first-party, so they are exempt from the user-facing `mcpTools` toggle
   * (which gates user-added MCP servers) — an installed/activated Hub app is
   * usable without flipping a generic MCP switch.
   */
  builtin?: boolean;
}

export type ToolExposureReason =
  | 'default-always'
  | 'default-deferred-source'
  | 'default-hidden'
  | 'tool-search'
  | 'selected'
  | 'config-always'
  | 'config-deferred'
  | 'config-hidden'
  | 'disabled'
  | 'mcp-disabled'
  | 'active-allow-list'
  | 'dynamic-disabled';

export interface ToolRegistryExposureEntry {
  name: string;
  definition: ToolDefinition;
  exposure?: ToolExposureProfile;
}

export interface ToolExposureDecision {
  name: string;
  definition: ToolDefinition;
  profile: ToolExposureProfile;
  mode: ToolExposureMode;
  reason: ToolExposureReason;
  selected: boolean;
  description: string;
}

export interface ToolExposureDiagnostics {
  dynamicEnabled: boolean;
  alwaysCount: number;
  deferredCount: number;
  hiddenCount: number;
  selectedCount: number;
  estimatedDeferredSchemaChars: number;
  estimatedDeferredSchemaTokens: number;
  thresholdTokens?: number;
}

export interface ToolExposureBuildInput {
  entries: ToolRegistryExposureEntry[];
  toolsConfig: IToolsConfig;
  sessionId: string;
  taskId?: string;
  modelContextWindow?: number;
  isToolAllowed?: (toolName: string) => boolean;
}

export interface ToolExposureBuildResult {
  tools: ToolDefinition[];
  always: ToolExposureDecision[];
  deferred: ToolExposureDecision[];
  hidden: ToolExposureDecision[];
  selected: ToolExposureDecision[];
  reminder?: string;
  diagnostics: ToolExposureDiagnostics;
}
