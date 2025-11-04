/**
 * SnapshotCompressor - Pure utility functions for DOM snapshot compression
 *
 * This module provides stateless compression utilities for reducing token consumption
 * in chat history by compressing outdated DOM snapshots while preserving metadata.
 *
 * Design principle: All functions are pure (no side effects, stateless)
 *
 * @module SnapshotCompressor
 * @since 1.0.0
 * @author BrowserX Team
 *
 * @example
 * ```typescript
 * import { isDOMSnapshotOutput, compressSnapshot } from './SnapshotCompressor';
 *
 * if (isDOMSnapshotOutput(item)) {
 *   const compressed = compressSnapshot(item);
 *   // compressed.output now contains placeholder instead of full DOM
 * }
 * ```
 */

import type { ResponseItem } from '../../../protocol/types';

/**
 * Placeholder message for compressed snapshots
 *
 * This message replaces the full DOM body in compressed snapshots,
 * signaling to the LLM that the data is outdated and a fresh snapshot
 * should be captured if current page information is needed.
 *
 * @constant
 * @type {string}
 */
export const COMPRESSED_SNAPSHOT_PLACEHOLDER =
  'This snapshot is outdated. Make a new snapshot function call to get the latest page information if needed.';

/**
 * Type guard to check if a ResponseItem is a DOM snapshot function call output
 *
 * Detects DOM snapshots by checking for:
 * - Type is 'function_call_output'
 * - metadata.toolName === 'browser_dom'
 * - success === true
 * - data.page.context exists (URL, title)
 * - data.page.body exists (DOM tree)
 *
 * @param item - ResponseItem to check
 * @returns `true` if item is a DOM snapshot output, `false` otherwise
 *
 * @example
 * ```typescript
 * if (isDOMSnapshotOutput(item)) {
 *   // Safe to access item.output as DOM snapshot
 *   const snapshot = JSON.parse(item.output);
 *   console.log(snapshot.data.page.context.url);
 * }
 * ```
 */
export function isDOMSnapshotOutput(item: ResponseItem): boolean {
  // Must be function_call_output type
  if (item.type !== 'function_call_output') {
    return false;
  }

  try {
    // Parse the output JSON from executeBrowserTool: { data: SerializedDom, metadata: { toolName, action? } }
    const parsed = JSON.parse(item.output);

    // Check for DOM snapshot using two methods:
    // 1. Primary: Check metadata.action === 'snapshot' (most reliable when available)
    // 2. Fallback: Check for page.body structure (for cases where action is missing)
    const isBrowserDomTool = parsed.metadata?.toolName === 'browser_dom';
    const hasSnapshotAction = parsed.metadata?.action === 'snapshot';
    const hasPageStructure = parsed.data?.page?.context !== undefined &&
                             parsed.data?.page?.body !== undefined;

    return isBrowserDomTool && (hasSnapshotAction || hasPageStructure);
  } catch {
    // JSON parse failed, not a valid snapshot
    return false;
  }
}

/**
 * Type guard to check if a snapshot has already been compressed
 *
 * Detects compressed snapshots by checking if the body is a string (placeholder)
 * instead of an object (SerializedNode structure).
 *
 * @param item - ResponseItem to check
 * @returns `true` if item is already compressed, `false` otherwise
 *
 * @example
 * ```typescript
 * if (isCompressedSnapshot(item)) {
 *   console.log('Snapshot already compressed, skipping');
 *   return item;
 * }
 * ```
 */
export function isCompressedSnapshot(item: ResponseItem): boolean {
  if (item.type !== 'function_call_output') {
    return false;
  }

  try {
    const parsed = JSON.parse(item.output);

    // Check for compressed snapshot structure: { data: { page: { body: string } }, metadata }
    const body = parsed.data?.page?.body;

    if (!body) {
      return false;
    }

    // Compressed snapshots have body as string (placeholder message)
    // Original snapshots have body as object (SerializedNode)
    // Also check string size - compressed placeholders are much smaller (<500 chars)
    // while serialized snapshots are typically large (>10000 chars)
    return typeof body === 'string' && body.length < 500;
  } catch {
    return false;
  }
}

/**
 * Compress a DOM snapshot by replacing the body with a placeholder message
 * while preserving URL and title metadata
 *
 * This function:
 * 1. Checks if the item is a DOM snapshot (returns unchanged if not)
 * 2. Checks if already compressed (returns unchanged if so)
 * 3. Replaces the page.body with a placeholder message
 * 4. Preserves page.context (URL, title)
 * 5. Preserves all metadata fields
 *
 * Compression typically reduces snapshot size by 90-99%.
 *
 * @param item - ResponseItem containing DOM snapshot to compress
 * @returns Compressed ResponseItem with placeholder body, or original item if not compressible
 *
 * @example
 * ```typescript
 * const snapshot = createDOMSnapshot();
 * const compressed = compressSnapshot(snapshot);
 *
 * console.log(snapshot.output.length);    // ~50,000 chars
 * console.log(compressed.output.length);  // ~500 chars
 * // 99% reduction in token consumption
 * ```
 */
export function compressSnapshot(item: ResponseItem): ResponseItem {
  // Type check
  if (item.type !== 'function_call_output') {
    return item;
  }

  // Check if already compressed
  if (isCompressedSnapshot(item)) {
    return item;
  }

  // Check if this is a DOM snapshot
  if (!isDOMSnapshotOutput(item)) {
    return item;
  }

  try {
    // Parse the output: { data: SerializedDom, metadata }
    const parsed = JSON.parse(item.output);

    // Create compressed version by replacing body in data.page
    const compressed = {
      ...parsed,
      data: {
        ...parsed.data,
        page: {
          context: {
            // Preserve URL and title metadata
            url: parsed.data.page.context.url,
            title: parsed.data.page.context.title,
          },
          // Replace body with placeholder message
          body: COMPRESSED_SNAPSHOT_PLACEHOLDER,
        },
      },
    };

    // Return new ResponseItem with compressed output
    return {
      ...item,
      output: JSON.stringify(compressed),
    };
  } catch (error) {
    // If compression fails, return original item
    console.warn('Failed to compress snapshot:', error);
    return item;
  }
}
