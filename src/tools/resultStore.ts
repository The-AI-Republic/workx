/**
 * Platform-aware persistence for oversized tool results (track 09).
 *
 * When a tool result exceeds its threshold, the full content is persisted to a
 * backing store and the model receives a <persisted-output> preview + a
 * retrieval reference instead of a truncated tail. This is the BrowserX port
 * of Claudy's `toolResultStorage.ts` model, generalized for our multi-platform
 * runtime:
 *
 *   - extension / desktop / mobile → SessionCacheManager (IndexedDB)
 *   - server                       → filesystem (node:fs)
 */

import type { SessionCacheManager, CachedItem } from '../storage/SessionCacheManager';
import { ItemNotFoundError } from '../storage/SessionCacheManager';
import { PREVIEW_SIZE_BYTES } from './toolLimits';

// ============================================================================
// Public types
// ============================================================================

/**
 * Result of persisting a single oversized tool result.
 */
export interface PersistedResult {
  /**
   * Opaque retrieval reference returned to the model.
   *  - kind === 'cache' → SessionCacheManager storage key
   *  - kind === 'file'  → absolute file path
   */
  reference: string;
  /** Discriminant — drives the retrieval instruction in the preview message. */
  kind: 'cache' | 'file';
  /** Char length of the full serialized content (pre-persistence). */
  originalSize: number;
  /** First ~PREVIEW_SIZE_BYTES chars; cut at a newline when feasible. */
  preview: string;
  /** True iff the preview was truncated (there's more in the persisted blob). */
  hasMore: boolean;
}

/**
 * Backing store for oversized tool results.
 *
 * Implementations must be safe to call multiple times for the same
 * (sessionId, toolUseId) — replays after compaction/resume re-enter `persist`
 * and must not throw on duplicate writes.
 */
export interface ToolResultStore {
  persist(sessionId: string, toolUseId: string, content: string): Promise<PersistedResult>;
  retrieve(reference: string): Promise<string | null>;
  cleanup(sessionId: string): Promise<void>;
}

/**
 * Thrown by CacheToolResultStore.persist when content exceeds the cache's
 * single-item cap. Callers fall back to legacy truncation.
 */
export class ToolResultTooLargeForStoreError extends Error {
  constructor(public readonly contentLength: number, public readonly limit: number) {
    super(
      `Tool result of ${contentLength} chars exceeds the cache item limit of ${limit} chars`,
    );
    this.name = 'ToolResultTooLargeForStoreError';
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a preview snippet of the given content, capped at maxBytes.
 *
 * If a newline exists in the second half of the window, cut at it to avoid
 * mid-line truncation. Otherwise cut at the exact limit. Port of Claudy
 * `generatePreview` (utils/toolResultStorage.ts:339-356).
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false };
  }
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}

/**
 * Format a byte count as a human-readable size string, e.g. "1.2 KB", "245 KB",
 * "1.5 MB". Used in the preview message header.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Disarm any literal `</persisted-output>` (or `<persisted-output>`) substring
 * that appears inside raw tool output, so it can't terminate the wrapper
 * message early. A single backslash before the slash / before the tag name is
 * enough — the real wrapper tags emitted by `buildPersistedOutputMessage` never
 * contain a backslash, so the model can still locate the unambiguous boundary.
 *
 * Case-insensitive guard in case a tool returns mixed-case tag content.
 */
function escapePersistedOutputTags(preview: string): string {
  return preview
    .replace(/<\/persisted-output>/gi, '<\\/persisted-output>')
    .replace(/<persisted-output>/gi, '<\\persisted-output>');
}

/**
 * Build the <persisted-output> message that the model sees in place of the
 * truncated original. Branches on `kind` to give the model the right
 * retrieval instructions.
 */
export function buildPersistedOutputMessage(r: PersistedResult): string {
  const sizeStr = formatFileSize(r.originalSize);
  const previewLimit = formatFileSize(PREVIEW_SIZE_BYTES);
  const tail = r.hasMore ? '\n...\n' : '\n';
  const safePreview = escapePersistedOutputTags(r.preview);

  if (r.kind === 'cache') {
    return (
      `<persisted-output>\n` +
      `Output too large (${sizeStr}). Full output stored with key: ${r.reference}\n\n` +
      `To retrieve the full output, call cache_storage_tool with:\n` +
      `  { "action": "read", "storageKey": "${r.reference}" }\n\n` +
      `Preview (first ${previewLimit}):\n` +
      `${safePreview}${tail}` +
      `</persisted-output>`
    );
  }

  // kind === 'file' — server
  return (
    `<persisted-output>\n` +
    `Output too large (${sizeStr}). Full output saved to: ${r.reference}\n\n` +
    `To retrieve the full output, call read_persisted_result with:\n` +
    `  { "path": "${r.reference}" }\n\n` +
    `Preview (first ${previewLimit}):\n` +
    `${safePreview}${tail}` +
    `</persisted-output>`
  );
}

// ============================================================================
// Cache-backed store (extension / desktop / mobile)
// ============================================================================

