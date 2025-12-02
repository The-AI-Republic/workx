/**
 * LayoutSimplifier (S2.2): Collapse wrappers, flatten containers, and remove empty divs
 *
 * Removes unnecessary wrapper elements and flattens meaningless container hierarchies.
 * Hoists children to replace wrappers, preserving important attributes.
 * Enhanced to recursively flatten chains of meaningless nested divs and remove empty containers.
 *
 * Example transformation (single-child wrapper):
 * Before:
 *   <div class="wrapper">
 *     <button id="submit">Click me</button>
 *   </div>
 *
 * After:
 *   <button id="submit" class="wrapper">Click me</button>
 *
 * Flattening meaningless containers (multi-child):
 * Before:
 *   <div id="parent">
 *     <div>  <!-- meaningless -->
 *       <button>A</button>
 *       <button>B</button>
 *     </div>
 *   </div>
 *
 * After:
 *   <div id="parent">
 *     <button>A</button>
 *     <button>B</button>
 *   </div>
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
 *
 * Rules:
 * - Collapses structural (non-interactive) single-child wrappers
 * - Flattens meaningless containers regardless of child count
 * - Preserves semantic containers (form, table, dialog, navigation, main, region, article, section)
 * - Preserves containers with meaningful attributes (data-testid, aria-label, id)
 * - Hoists important attributes (id, class, data-*) to child when collapsing
 * - Removes empty div leaves (no children, no content, no meaningful role)
 * - Processes recursively from bottom-up to handle deeply nested structures
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
   * Simplify layout by collapsing wrappers, flattening containers, and removing empty divs
   * Enhanced to flatten meaningless containers (regardless of child count) and remove empty leaves
   * @param tree - VirtualNode tree to simplify
   * @returns Simplified tree with collapsed wrappers, flattened containers, and removed empty divs
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

      // Step 3: Flatten meaningless containers (unwrap and promote their children)
      // This handles multi-child meaningless containers that should be unwrapped
      const flattenedChildren = filteredChildren.flatMap(child => {
        if (this.isMeaninglessContainer(child) && child.children && child.children.length > 0) {
          // Flatten: replace this meaningless container with its children
          return child.children;
        }
        return [child];
      });

      // Step 4: Check if this node is a collapsible wrapper (existing logic)
      if (flattenedChildren.length === 1 && this.isCollapsibleWrapper(tree)) {
        // Collapse: hoist child with merged attributes
        const child = flattenedChildren[0];
        return this.hoistChild(tree, child);
      }

      // Step 5: Apply recursive container hoisting (new logic)
      const hoistedChildren = flattenedChildren.map(child => this.hoistChildren(child));

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

    // Scrollable containers are preserved - they enable scroll actions
    if (this.isScrollable(node)) {
      return false;
    }

    // Semantic containers are preserved
    const tagName = (node.localName || node.nodeName || '').toLowerCase();
    if (this.semanticContainers.has(tagName)) {
      return false;
    }

    // Document structural elements are never collapsed
    if (tagName === '#document' || tagName === 'html' || tagName === 'head' || tagName === 'body') {
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
   * Check if node is scrollable (vertically or horizontally)
   * Uses the pre-computed scrollable property from DomService
   */
  private isScrollable(node: VirtualNode): boolean {
    return node.scrollable !== undefined;
  }

  /**
   * Check if node is a meaningless container that can be hoisted
   * Meaningless containers are divs with no semantic value (generic role or no role)
   * or divs with zero bounding box (layout wrappers for CSS positioning)
   */
  private isMeaninglessContainer(node: VirtualNode): boolean {
    const tagName = (node.localName || node.nodeName || '').toLowerCase();

    // Must be a div
    if (tagName !== 'div') {
      return false;
    }

    // Zero bounding box containers are meaningless (CSS layout wrappers)
    // These are wrappers used for absolute/fixed positioning with no visual presence
    if (node.boundingBox) {
      const { width, height } = node.boundingBox;
      if (width === 0 || height === 0) {
        return true;
      }
    }

    // Scrollable containers are meaningful - they enable scroll actions
    if (this.isScrollable(node)) {
      return false;
    }

    // Interactive elements are never meaningless
    if (node.tier === 'semantic') {
      return false;
    }

    // Check accessibility role
    const role = node.accessibility?.role;

    // Only generic or no role qualifies as meaningless
    if (role && role !== 'generic') {
      return false;
    }

    // Check for meaningful accessibility states on divs
    // Note: checked/required on a div are meaningless, but expanded indicates collapsible container
    if (node.accessibility) {
      // expanded is meaningful - indicates collapsible/expandable section
      if (node.accessibility.expanded !== undefined) {
        return false;
      }
      // name/description indicate semantic meaning
      if (node.accessibility.name || node.accessibility.description) {
        return false;
      }
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
        'data-testid'
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
