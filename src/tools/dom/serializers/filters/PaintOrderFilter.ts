/**
 * Currently the code in this file is experimental and may produce incorrect results.
 * Disabled by default until further testing and improvements are made.
 * 
 * PaintOrderFilter (F5): Remove fully obscured elements using paint order
 *
 * Removes elements that are 100% covered by other elements with higher paint order.
 * Uses RectUnion algorithm for geometric occlusion detection.
 *
 * Algorithm:
 * 1. Group elements by paint order
 * 2. Process in reverse order (highest paint order first = topmost)
 * 3. Build union of visible rectangles
 * 4. For each element, check if fully contained within union
 * 5. If 100% covered → mark as obscured
 *
 * Use cases:
 * - Modal dialogs obscuring page content
 * - Loading spinners covering underlying elements
 * - Overlays and popups
 *
 * Stage 1 Signal Filtering
 */

import type { VirtualNode } from '../../types';
import { RectUnion } from '../utils/RectUnion';

export class PaintOrderFilter {
  /**
   * Filter tree to remove fully obscured elements
   * @param tree - VirtualNode tree to filter
   * @returns Filtered tree with obscured elements removed
   */
  filter(tree: VirtualNode): VirtualNode | null {
    // Check if paint order data is available
    if (!this.hasPaintOrderData(tree)) {
      console.log('[PaintOrderFilter] No paint order data available - skipping filter');
      return tree;
    }

    // Collect all nodes with bounding boxes in a flat list
    const nodes: VirtualNode[] = [];
    this.collectNodes(tree, nodes);

    // Group nodes by paint order
    const nodesByPaintOrder = this.groupByPaintOrder(nodes);

    // Build occlusion map using RectUnion
    const occludedNodes = this.detectOcclusion(nodesByPaintOrder);

    // Filter tree based on occlusion map
    return this.filterByOcclusion(tree, occludedNodes);
  }

  /**
   * Check if tree has paint order data
   */
  private hasPaintOrderData(tree: VirtualNode): boolean {
    // Check if root or any descendants have paintOrder
    let hasPaintOrder = false;
    const check = (node: VirtualNode) => {
      if (node.paintOrder !== undefined) {
        hasPaintOrder = true;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          check(child);
          if (hasPaintOrder) return;
        }
      }
    };
    check(tree);
    return hasPaintOrder;
  }

  /**
   * Collect all nodes into flat list
   */
  private collectNodes(node: VirtualNode, result: VirtualNode[]): void {
    result.push(node);
    if (node.children) {
      for (const child of node.children) {
        this.collectNodes(child, result);
      }
    }
  }

  /**
   * Group nodes by paint order
   */
  private groupByPaintOrder(nodes: VirtualNode[]): Map<number, VirtualNode[]> {
    const groups = new Map<number, VirtualNode[]>();

    for (const node of nodes) {
      // Skip nodes without bounding box or paint order
      if (!node.boundingBox || node.paintOrder === undefined) {
        continue;
      }

      const paintOrder = node.paintOrder;
      if (!groups.has(paintOrder)) {
        groups.set(paintOrder, []);
      }
      groups.get(paintOrder)!.push(node);
    }

    return groups;
  }

  /**
   * Detect occluded nodes using RectUnion algorithm
   */
  private detectOcclusion(nodesByPaintOrder: Map<number, VirtualNode[]>): Set<number> {
    const occludedNodes = new Set<number>();

    // Sort paint orders in descending order (highest first = topmost)
    const paintOrders = Array.from(nodesByPaintOrder.keys()).sort((a, b) => b - a);

    // Build union of visible rectangles
    const rectUnion = new RectUnion();

    for (const paintOrder of paintOrders) {
      const nodes = nodesByPaintOrder.get(paintOrder)!;

      for (const node of nodes) {
        const bbox = node.boundingBox!;

        // Check if this node is fully covered by union
        if (rectUnion.contains(bbox)) {
          // Fully obscured - mark for filtering
          occludedNodes.add(node.backendNodeId);
          node.ignoredByPaintOrder = true;
        } else {
          // Visible (at least partially) - add to union
          rectUnion.add(bbox);
        }
      }
    }

    return occludedNodes;
  }

  /**
   * Filter tree based on occlusion map
   */
  private filterByOcclusion(
    node: VirtualNode,
    occludedNodes: Set<number>
  ): VirtualNode | null {
    // Check if this node is occluded
    if (occludedNodes.has(node.backendNodeId)) {
      return null;
    }

    // Recursively filter children
    if (node.children && node.children.length > 0) {
      const filteredChildren = node.children
        .map(child => this.filterByOcclusion(child, occludedNodes))
        .filter((child): child is VirtualNode => child !== null);

      return {
        ...node,
        children: filteredChildren.length > 0 ? filteredChildren : undefined
      };
    }

    return node;
  }
}
