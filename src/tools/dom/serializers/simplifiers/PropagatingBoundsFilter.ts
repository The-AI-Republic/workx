/**
 * PropagatingBoundsFilter (S2.4): Remove nested clickables with propagating bounds
 *
 * Removes nested interactive elements that are >99% contained within a parent
 * interactive element, as clicks on the child will propagate to the parent anyway.
 *
 * Example transformation:
 * Before:
 *   <button id="outer">
 *     <span id="icon" onclick="...">🔥</span>
 *     <span id="text">Click me</span>
 *   </button>
 *
 * After:
 *   <button id="outer">
 *     <span id="text">Click me</span>
 *   </button>
 *
 * Exception rules (preserve nested clickable even if >99% contained):
 * 1. Form inputs within buttons (e.g., checkbox in button)
 * 2. Elements with explicit onclick handlers
 * 3. Elements with unique aria-labels
 * 4. Parent is not a propagating container
 *
 * Stage 2 Structure Simplification
 */

import { VirtualNode } from '../../types';
import { ClickableCache } from '../utils/ClickableCache';

export class PropagatingBoundsFilter {
  private clickableCache: ClickableCache;
  private containmentThreshold: number;

  constructor(containmentThreshold: number = 0.99) {
    this.clickableCache = new ClickableCache();
    this.containmentThreshold = containmentThreshold;
  }

  /**
   * Filter nested clickables with propagating bounds
   * @param tree - VirtualNode tree to filter
   * @returns Filtered tree with redundant nested clickables removed
   */
  filter(tree: VirtualNode): VirtualNode {
    // Check if bounding box data is available
    if (!this.hasBoundingBoxData(tree)) {
      return tree;
    }

    // Filter tree with parent context
    return this.filterWithContext(tree, null);
  }

  /**
   * Filter with parent context for containment checking
   */
  private filterWithContext(
    node: VirtualNode,
    parent: VirtualNode | null
  ): VirtualNode {
    // Check if this node should be filtered (nested clickable)
    if (parent && this.shouldFilterNestedClickable(node, parent)) {
      node.excludedByParent = true;
      // Still process children in case they escape containment
    }

    // Recursively filter children
    if (node.children && node.children.length > 0) {
      const filteredChildren = node.children
        .map(child => this.filterWithContext(child, node))
        .filter(child => !child.excludedByParent);

      return {
        ...node,
        children: filteredChildren.length > 0 ? filteredChildren : undefined
      };
    }

    return node;
  }

  /**
   * Check if nested clickable should be filtered
   */
  private shouldFilterNestedClickable(
    child: VirtualNode,
    parent: VirtualNode
  ): boolean {
    // Only filter if both parent and child are clickable
    if (!this.clickableCache.isClickable(parent)) {
      return false;
    }

    if (!this.clickableCache.isClickable(child)) {
      return false;
    }

    // Only filter if parent is a propagating container
    if (!this.isPropagatingContainer(parent)) {
      return false;
    }

    // Check exception rules
    if (this.hasExceptionRule(child, parent)) {
      return false;
    }

    // Check containment (>99% contained)
    if (!this.isContained(child, parent, this.containmentThreshold)) {
      return false;
    }

    return true;
  }

  /**
   * Check if parent is a propagating container (clicks propagate)
   */
  private isPropagatingContainer(node: VirtualNode): boolean {
    const tag = (node.localName || node.nodeName || '').toLowerCase();

    // Propagating containers: button, a, link, etc.
    const propagatingTags = new Set(['button', 'a', 'summary', 'label']);
    if (propagatingTags.has(tag)) {
      return true;
    }

    // Elements with click handlers
    if (node.heuristics?.hasOnClick) {
      return true;
    }

    return false;
  }

  /**
   * Check exception rules
   */
  private hasExceptionRule(child: VirtualNode, parent: VirtualNode): boolean {
    // Exception 1: Form inputs are always preserved
    const childTag = (child.localName || child.nodeName || '').toLowerCase();
    const formInputTags = new Set(['input', 'select', 'textarea', 'button']);
    if (formInputTags.has(childTag)) {
      return true;
    }

    // Exception 2: Explicit onclick handlers
    if (child.heuristics?.hasOnClick) {
      return true;
    }

    // Exception 3: Unique aria-labels (different from parent)
    const childLabel = child.accessibility?.name;
    const parentLabel = parent.accessibility?.name;
    if (childLabel && childLabel !== parentLabel) {
      return true;
    }

    // Exception 4: Interactive role different from parent
    const childRole = child.accessibility?.role;
    const parentRole = parent.accessibility?.role;
    if (childRole && childRole !== parentRole && childRole !== 'generic') {
      return true;
    }

    return false;
  }

  /**
   * Check if child is contained within parent bounding box
   */
  private isContained(
    child: VirtualNode,
    parent: VirtualNode,
    threshold: number
  ): boolean {
    if (!child.boundingBox || !parent.boundingBox) {
      return false;
    }

    const childBox = child.boundingBox;
    const parentBox = parent.boundingBox;

    // Calculate intersection area
    const intersectionX1 = Math.max(childBox.x, parentBox.x);
    const intersectionY1 = Math.max(childBox.y, parentBox.y);
    const intersectionX2 = Math.min(
      childBox.x + childBox.width,
      parentBox.x + parentBox.width
    );
    const intersectionY2 = Math.min(
      childBox.y + childBox.height,
      parentBox.y + parentBox.height
    );

    const intersectionWidth = Math.max(0, intersectionX2 - intersectionX1);
    const intersectionHeight = Math.max(0, intersectionY2 - intersectionY1);
    const intersectionArea = intersectionWidth * intersectionHeight;

    // Calculate child area
    const childArea = childBox.width * childBox.height;

    if (childArea === 0) {
      return false;
    }

    // Calculate containment ratio
    const containmentRatio = intersectionArea / childArea;

    return containmentRatio >= threshold;
  }

  /**
   * Check if tree has bounding box data
   */
  private hasBoundingBoxData(tree: VirtualNode): boolean {
    let hasBoundingBox = false;
    const check = (node: VirtualNode) => {
      if (node.boundingBox) {
        hasBoundingBox = true;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          check(child);
          if (hasBoundingBox) return;
        }
      }
    };
    check(tree);
    return hasBoundingBox;
  }
}
