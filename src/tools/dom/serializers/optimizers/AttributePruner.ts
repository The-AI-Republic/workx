/**
 * AttributePruner (P3.2): Keep only semantic attributes
 *
 * Removes non-semantic attributes that don't contribute to element identification
 * or interaction, keeping only:
 * - Semantic attributes: id, name, href, value, placeholder, type
 * - ARIA attributes: aria-label, aria-describedby, aria-expanded, etc.
 * - Data attributes: data-testid, data-* (useful for testing/identification)
 * - Role attribute
 *
 * Removes:
 * - Style attributes (style, class - visual only)
 * - Event handlers (onclick, onchange - redundant with tier detection)
 * - Layout attributes (width, height - redundant with boundingBox)
 *
 * Stage 3 Payload Optimization
 */

import { VirtualNode } from '../../types';

export class AttributePruner {
  private semanticAttributes: Set<string>;
  private ariaPrefix: string;
  private dataPrefix: string;

  constructor() {
    // Semantic attributes to preserve
    this.semanticAttributes = new Set([
      'id',
      'name',
      'href',
      'src',
      'alt',
      'value',
      'placeholder',
      'type',
      'role',
      'title',
      'for',
      'action',
      'method',
      'disabled',
      'readonly',
      'required',
      'checked',
      'selected',
      'multiple',
      'min',
      'max',
      'step',
      'pattern',
      'maxlength',
      'autocomplete'
    ]);

    this.ariaPrefix = 'aria-';
    this.dataPrefix = 'data-';
  }

  /**
   * Prune non-semantic attributes in tree
   * @param tree - VirtualNode tree to optimize
   * @returns Optimized tree with pruned attributes
   */
  prune(tree: VirtualNode): VirtualNode {
    // Prune this node's attributes
    const prunedAttributes = this.pruneAttributes(tree.attributes);

    // Recursively process children
    if (tree.children && tree.children.length > 0) {
      const prunedChildren = tree.children.map(child => this.prune(child));

      return {
        ...tree,
        attributes: prunedAttributes,
        children: prunedChildren
      };
    }

    return {
      ...tree,
      attributes: prunedAttributes
    };
  }

  /**
   * Prune attributes for a single node
   */
  private pruneAttributes(attributes: string[] | undefined): string[] | undefined {
    if (!attributes || attributes.length === 0) {
      return undefined;
    }

    const result: string[] = [];

    for (let i = 0; i < attributes.length; i += 2) {
      const name = attributes[i];
      const value = attributes[i + 1];

      // Keep semantic attributes
      if (this.isSemanticAttribute(name)) {
        result.push(name, value);
      }
    }

    return result.length > 0 ? result : undefined;
  }

  /**
   * Check if attribute is semantic
   */
  private isSemanticAttribute(name: string): boolean {
    // Check semantic whitelist
    if (this.semanticAttributes.has(name)) {
      return true;
    }

    // Check ARIA attributes
    if (name.startsWith(this.ariaPrefix)) {
      return true;
    }

    // Check data attributes
    if (name.startsWith(this.dataPrefix)) {
      return true;
    }

    return false;
  }
}
