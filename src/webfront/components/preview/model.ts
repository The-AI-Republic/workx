import type { Event } from '@/core/protocol/types';
import type {
  LocalFilePreviewItem,
  LocalFilePreviewView,
} from '@/types/ui';
import {
  LOCAL_FILE_SOURCE_MAX_BYTES,
  type LocalFileChangeProgress,
} from '@/tools/runtimeMetadata';

const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;

export function isLocalFileChangeProgress(value: unknown): value is LocalFileChangeProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Partial<LocalFileChangeProgress>;
  return progress.type === 'local_file_change'
    && progress.status === 'completed'
    && (progress.operation === 'created' || progress.operation === 'modified')
    && typeof progress.path === 'string'
    && progress.path.length > 0
    && !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(progress.path)
    && typeof progress.size === 'number'
    && Number.isFinite(progress.size)
    && progress.size >= 0
    && typeof progress.mtimeMs === 'number'
    && Number.isFinite(progress.mtimeMs);
}

export function availablePreviewViews(
  progress: LocalFileChangeProgress,
): LocalFilePreviewView[] {
  // V1 intentionally excludes large results even when a small patch happens
  // to exist; Source/Rendered would be unavailable and the item would be an
  // incomplete representation of the resulting local document.
  if (progress.size > LOCAL_FILE_SOURCE_MAX_BYTES) return [];
  const views: LocalFilePreviewView[] = [];
  if (typeof progress.unifiedDiff === 'string' && progress.unifiedDiff.length > 0) {
    views.push('diff');
  }
  if (MARKDOWN_EXTENSION.test(progress.path)) views.push('rendered');
  views.push('source');
  return views;
}

export function defaultPreviewView(item: LocalFilePreviewItem): LocalFilePreviewView {
  return item.availableViews.includes('diff') ? 'diff' : 'source';
}

export function localFilePreviewItemFromEvent(
  sessionId: string,
  event: Event,
): LocalFilePreviewItem | null {
  const msg = event.msg;
  if (msg.type !== 'ToolExecutionProgress') return null;
  const progress = msg.data.progress_data;
  if (!isLocalFileChangeProgress(progress)) return null;
  const availableViews = availablePreviewViews(progress);
  if (!availableViews.length) return null;
  return {
    id: event.id,
    sessionId,
    ...(msg.data.call_id ? { sourceCallId: msg.data.call_id } : {}),
    ...(msg.data.turn_id ? { turnId: msg.data.turn_id } : {}),
    resource: { type: 'local-text-file', path: progress.path.replace(/\\/g, '/') },
    operation: progress.operation,
    size: progress.size,
    mtimeMs: progress.mtimeMs,
    ...(progress.unifiedDiff ? { unifiedDiff: progress.unifiedDiff } : {}),
    ...(progress.diffOmittedReason ? { diffOmittedReason: progress.diffOmittedReason } : {}),
    availableViews,
    createdAt: msg.data.timestamp,
  };
}
