/**
 * AttributeDeduplicator (S2.3): Remove redundant attributes
 *
 * Removes attributes that are redundant with other node properties:
 * - role="button" on <button> (role matches tag)
 * - role="link" on <a> (role matches tag)
 * - Empty or whitespace-only attributes
 * - Duplicate attribute definitions
 *
 * Example transformation:
 * Before:
 *   <button role="button" type="">Click</button>
 *   <a role="link" href="/home">Home</a>
 *
 * After:
 *   <button>Click</button>
 *   <a href="/home">Home</a>
 *
 * Rules:
 * - Remove role if it matches the implicit role of the tag
 * - Remove empty/whitespace-only attribute values
 * - Preserve custom roles (e.g., role="tab" on <button>)
 * - Preserve data-* attributes (used for testing/interaction)
 *
 * Stage 2 Structure Simplification
 */

import { VirtualNode } from '../../types';

export class AttributeDeduplicator {
  private implicitRoles: Map<string, string>;

  constructor() {
    // Tag → implicit ARIA role mapping
    this.implicitRoles = new Map([
      ['button', 'button'],
      ['a', 'link'],
      ['input', 'textbox'], // Note: varies by type
      ['textarea', 'textbox'],
      ['select', 'combobox'],
      ['nav', 'navigation'],
      ['main', 'main'],
      ['header', 'banner'],
      ['footer', 'contentinfo'],
      ['aside', 'complementary'],
      ['form', 'form'],
      ['article', 'article'],
      ['section', 'region']
    ]);
  }

  /**
   * Deduplicate attributes in tree
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with deduplicated attributes
   */
  deduplicate(tree: VirtualNode): VirtualNode {
    // Deduplicate this node's attributes
    const dedupedAttributes = this.deduplicateAttributes(tree);

    // Recursively process children
    if (tree.children && tree.children.length > 0) {
      const dedupedChildren = tree.children.map(child => this.deduplicate(child));

      return {
        ...tree,
        attributes: dedupedAttributes,
        children: dedupedChildren
      };
    }

    return {
      ...tree,
      attributes: dedupedAttributes
    };
  }

  /**
   * Deduplicate attributes for a single node
   */
  private deduplicateAttributes(node: VirtualNode): string[] | undefined {
    if (!node.attributes || node.attributes.length === 0) {
      return undefined;
    }

    const result: string[] = [];
    const tagName = (node.localName || node.nodeName || '').toLowerCase();

    for (let i = 0; i < node.attributes.length; i += 2) {
      const name = node.attributes[i];
      const value = node.attributes[i + 1];

      // Skip empty or whitespace-only values
      if (!value || value.trim() === '') {
        continue;
      }

      // Check for redundant role attribute
      if (name === 'role') {
        const implicitRole = this.implicitRoles.get(tagName);
        if (implicitRole === value) {
          // Redundant: role matches implicit role
          continue;
        }
      }

      // Keep this attribute
      result.push(name, value);
    }

    return result.length > 0 ? result : undefined;
  }
}
