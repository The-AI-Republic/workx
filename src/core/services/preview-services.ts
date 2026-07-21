import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { ThreadIndexEntry } from '@/core/thread/ThreadIndexStore';
import { lexicalPathCheck } from '@/tools/file-search/pathPolicy';
import { LOCAL_FILE_SOURCE_MAX_BYTES } from '@/tools/runtimeMetadata';

export type PreviewServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'THREAD_NOT_FOUND'
  | 'NO_WORKSPACE'
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TEXT'
  | 'READ_FAILED';

export class PreviewServiceError extends Error {
  readonly retryable = false;
  readonly errorCode: PreviewServiceErrorCode;

  constructor(readonly code: PreviewServiceErrorCode, message: string) {
    super(message);
    this.name = 'PreviewServiceError';
    this.errorCode = code;
  }
}

export interface PreviewServiceDeps {
  registry: {
    getThread(sessionId: string): Promise<Pick<ThreadIndexEntry, 'workspace'>>;
  };
  stat(
    workspaceRoot: string,
    path: string,
  ): Promise<{ exists: boolean; size: number; mtimeMs: number }>;
  readFile(
    workspaceRoot: string,
    path: string,
  ): Promise<{
    contentLf: string;
    size: number;
    mtimeMs: number;
    encoding: 'utf8';
  }>;
}

export interface PreviewReadTextResult {
  path: string;
  contentLf: string;
  size: number;
  mtimeMs: number;
  encoding: 'utf8';
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PreviewServiceError('INVALID_ARGUMENT', `${name} is required`);
  }
  return value;
}

function normalizedRelativePath(value: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value)) {
    throw new PreviewServiceError('INVALID_ARGUMENT', 'path must be workspace-relative');
  }
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) {
        throw new PreviewServiceError('ACCESS_DENIED', 'path is outside the workspace');
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (!segments.length) {
    throw new PreviewServiceError('INVALID_ARGUMENT', 'path must identify a file');
  }
  return segments.join('/');
}

function mapReadError(error: unknown): PreviewServiceError {
  if (error instanceof PreviewServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not_found')) {
    return new PreviewServiceError('NOT_FOUND', 'The preview file no longer exists');
  }
  if (message.includes('unsupported_encoding')) {
    return new PreviewServiceError('UNSUPPORTED_TEXT', 'The preview file is not supported UTF-8 text');
  }
  if (
    message.includes('outside the workspace')
    || message.includes('protected blocklist')
    || message.includes('cannot be accessed')
  ) {
    return new PreviewServiceError('ACCESS_DENIED', 'The preview file cannot be accessed');
  }
  return new PreviewServiceError('READ_FAILED', 'The preview file could not be read');
}

export function createPreviewServices(deps: PreviewServiceDeps): Record<string, ServiceHandler> {
  return {
    'preview.readLocalText': async (params) => {
      const sessionId = requiredString(params.sessionId, 'sessionId').trim();
      const requestedPath = requiredString(params.path, 'path');
      const path = normalizedRelativePath(requestedPath);

      let entry: Pick<ThreadIndexEntry, 'workspace'>;
      try {
        entry = await deps.registry.getThread(sessionId);
      } catch {
        throw new PreviewServiceError('THREAD_NOT_FOUND', 'Thread not found');
      }
      const workspaceRoot = entry.workspace?.workingDirectory;
      if (!workspaceRoot?.trim()) {
        throw new PreviewServiceError('NO_WORKSPACE', 'The thread has no working folder');
      }

      const advisory = lexicalPathCheck(workspaceRoot, path);
      if (!advisory.ok) {
        throw new PreviewServiceError(
          advisory.reason === 'no_workspace' ? 'NO_WORKSPACE' : 'ACCESS_DENIED',
          'The preview path is not accessible',
        );
      }

      let metadata: Awaited<ReturnType<PreviewServiceDeps['stat']>>;
      try {
        metadata = await deps.stat(workspaceRoot, path);
      } catch (error) {
        throw mapReadError(error);
      }
      if (!metadata.exists) {
        throw new PreviewServiceError('NOT_FOUND', 'The preview file no longer exists');
      }
      if (metadata.size > LOCAL_FILE_SOURCE_MAX_BYTES) {
        throw new PreviewServiceError('TOO_LARGE', 'The preview file exceeds the 1 MiB limit');
      }

      try {
        const result = await deps.readFile(workspaceRoot, path);
        const actualBytes = new TextEncoder().encode(result.contentLf).byteLength;
        if (result.size > LOCAL_FILE_SOURCE_MAX_BYTES || actualBytes > LOCAL_FILE_SOURCE_MAX_BYTES) {
          throw new PreviewServiceError('TOO_LARGE', 'The preview file exceeds the 1 MiB limit');
        }
        return {
          path,
          contentLf: result.contentLf,
          size: result.size,
          mtimeMs: result.mtimeMs,
          encoding: 'utf8',
        } satisfies PreviewReadTextResult;
      } catch (error) {
        throw mapReadError(error);
      }
    },
  };
}
