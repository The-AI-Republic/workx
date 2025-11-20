/**
 * NoiseFilter (F3): Remove script, style, and metadata elements
 *
 * Removes elements that contain no user-visible content:
 * - <script>: JavaScript code
 * - <style>: CSS styling
 * - <noscript>: Fallback content for no-JS browsers
 * - <meta>: Document metadata
 * - <link>: External resource links (stylesheets, icons)
 * - HTML comments
 *
 * These elements provide functionality or metadata but have no
 * interactive content for the LLM to act upon.
 *
 * Stage 1 Signal Filtering
 */

import type { VirtualNode } from '../../types';
import { NODE_TYPE_COMMENT } from '../../types';

export class NoiseFilter {
  private noiseTags: Set<string>;

  constructor() {
    // Tags that should be filtered out
    this.noiseTags = new Set([
      'script',
      'style',
      'noscript',
      'meta',
      'link',
      'base',
      'title' // Document title is captured in PageContext
    ]);
  }

  /**
   * Filter tree to remove noise elements
   * @param tree - VirtualNode tree to filter
   * @returns Filtered tree with noise elements removed
   */
  filter(tree: VirtualNode): VirtualNode | null {
    // Check if this node is noise
    if (this.isNoise(tree)) {
      return null;
    }

    // Recursively filter children
    let filteredChildren: VirtualNode[] | undefined;
    if (tree.children && tree.children.length > 0) {
      const filtered = tree.children
        .map(child => this.filter(child))
        .filter((child): child is VirtualNode => child !== null);
      filteredChildren = filtered.length > 0 ? filtered : undefined;
    }

    // Recursively filter shadow roots
    let filteredShadowRoots: VirtualNode[] | undefined;
    if (tree.shadowRoots && tree.shadowRoots.length > 0) {
      const filtered = tree.shadowRoots
        .map(sr => this.filter(sr))
        .filter((sr): sr is VirtualNode => sr !== null);
      filteredShadowRoots = filtered.length > 0 ? filtered : undefined;
    }

    // Recursively filter content document
    let filteredContentDocument: VirtualNode | undefined;
    if (tree.contentDocument) {
      filteredContentDocument = this.filter(tree.contentDocument) || undefined;
    }

    // Return node with filtered content
    // Only return if we have children, shadow roots, or content document, OR if it's not a container that became empty
    // But NoiseFilter only removes specific tags, so we should return the tree with updated children
    return {
      ...tree,
      children: filteredChildren,
      shadowRoots: filteredShadowRoots,
      contentDocument: filteredContentDocument
    };
  }

  /**
   * Check if element is noise
   * @param node - VirtualNode to check
   * @returns true if noise, false otherwise
   */
  private isNoise(node: VirtualNode): boolean {
    // Check for comment nodes
    if (node.nodeType === NODE_TYPE_COMMENT) {
      return true;
    }

    // Check for noise tags
    const tagName = (node.localName || node.nodeName || '').toLowerCase();
    if (this.noiseTags.has(tagName)) {
      return true;
    }

    return false;
  }
}
