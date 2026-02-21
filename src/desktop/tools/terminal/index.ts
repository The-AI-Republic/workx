/**
 * Desktop Terminal Tools
 *
 * Exports terminal execution tools for the desktop application.
 *
 * @module desktop/tools/terminal
 */

export {
  SecurityFilter,
  type SecurityConfig,
  type FilterResult,
} from './SecurityFilter';
export {
  TerminalTool,
  type ExecuteOptions,
  type ExecuteResult,
  type TerminalToolDefinition,
} from './TerminalTool';
export {
  SandboxManager,
  type ExecutionMode,
  type WorkspaceAccess,
  type NetworkMode,
  type BindMount,
  type SandboxStatus,
  type SandboxStatusResult,
  type SandboxInstallResult,
  type SandboxConfig,
} from './SandboxManager';
