/**
 * LayoutSimplifier (S2.2): Collapse single-child wrapper elements & hoist nested containers
 *
 * Removes unnecessary wrapper elements that contain only a single child.
 * Hoists the child to replace the wrapper, preserving important attributes.
 * Enhanced to recursively hoist chains of meaningless nested divs and remove empty containers.
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
 * Enhanced hoisting (chains of meaningless divs):
 * Before:
 *   <div><div><div><div><button>Click</button></div></div></div></div>
 * After:
 *   <div><button>Click</button></div>
 *
 * Empty div leaf removal:
 * Before:
 *   <div><button>Click</button><div></div></div>
 * After:
 *   <div><button>Click</button></div>
 *   (Empty div leaf removed, button preserved)
 *
 * Rules:
 * - Only collapses structural (non-interactive) wrappers
 * - Preserves semantic containers (form, table, dialog, navigation, main, region, article, section)
 * - Hoists chains of meaningless containers (div with role="generic" or no role)
 * - Hoists important attributes (id, class, data-*) to child
 * - Removes empty div leaves (no children, no content, no meaningful role)
 * - Does not collapse if wrapper has meaningful styles/layout
 * - Container hoisting handles nested divs without aggressive removal to avoid cascade effects
 *
 * Stage 2 Structure Simplification
 */

import type { VirtualNode } from '../../types';

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
   * Simplify layout by collapsing single-child wrappers and hoisting nested containers
   * Enhanced to remove empty div leaves and containers with only container children
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with collapsed wrappers and hoisted meaningless containers
   */
  simplify(tree: VirtualNode): VirtualNode {
    // Step 1: Recursively simplify children first
    if (tree.children && tree.children.length > 0) {
      const simplifiedChildren = tree.children.map(child => this.simplify(child));

      // Step 2: Filter out empty div leaves only
      // Note: We don't filter "container-only" divs here to avoid cascade removal
      // The hoisting logic below already handles meaningless nested containers
      const filteredChildren = simplifiedChildren.filter(child => {
        // Remove empty div leaves
        if (this.isEmptyDivLeaf(child)) {
          return false;
        }
        return true;
      });

      // Step 3: Check if this node is a collapsible wrapper (existing logic)
      if (filteredChildren.length === 1 && this.isCollapsibleWrapper(tree)) {
        // Collapse: hoist child with merged attributes
        const child = filteredChildren[0];
        return this.hoistChild(tree, child);
      }

      // Step 4: Apply recursive container hoisting (new logic)
      const hoistedChildren = filteredChildren.map(child => this.hoistChildren(child));

      return {
        ...tree,
        children: hoistedChildren
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
   * Check if node is a meaningless container that can be hoisted
   * Meaningless containers are divs with no semantic value (generic role or no role)
   */
  private isMeaninglessContainer(node: VirtualNode): boolean {
    const tagName = (node.localName || node.nodeName || '').toLowerCase();

    // Must be a div
    if (tagName !== 'div') {
      return false;
    }

    // Interactive elements are never meaningless
    if (node.tier === 'semantic' || node.tier === 'non-semantic') {
      return false;
    }

    // Check accessibility role
    const role = node.accessibility?.role;

    // Only generic or no role qualifies as meaningless
    if (role && role !== 'generic') {
      return false;
    }

    // Semantic containers are never meaningless
    if (this.semanticContainers.has(tagName)) {
      return false;
    }

    // Check for semantic attributes that make container meaningful
    if (node.attributes) {
      const attrMap = new Map<string, string>();
      for (let i = 0; i < node.attributes.length; i += 2) {
        attrMap.set(node.attributes[i], node.attributes[i + 1]);
      }

      // These attributes indicate semantic meaning
      const semanticAttrs = [
        'aria-label',
        'aria-describedby',
        'aria-labelledby',
        'data-testid',
        'id' // id might be referenced by other elements
      ];

      for (const attr of semanticAttrs) {
        if (attrMap.has(attr)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if node is a semantic container that should be preserved
   * Semantic containers include form, table, navigation, article, section, etc.
   */
  private isSemanticContainer(node: VirtualNode): boolean {
    const tagName = (node.localName || node.nodeName || '').toLowerCase();

    // Check if tag is in semantic containers set
    if (this.semanticContainers.has(tagName)) {
      return true;
    }

    // Check for semantic ARIA roles
    const role = node.accessibility?.role;
    if (role) {
      const semanticRoles = new Set([
        'form',
        'navigation',
        'main',
        'region',
        'article',
        'section',
        'complementary',
        'contentinfo',
        'banner',
        'search'
      ]);

      if (semanticRoles.has(role)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if node is an empty div leaf that should be removed
   * Empty div leaves are divs with:
   * - No children (leaf node)
   * - No content value (nodeValue)
   * - Not in semantic or non-semantic tier
   * - No meaningful role (only generic or no role)
   */
  private isEmptyDivLeaf(node: VirtualNode): boolean {
    const tagName = (node.localName || node.nodeName || '').toLowerCase();

    // Must be a div
    if (tagName !== 'div') {
      return false;
    }

    // Must have no children (leaf node)
    if (node.children && node.children.length > 0) {
      return false;
    }

    // Must have no content value
    if (node.nodeValue && node.nodeValue.trim()) {
      return false;
    }

    // Must not be in semantic or non-semantic tier
    if (node.tier === 'semantic' || node.tier === 'non-semantic') {
      return false;
    }

    // Check accessibility role - only generic or no role
    const role = node.accessibility?.role;
    if (role && role !== 'generic') {
      return false;
    }

    // This is an empty div leaf - should be removed
    return true;
  }

  /**
   * Check if node is a container with only container children
   * These are divs whose children are all other containers (no meaningful nodes)
   * Meaningful nodes are those in semantic or non-semantic tier
   */
  private hasOnlyContainerChildren(node: VirtualNode): boolean {
    const tagName = (node.localName || node.nodeName || '').toLowerCase();

    // Must be a div
    if (tagName !== 'div') {
      return false;
    }

    // Must have children
    if (!node.children || node.children.length === 0) {
      return false;
    }

    // Check if all children are containers (structural tier)
    const allChildrenAreContainers = node.children.every(child => {
      // If child is semantic or non-semantic, it's meaningful
      if (child.tier === 'semantic' || child.tier === 'non-semantic') {
        return false;
      }

      // If child has meaningful role, it's not just a container
      const role = child.accessibility?.role;
      if (role && role !== 'generic') {
        return false;
      }

      // If child has content, it's meaningful
      if (child.nodeValue && child.nodeValue.trim()) {
        return false;
      }

      // This child is just a container
      return true;
    });

    // If all children are containers, this node should be removed
    return allChildrenAreContainers;
  }

  /**
   * Recursively hoist children through chains of meaningless containers
   * Returns the hoisted child (or original if no hoisting needed)
   */
  private hoistChildren(node: VirtualNode): VirtualNode {
    // Base case: if node has no children, return as-is
    if (!node.children || node.children.length === 0) {
      return node;
    }

    // If this is a meaningless container with a single child
    if (this.isMeaninglessContainer(node) && node.children.length === 1) {
      const child = node.children[0];

      // Recursively hoist the child first
      const hoistedChild = this.hoistChildren(child);

      // If the child is also meaningless, continue hoisting
      if (this.isMeaninglessContainer(hoistedChild)) {
        return this.hoistChildren(hoistedChild);
      }

      // If child is semantic or has meaning, hoist it and stop
      return hoistedChild;
    }

    // Not a meaningless single-child container, recursively process children
    return {
      ...node,
      children: node.children.map(child => this.hoistChildren(child))
    };
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
