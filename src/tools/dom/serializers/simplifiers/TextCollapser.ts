/**
 * TextCollapser (S2.1): Merge consecutive text nodes
 *
 * Combines consecutive text-only children into a single merged text node.
 * Reduces token count by eliminating redundant node structure.
 *
 * Example transformation:
 * Before:
 *   <p>
 *     #text("Hello ")
 *     #text("world")
 *   </p>
 *
 * After:
 *   <p>
 *     #text("Hello world")
 *   </p>
 *
 * Rules:
 * - Only merges direct sibling text nodes
 * - Preserves whitespace (concatenates as-is)
 * - Does not merge across element boundaries
 *
 * Stage 2 Structure Simplification
 */

import { VirtualNode } from '../../types';
import { NODE_TYPE_TEXT } from '../../types';

export class TextCollapser {
  /**
   * Collapse consecutive text nodes in tree
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with merged text nodes
   */
  collapse(tree: VirtualNode): VirtualNode {
    // Recursively collapse children first
    if (tree.children && tree.children.length > 0) {
      // Process children recursively
      const processedChildren = tree.children.map(child => this.collapse(child));

      // Merge consecutive text nodes
      const collapsedChildren = this.mergeConsecutiveTextNodes(processedChildren);

      return {
        ...tree,
        children: collapsedChildren.length > 0 ? collapsedChildren : undefined
      };
    }

    return tree;
  }

  /**
   * Merge consecutive text nodes in children array
   */
  private mergeConsecutiveTextNodes(children: VirtualNode[]): VirtualNode[] {
    if (children.length <= 1) {
      return children;
    }

    const result: VirtualNode[] = [];
    let i = 0;

    while (i < children.length) {
      const current = children[i];

      // If not a text node, add as-is and continue
      if (current.nodeType !== NODE_TYPE_TEXT) {
        result.push(current);
        i++;
        continue;
      }

      // Text node: collect consecutive text nodes
      const textNodes: VirtualNode[] = [current];
      let j = i + 1;

      while (j < children.length && children[j].nodeType === NODE_TYPE_TEXT) {
        textNodes.push(children[j]);
        j++;
      }

      // If only one text node, add as-is
      if (textNodes.length === 1) {
        result.push(current);
        i++;
        continue;
      }

      // Merge multiple consecutive text nodes
      const mergedNode = this.mergeTextNodes(textNodes);
      result.push(mergedNode);
      i = j;
    }

    return result;
  }

  /**
   * Merge multiple text nodes into single node
   */
  private mergeTextNodes(textNodes: VirtualNode[]): VirtualNode {
    // Concatenate text content
    const mergedText = textNodes
      .map(node => node.nodeValue || '')
      .join('');

    // Use first node as base, update nodeValue
    return {
      ...textNodes[0],
      nodeValue: mergedText
    };
  }
}
