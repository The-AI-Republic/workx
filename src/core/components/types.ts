export type ComponentPlatform =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'win32-x64'
  | 'win32-arm64';

export interface ComponentArchive {
  format: 'zip-single-file';
  /** Exact archive entry to extract. Other entries are never written. */
  entry: string;
  /** Logical entrypoint that receives the extracted single-file payload. */
  targetEntrypoint: string;
  /** Reject a trusted artifact if its extracted payload exceeds this bound. */
  maxExtractedBytes: number;
}

export interface ComponentArtifact {
  platform: ComponentPlatform;
  url: string;
  sha256: string;
  downloadSizeBytes: number;
  archive: ComponentArchive;
  /** Platform-specific paths, for example the .exe suffix on Windows. */
  entrypointOverrides?: Record<string, string>;
}

export interface ComponentHealthCheck {
  entrypoint: string;
  args: string[];
  expectedOutputPattern: string;
  timeoutMs: number;
}

export interface ComponentDefinition {
  id: string;
  displayName: string;
  description: string;
  version: string;
  capabilities: string[];
  entrypoints: Record<string, string>;
  artifacts: ComponentArtifact[];
  healthCheck: ComponentHealthCheck;
  license: {
    name: string;
    url: string;
  };
  homepage: string;
  source: {
    publisher: string;
    repository: string;
    trustedOrigins: string[];
  };
}

export type ComponentState = 'not_installed' | 'installed' | 'invalid' | 'unsupported';

export interface InstalledComponentRecord {
  schemaVersion: 1;
  id: string;
  version: string;
  platform: ComponentPlatform;
  installedAt: string;
  lastVerifiedAt: string;
  lastUsedAt?: string;
  installedSizeBytes: number;
  artifact: {
    url: string;
    sha256: string;
    downloadSizeBytes: number;
  };
  entrypoints: Record<string, string>;
  fileSha256: Record<string, string>;
}

export interface ComponentView {
  id: string;
  displayName: string;
  description: string;
  version: string;
  platform?: ComponentPlatform;
  capabilities: string[];
  state: ComponentState;
  downloadSizeBytes?: number;
  installedSizeBytes?: number;
  installedAt?: string;
  lastVerifiedAt?: string;
  lastUsedAt?: string;
  license: ComponentDefinition['license'];
  homepage: string;
  errorCode?: ComponentErrorCode;
}

export interface ComponentRuntimeStatus {
  state: 'ready' | 'unavailable' | 'stopping';
  available: boolean;
  rootPath?: string;
  componentsPath?: string;
  workspacesPath?: string;
  errorCode?: ComponentErrorCode;
}

export type ComponentProgress =
  | { stage: 'preparing'; componentId: string }
  | { stage: 'downloading'; componentId: string; receivedBytes: number; totalBytes: number }
  | { stage: 'verifying'; componentId: string }
  | { stage: 'installing'; componentId: string }
  | { stage: 'health_check'; componentId: string }
  | { stage: 'completed'; componentId: string };

export interface ComponentInstallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ComponentProgress) => void;
}

export interface ComponentLease {
  component: ComponentView;
  executablePath: string;
  release(): Promise<void>;
}

export interface ComponentManager {
  initialize(): Promise<void>;
  status(): ComponentRuntimeStatus;
  list(): Promise<ComponentView[]>;
  get(componentId: string): Promise<ComponentView>;
  install(componentId: string, options?: ComponentInstallOptions): Promise<ComponentView>;
  verify(componentId: string, signal?: AbortSignal): Promise<ComponentView>;
  uninstall(componentId: string): Promise<void>;
  resolveEntrypoint(componentId: string, entrypoint: string): Promise<string>;
  acquireEntrypoint(componentId: string, entrypoint: string): Promise<ComponentLease>;
  dispose(): Promise<void>;
}

export interface ComponentRunRequest {
  componentId: string;
  entrypoint: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ComponentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type ComponentErrorCode =
  | 'COMPONENTS_UNAVAILABLE'
  | 'COMPONENT_NOT_FOUND'
  | 'COMPONENT_UNSUPPORTED'
  | 'COMPONENT_NOT_INSTALLED'
  | 'COMPONENT_INVALID'
  | 'COMPONENT_DOWNLOAD_FAILED'
  | 'COMPONENT_DOWNLOAD_SIZE_MISMATCH'
  | 'COMPONENT_CHECKSUM_MISMATCH'
  | 'COMPONENT_ARCHIVE_INVALID'
  | 'COMPONENT_HEALTH_CHECK_FAILED'
  | 'COMPONENT_BUSY'
  | 'COMPONENT_INSTALL_CANCELLED'
  | 'COMPONENT_INSTALL_LOCKED'
  | 'COMPONENT_PATH_INVALID'
  | 'COMPONENT_EXECUTION_FAILED'
  | 'COMPONENT_EXECUTION_TIMEOUT'
  | 'COMPONENT_OUTPUT_LIMIT_EXCEEDED'
  | 'COMPONENT_ACCESS_DENIED';