/** 5 MB — SessionCacheManager.CACHE_CONSTANTS.MAX_ITEM_SIZE. Kept local so we
 *  can reject before calling into the cache and avoid the manager's exception. */
const CACHE_MAX_ITEM_SIZE = 5 * 1024 * 1024;

/** customMetadata.kind value used to tag our entries for selective cleanup. */
export const CACHE_TOOL_RESULT_KIND = 'tool_result';

export class CacheToolResultStore implements ToolResultStore {
  constructor(private cache: SessionCacheManager) {}

  async persist(
    sessionId: string,
    toolUseId: string,
    content: string,
  ): Promise<PersistedResult> {
    if (content.length > CACHE_MAX_ITEM_SIZE) {
      throw new ToolResultTooLargeForStoreError(content.length, CACHE_MAX_ITEM_SIZE);
    }
    const metadata = await this.cache.write(
      sessionId,
      { content },
      `tool_result:${toolUseId}`,
      undefined,
      undefined,
      { kind: CACHE_TOOL_RESULT_KIND, toolUseId },
    );
    const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES);
    return {
      reference: metadata.storageKey,
      kind: 'cache',
      originalSize: content.length,
      preview,
      hasMore,
    };
  }

  async retrieve(reference: string): Promise<string | null> {
    try {
      const item: CachedItem = await this.cache.read(reference);
      const data = item.data;
      if (data && typeof data === 'object' && typeof (data as any).content === 'string') {
        return (data as any).content as string;
      }
      return null;
    } catch (e) {
      if (e instanceof ItemNotFoundError) return null;
      throw e;
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    let entries;
    try {
      entries = await this.cache.list(sessionId);
    } catch (e) {
      console.warn('[CacheToolResultStore] list failed during cleanup:', e);
      return;
    }
    // CacheMetadata returned by list() does NOT include customMetadata; the
    // metadata projection drops it. We re-read each entry to inspect its tag.
    // For tool-result-only sessions this is O(N) but N is small; we accept it
    // to avoid changing the SessionCacheManager API for now.
    const targets: string[] = [];
    await Promise.all(
      entries.map(async (m) => {
        try {
          const full = await this.cache.read(m.storageKey);
          if (full.customMetadata?.kind === CACHE_TOOL_RESULT_KIND) {
            targets.push(m.storageKey);
          }
        } catch {
          // entry vanished mid-cleanup; ignore
        }
      }),
    );
    await Promise.all(targets.map((k) => this.cache.delete(k).catch(() => false)));
  }
}

// ============================================================================
// File-backed store (server)
// ============================================================================

export class FileToolResultStore implements ToolResultStore {
  /**
   * @param rootDir Absolute path to the parent directory under which sessions
   *                live. The store will use `{rootDir}/{sessionId}/tool-results/`.
   */
  constructor(private rootDir: string) {}

  private async pathFor(sessionId: string, toolUseId: string): Promise<string> {
    const { join } = await import('node:path');
    return join(this.rootDir, sessionId, 'tool-results', `${toolUseId}.txt`);
  }

  async persist(
    sessionId: string,
    toolUseId: string,
    content: string,
  ): Promise<PersistedResult> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const filepath = await this.pathFor(sessionId, toolUseId);
    await mkdir(dirname(filepath), { recursive: true });
    try {
      await writeFile(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    } catch (e: any) {
      // EEXIST: same toolUseId already persisted on a prior replayed turn.
      // The file content is deterministic, so the existing file is what the
      // model already saw — leave it alone. Any other errno is fatal here;
      // the caller will fall back to legacy truncation.
      if (e?.code !== 'EEXIST') throw e;
    }
    const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES);
    return {
      reference: filepath,
      kind: 'file',
      originalSize: content.length,
      preview,
      hasMore,
    };
  }

  async retrieve(reference: string): Promise<string | null> {
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(reference, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(this.rootDir, sessionId, 'tool-results');
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[FileToolResultStore] cleanup failed:', e);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export interface ToolResultStoreDeps {
  /** Required for extension/desktop/mobile platforms. */
  cache?: SessionCacheManager;
  /** Required for server platform; should already be joined to .../sessions. */
  serverRootDir?: string;
}

/**
 * Select the appropriate backing store for the current platform.
 *
 * Throws if a required dependency is missing for the current `__BUILD_MODE__`.
 * Callers should catch and fall back to "no persistence" rather than crashing
 * session construction.
 */
export function createToolResultStore(deps: ToolResultStoreDeps): ToolResultStore {
  const mode = typeof __BUILD_MODE__ !== 'undefined' ? __BUILD_MODE__ : 'extension';
  switch (mode) {
    case 'extension':
    case 'desktop':
    case 'mobile':
      if (!deps.cache) {
        throw new Error('createToolResultStore: SessionCacheManager required for this platform');
      }
      return new CacheToolResultStore(deps.cache);
    case 'server':
      if (!deps.serverRootDir) {
        throw new Error('createToolResultStore: serverRootDir required for server platform');
      }
      return new FileToolResultStore(deps.serverRootDir);
    default:
      throw new Error(`createToolResultStore: unknown build mode "${mode}"`);
  }
}
