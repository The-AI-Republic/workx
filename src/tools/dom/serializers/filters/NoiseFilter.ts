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

import { VirtualNode } from '../../types';
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
    if (tree.children && tree.children.length > 0) {
      const filteredChildren = tree.children
        .map(child => this.filter(child))
        .filter((child): child is VirtualNode => child !== null);

      // Return node with filtered children
      return {
        ...tree,
        children: filteredChildren.length > 0 ? filteredChildren : undefined
      };
    }

    return tree;
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
