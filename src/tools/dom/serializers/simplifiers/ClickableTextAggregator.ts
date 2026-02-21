/**
 * ClickableTextAggregator (S2.3): Aggregate nested text in clickable elements
 *
 * Collapses all text content from deeply nested descendants of clickable elements
 * into a single string field, removing intermediate child nodes.
 *
 * Example transformation:
 * Before:
 *   <a role="tab" aria-label="For you">
 *     <span>
 *       <span>
 *         <span>For you</span>
 *       </span>
 *     </span>
 *   </a>
 *
 * After:
 *   <a role="tab" aria-label="For you" text="For you"></a>
 *
 * Rules:
 * - Only aggregates text from clickable elements (button, link, tab, menuitem)
 * - Performs depth-first traversal to collect all text node values
 * - Skips invisible text (display:none, visibility:hidden)
 * - Joins text with single space, trims whitespace
 * - Preserves aria-label if aggregated text is empty (icon-only buttons)
 * - Replaces children array with empty array after aggregation
 *
 * Stage 2 Structure Simplification
 */

import type { VirtualNode } from '../../types';
import { NODE_TYPE_TEXT } from '../../types';

export class ClickableTextAggregator {
  /**
   * Simplify tree by aggregating text content in clickable elements
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with aggregated text in clickable elements
   */
  simplify(tree: VirtualNode): VirtualNode {
    // Recursively simplify children first
    if (tree.children && tree.children.length > 0) {
      tree.children = tree.children.map(child => this.simplify(child));
    }

    // If this node is clickable, aggregate its text content
    if (this.isClickable(tree)) {
      const aggregatedText = this.aggregateText(tree);

      if (aggregatedText) {
        // Store aggregated text in nodeValue (will become text field in SerializedNode)
        return {
          ...tree,
          nodeValue: aggregatedText,
          children: [] // Remove children after aggregation
        };
      }
    }

    return tree;
  }

  /**
   * Check if node is a clickable element
   * @param node - VirtualNode to check
   * @returns True if node is clickable (button, link, tab, menuitem)
   */
  private isClickable(node: VirtualNode): boolean {
    // Check interaction type from heuristics
    if (node.interactionType === 'click' || node.interactionType === 'link') {
      return true;
    }

    // Check accessibility role
    const clickableRoles = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'];
    const role = node.accessibility?.role;
    if (role && clickableRoles.includes(role)) {
      return true;
    }

    // Check HTML tag name
    const tagName = (node.localName || node.nodeName || '').toLowerCase();
    if (tagName === 'a' || tagName === 'button') {
      return true;
    }

    return false;
  }

  /**
   * Aggregate all text content from descendants
   * @param node - VirtualNode to aggregate text from
   * @returns Aggregated text string (or empty string if no visible text)
   */
  private aggregateText(node: VirtualNode): string {
    const texts: string[] = [];

    const traverse = (n: VirtualNode) => {
      // Skip invisible elements
      if (this.isInvisible(n)) {
        return;
      }

      // Extract text alternatives from images and SVG elements
      const tagName = (n.localName || n.nodeName || '').toLowerCase();
      if (tagName === 'img' || tagName === 'svg') {
        // Priority order: aria-label > alt > accessibility.name > title
        const textAlt = this.getTextAlternative(n);
        if (textAlt) {
          texts.push(textAlt);
          return; // Don't traverse children of images/SVG with text alternative
        }
      }

      // Extract text from text nodes
      if (n.nodeType === NODE_TYPE_TEXT && n.nodeValue) {
        const trimmedText = n.nodeValue.trim();
        if (trimmedText) {
          texts.push(trimmedText);
        }
      }

      // Recurse to children
      if (n.children) {
        n.children.forEach(traverse);
      }
    };

    traverse(node);
    return texts.join(' ').trim();
  }

  /**
   * Get text alternative for image/SVG elements
   * @param node - VirtualNode (img or svg element)
   * @returns Text alternative string (aria-label, alt, a11y name, or title)
   */
  private getTextAlternative(node: VirtualNode): string | null {
    // Priority 1: aria-label attribute
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        const attrName = node.attributes[i];
        const attrValue = node.attributes[i + 1];

        if (attrName === 'aria-label' && attrValue) {
          return attrValue.trim();
        }
      }

      // Priority 2: alt attribute (for img elements)
      for (let i = 0; i < node.attributes.length; i += 2) {
        const attrName = node.attributes[i];
        const attrValue = node.attributes[i + 1];

        if (attrName === 'alt' && attrValue) {
          return attrValue.trim();
        }
      }

      // Priority 3: title attribute
      for (let i = 0; i < node.attributes.length; i += 2) {
        const attrName = node.attributes[i];
        const attrValue = node.attributes[i + 1];

        if (attrName === 'title' && attrValue) {
          return attrValue.trim();
        }
      }
    }

    // Priority 4: Accessibility name from a11y tree
    if (node.accessibility?.name) {
      return node.accessibility.name.trim();
    }

    return null;
  }

  /**
   * Check if element is invisible (display:none, visibility:hidden)
   * @param node - VirtualNode to check
   * @returns True if element is invisible
   */
  private isInvisible(node: VirtualNode): boolean {
    // Check computed style if available
    if (node.computedStyle) {
      const display = node.computedStyle.display;
      const visibility = node.computedStyle.visibility;

      if (display === 'none' || visibility === 'hidden') {
        return true;
      }
    }

    // Check inline style attribute
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        if (node.attributes[i] === 'style') {
          const styleValue = node.attributes[i + 1];
          if (styleValue.includes('display:none') ||
              styleValue.includes('display: none') ||
              styleValue.includes('visibility:hidden') ||
              styleValue.includes('visibility: hidden')) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
