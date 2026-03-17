/**
 * SemanticContainerFilter (F4): Require interactive descendants for non-landmark containers
 *
 * Removes structural container elements that have no interactive descendants,
 * unless the container itself is a landmark or semantic region.
 *
 * Rationale: Empty containers like <div>, <span>, <section> with no interactive
 * content add tokens without providing value. Landmarks (main, nav, banner, etc.)
 * are preserved for structural context even if empty.
 *
 * Landmarks preserved regardless of content:
 * - banner, main, navigation, complementary, contentinfo, search, region, form
 *
 * Non-landmarks require ≥1 interactive descendant to be preserved.
 *
 * Stage 1 Signal Filtering
 */

import type { VirtualNode } from '../../types';

export class SemanticContainerFilter {
  private landmarkRoles: Set<string>;

  constructor() {
    // ARIA landmark roles that should be preserved
    this.landmarkRoles = new Set([
      'banner',       // Site header
      'main',         // Main content
      'navigation',   // Navigation section
      'complementary',// Sidebar/related content
      'contentinfo',  // Footer
      'search',       // Search functionality
      'region',       // Significant page section
      'form'          // Form container
    ]);
  }

  /**
   * Filter tree to remove empty non-landmark containers
   * @param tree - VirtualNode tree to filter
   * @returns Filtered tree with empty containers removed
   */
  filter(tree: VirtualNode): VirtualNode | null {
    // Recursively filter children first
    let filteredChildren: VirtualNode[] | undefined;
    if (tree.children && tree.children.length > 0) {
      const filtered = tree.children
        .map(child => this.filter(child))
        .filter((child): child is VirtualNode => child !== null);
      filteredChildren = filtered.length > 0 ? filtered : undefined;
    }

    // Recursively filter shadow roots
    let filteredShadowRoots: VirtualNode[] | undefined;
    if (tree.shadowRoots && tree.shadowRoots.length > 0) {
      const filtered = tree.shadowRoots
        .map(sr => this.filter(sr))
        .filter((sr): sr is VirtualNode => sr !== null);
      filteredShadowRoots = filtered.length > 0 ? filtered : undefined;
    }

    // Recursively filter content document
    let filteredContentDocument: VirtualNode | undefined;
    if (tree.contentDocument) {
      filteredContentDocument = this.filter(tree.contentDocument) || undefined;
    }

    // Check if this node should be filtered out
    if (this.shouldFilterContainer(tree, filteredChildren, filteredShadowRoots, filteredContentDocument)) {
      return null;
    }

    // Return node with filtered content
    const result = { ...tree };
    if (filteredChildren !== undefined) {
      result.children = filteredChildren;
    }
    if (filteredShadowRoots !== undefined) {
      result.shadowRoots = filteredShadowRoots;
    }
    if (filteredContentDocument !== undefined) {
      result.contentDocument = filteredContentDocument;
    }

    return result;
  }

  /**
   * Check if container should be filtered
   * @param node - Container node to check
   * @param filteredChildren - Children after filtering
   * @param filteredShadowRoots - Shadow roots after filtering
   * @param filteredContentDocument - Content document after filtering
   * @returns true if should be filtered, false otherwise
   */
  private shouldFilterContainer(
    node: VirtualNode,
    filteredChildren: VirtualNode[] | undefined,
    filteredShadowRoots?: VirtualNode[] | undefined,
    filteredContentDocument?: VirtualNode | undefined
  ): boolean {
    // Interactive elements are never filtered
    if (this.isInteractive(node)) {
      return false;
    }

    // Landmarks are preserved even if empty
    if (this.isLandmark(node)) {
      return false;
    }

    // Nodes with shadow roots or content documents are preserved (they contain nested content)
    if (filteredShadowRoots && filteredShadowRoots.length > 0) {
      return false;
    }
    if (filteredContentDocument) {
      return false;
    }

    // Structural containers: require ≥1 interactive descendant
    if (node.tier === 'structural') {
      // Check if has any interactive descendants in children
      const hasInteractiveInChildren = this.hasInteractiveDescendant(filteredChildren);

      if (!hasInteractiveInChildren) {
        return true; // Filter out empty structural container
      }
    }

    return false;
  }

  /**
   * Check if node is interactive
   */
  private isInteractive(node: VirtualNode): boolean {
    return node.tier === 'semantic' || node.tier === 'non-semantic';
  }

  /**
   * Check if node is a landmark
   */
  private isLandmark(node: VirtualNode): boolean {
    const role = node.accessibility?.role;
    if (role && this.landmarkRoles.has(role)) {
      return true;
    }

    // Check for HTML5 semantic elements
    const tagName = (node.localName || node.nodeName || '').toLowerCase();
    const semanticTags = new Set(['main', 'nav', 'header', 'footer', 'aside', 'form']);
    if (semanticTags.has(tagName)) {
      return true;
    }

    return false;
  }

  /**
   * Check if children contain any interactive descendants
   */
  private hasInteractiveDescendant(children: VirtualNode[] | undefined): boolean {
    if (!children || children.length === 0) {
      return false;
    }

    for (const child of children) {
      // Direct child is interactive
      if (this.isInteractive(child)) {
        return true;
      }

      // Recursive check for interactive descendants in children
      if (this.hasInteractiveDescendant(child.children)) {
        return true;
      }

      // Recursive check in shadow roots
      if (child.shadowRoots) {
        for (const shadowRoot of child.shadowRoots) {
          if (this.isInteractive(shadowRoot) || this.hasInteractiveDescendant(shadowRoot.children)) {
            return true;
          }
        }
      }

      // Recursive check in content document
      if (child.contentDocument) {
        if (this.isInteractive(child.contentDocument) || this.hasInteractiveDescendant(child.contentDocument.children)) {
          return true;
        }
      }
    }

    return false;
  }
}
