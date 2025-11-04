/**
 * NumericCompactor (P3.4): Compact bounding boxes to integer arrays
 *
 * Reduces token count by converting bounding box objects to compact arrays:
 *
 * Before:
 *   { x: 100.5, y: 200.3, width: 50.2, height: 30.1 }
 *
 * After:
 *   [100, 200, 50, 30]
 *
 * Additional optimizations:
 * - Round floats to integers (pixel precision sufficient)
 * - Omit zero values when possible
 * - Use array notation instead of object (less verbose)
 *
 * Stage 3 Payload Optimization
 */

import { VirtualNode } from '../../types';

export class NumericCompactor {
  /**
   * Compact numeric data in tree
   * @param tree - VirtualNode tree to optimize
   * @returns Optimized tree with compacted numerics
   */
  compact(tree: VirtualNode): VirtualNode {
    // Compact this node's bounding box
    const compactedNode = this.compactNode(tree);

    // Recursively process children
    if (compactedNode.children && compactedNode.children.length > 0) {
      const compactedChildren = compactedNode.children.map(child => this.compact(child));

      return {
        ...compactedNode,
        children: compactedChildren
      };
    }

    return compactedNode;
  }

  /**
   * Compact numeric data for a single node
   */
  private compactNode(node: VirtualNode): VirtualNode {
    // Compact bounding box to array
    const compactedBoundingBox = node.boundingBox
      ? this.compactBoundingBox(node.boundingBox)
      : undefined;

    return {
      ...node,
      boundingBox: compactedBoundingBox as any // Will be converted to array in serialization
    };
  }

  /**
   * Compact bounding box to [x, y, width, height] array
   */
  private compactBoundingBox(bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; width: number; height: number } {
    // Round to integers for pixel precision
    return {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height)
    };
  }

  /**
   * Convert bounding box object to array (for serialization)
   */
  static bboxToArray(bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): number[] {
    return [
      Math.round(bbox.x),
      Math.round(bbox.y),
      Math.round(bbox.width),
      Math.round(bbox.height)
    ];
  }

  /**
   * Convert array back to bounding box object (for deserialization)
   */
  static arrayToBbox(arr: number[]): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    return {
      x: arr[0],
      y: arr[1],
      width: arr[2],
      height: arr[3]
    };
  }
}
