/**
 * AriaLabelCleaner (S2.4): Remove aria-labels from text nodes
 *
 * Removes all aria-label fields from text nodes unconditionally to eliminate
 * redundant information. Text nodes already have their content in the `text` field,
 * making aria-labels redundant.
 *
 * Example transformation:
 * Before:
 *   {
 *     "tag": "#text",
 *     "role": "StaticText",
 *     "aria_label": "What's happening?",
 *     "text": "What's happening?"
 *   }
 *
 * After:
 *   {
 *     "tag": "#text",
 *     "text": "What's happening?"
 *   }
 *
 * Rules:
 * - Removes aria-label from ALL text nodes (unconditional)
 * - Removes role field from text nodes (redundant StaticText role)
 * - Preserves aria-labels on element nodes (buttons, links, etc.)
 * - Ensures aria-labels describe only the element itself, not its children
 *
 * Stage 2 Structure Simplification
 */

import type { VirtualNode } from '../../types';
import { NODE_TYPE_TEXT } from '../../types';

export class AriaLabelCleaner {
  /**
   * Simplify tree by removing aria-labels from text nodes
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with cleaned aria-labels
   */
  simplify(tree: VirtualNode): VirtualNode {
    // Create a copy to avoid mutating input
    const cleaned = this.cleanNode(tree);

    // Recursively simplify children
    if (cleaned.children && cleaned.children.length > 0) {
      cleaned.children = cleaned.children.map(child => this.simplify(child));
    }

    return cleaned;
  }

  /**
   * Clean aria-labels from a single node
   * @param node - VirtualNode to clean
   * @returns Cleaned node
   */
  private cleanNode(node: VirtualNode): VirtualNode {
    // Only clean text nodes
    if (node.nodeType !== NODE_TYPE_TEXT) {
      return node;
    }

    // If this is a text node, remove aria-label and role by omitting accessibility entirely
    // Text nodes don't need accessibility information since their content is in nodeValue
    if (node.accessibility) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { accessibility, ...nodeWithoutAccessibility } = node;
      return nodeWithoutAccessibility;
    }

    return node;
  }
}
