/**
 * TextNodeFilter (F2): Remove tiny text nodes
 *
 * Removes text nodes with less than 2 characters, unless:
 * - Parent element is interactive (semantic or non-semantic)
 * - Text is meaningful whitespace (tab, newline)
 *
 * Rationale: Single-character text nodes are often layout artifacts
 * (e.g., whitespace between <span> elements) with no semantic value.
 * Interactive elements preserve their text content regardless of length.
 *
 * Stage 1 Signal Filtering
 */

import { VirtualNode } from '../../types';
import { NODE_TYPE_TEXT } from '../../types';

export class TextNodeFilter {
  private minTextLength: number;

  constructor(minTextLength: number = 3) {
    this.minTextLength = minTextLength;
  }

  /**
   * Filter tree to remove tiny text nodes
   * @param tree - VirtualNode tree to filter
   * @returns Filtered tree with tiny text nodes removed
   */
  filter(tree: VirtualNode): VirtualNode | null {
    // Check if this is a tiny text node
    if (this.isTinyTextNode(tree, false)) {
      return null;
    }

    // Recursively filter children
    if (tree.children && tree.children.length > 0) {
      // Check if parent is interactive
      const parentIsInteractive = this.isInteractive(tree);

      const filteredChildren = tree.children
        .map(child => {
          // Text nodes: check if tiny (with parent context)
          if (child.nodeType === NODE_TYPE_TEXT) {
            return this.isTinyTextNode(child, parentIsInteractive) ? null : child;
          }
          // Element nodes: recurse
          return this.filter(child);
        })
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
   * Check if node is a tiny text node that should be filtered
   * @param node - VirtualNode to check
   * @param parentIsInteractive - Whether parent element is interactive
   * @returns true if should be filtered, false otherwise
   */
  private isTinyTextNode(node: VirtualNode, parentIsInteractive: boolean): boolean {
    // Only filter text nodes
    if (node.nodeType !== NODE_TYPE_TEXT) {
      return false;
    }

    // Get text content
    const text = node.nodeValue || '';

    // Exception: Interactive parent preserves all text
    if (parentIsInteractive) {
      return false;
    }

    // Exception: Whitespace-only with meaningful characters (tab, newline)
    if (this.hasMeaningfulWhitespace(text)) {
      return false;
    }

    // Filter if text length < minTextLength
    if (text.trim().length < this.minTextLength) {
      return true;
    }

    return false;
  }

  /**
   * Check if element is interactive
   */
  private isInteractive(node: VirtualNode): boolean {
    return node.tier === 'semantic' || node.tier === 'non-semantic';
  }

  /**
   * Check if text contains meaningful whitespace
   */
  private hasMeaningfulWhitespace(text: string): boolean {
    // Tab or newline characters are meaningful for formatting
    return text.includes('\t') || text.includes('\n');
  }
}
