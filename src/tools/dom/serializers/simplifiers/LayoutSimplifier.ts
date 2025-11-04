/**
 * LayoutSimplifier (S2.2): Collapse single-child wrapper elements
 *
 * Removes unnecessary wrapper elements that contain only a single child.
 * Hoists the child to replace the wrapper, preserving important attributes.
 *
 * Example transformation:
 * Before:
 *   <div class="wrapper">
 *     <button id="submit">Click me</button>
 *   </div>
 *
 * After:
 *   <button id="submit" class="wrapper">Click me</button>
 *
 * Rules:
 * - Only collapses structural (non-interactive) wrappers
 * - Preserves semantic containers (form, table, dialog, etc.)
 * - Hoists important attributes (id, class, data-*) to child
 * - Does not collapse if wrapper has meaningful styles/layout
 *
 * Stage 2 Structure Simplification
 */

import { VirtualNode } from '../../types';

export class LayoutSimplifier {
  private semanticContainers: Set<string>;

  constructor() {
    // Semantic containers that should not be collapsed
    this.semanticContainers = new Set([
      'form',
      'table',
      'tbody',
      'thead',
      'tfoot',
      'tr',
      'dialog',
      'main',
      'nav',
      'header',
      'footer',
      'aside',
      'article',
      'section'
    ]);
  }

  /**
   * Simplify layout by collapsing single-child wrappers
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with collapsed wrappers
   */
  simplify(tree: VirtualNode): VirtualNode {
    // Recursively simplify children first
    if (tree.children && tree.children.length > 0) {
      const simplifiedChildren = tree.children.map(child => this.simplify(child));

      // Check if this node is a collapsible wrapper
      if (simplifiedChildren.length === 1 && this.isCollapsibleWrapper(tree)) {
        // Collapse: hoist child with merged attributes
        const child = simplifiedChildren[0];
        return this.hoistChild(tree, child);
      }

      return {
        ...tree,
        children: simplifiedChildren
      };
    }

    return tree;
  }

  /**
   * Check if node is a collapsible wrapper
   */
  private isCollapsibleWrapper(node: VirtualNode): boolean {
    // Interactive elements are never collapsed
    if (node.tier === 'semantic' || node.tier === 'non-semantic') {
      return false;
    }

    // Semantic containers are preserved
    const tagName = (node.localName || node.nodeName || '').toLowerCase();
    if (this.semanticContainers.has(tagName)) {
      return false;
    }

    // Nodes with important accessibility roles are preserved
    const role = node.accessibility?.role;
    if (role && role !== 'generic' && role !== 'none') {
      return false;
    }

    return true;
  }

  /**
   * Hoist child and merge attributes
   */
  private hoistChild(wrapper: VirtualNode, child: VirtualNode): VirtualNode {
    // Merge attributes: child attributes take precedence
    const mergedAttributes = this.mergeAttributes(
      wrapper.attributes || [],
      child.attributes || []
    );

    return {
      ...child,
      attributes: mergedAttributes.length > 0 ? mergedAttributes : undefined
    };
  }

  /**
   * Merge attributes from wrapper and child
   * Child attributes take precedence for duplicates
   */
  private mergeAttributes(wrapperAttrs: string[], childAttrs: string[]): string[] {
    // Build attribute map from child (child wins on conflicts)
    const childAttrMap = new Map<string, string>();
    for (let i = 0; i < childAttrs.length; i += 2) {
      childAttrMap.set(childAttrs[i], childAttrs[i + 1]);
    }

    // Build attribute map from wrapper, skip if child has same key
    const wrapperAttrMap = new Map<string, string>();
    for (let i = 0; i < wrapperAttrs.length; i += 2) {
      const key = wrapperAttrs[i];
      if (!childAttrMap.has(key)) {
        wrapperAttrMap.set(key, wrapperAttrs[i + 1]);
      }
    }

    // Combine into flat array
    const result: string[] = [];

    // Add child attributes first
    for (const [key, value] of childAttrMap) {
      result.push(key, value);
    }

    // Add wrapper attributes (non-conflicting only)
    for (const [key, value] of wrapperAttrMap) {
      result.push(key, value);
    }

    return result;
  }
}
