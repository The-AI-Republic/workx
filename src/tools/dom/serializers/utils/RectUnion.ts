/**
 * RectUnion: Geometric occlusion detection algorithm
 *
 * Implements sweep-based rectangle union for paint order filtering (F5).
 * Determines if a target rectangle is fully covered by a union of rectangles.
 *
 * Algorithm:
 * 1. Process elements in reverse paint order (topmost first)
 * 2. Build union of visible rectangles
 * 3. Check if target is fully contained within union
 * 4. If fully covered → mark as obscured
 *
 * Complexity: O(n * m) where n = union size, m = average pieces after subtraction
 */

import { Rect } from '../../types';

export class RectUnion {
  private rects: Rect[] = [];

  /**
   * Check if target rect is fully contained within the union
   * @param target - Rectangle to check
   * @returns true if fully covered, false otherwise
   */
  contains(target: Rect): boolean {
    let remaining: Rect[] = [target];

    // Iterate through covering rectangles
    for (const covering of this.rects) {
      const newRemaining: Rect[] = [];

      for (const piece of remaining) {
        if (this.fullyCovers(covering, piece)) {
          // Fully covered, discard this piece
          continue;
        }

        if (this.intersects(covering, piece)) {
          // Partially covered, subtract and continue with remaining pieces
          const subtracted = this.subtract(piece, covering);
          newRemaining.push(...subtracted);
        } else {
          // Not covered at all, keep piece
          newRemaining.push(piece);
        }
      }

      remaining = newRemaining;

      // If nothing remains, target is fully covered
      if (remaining.length === 0) {
        return true;
      }
    }

    // If any pieces remain, target is not fully covered
    return false;
  }

  /**
   * Add a rect to the union (if not already contained)
   * @param rect - Rectangle to add
   */
  add(rect: Rect): void {
    // Optimization: don't add if already fully contained
    if (!this.contains(rect)) {
      this.rects.push(rect);
    }
  }

  /**
   * Get current size of union (for debugging)
   * @returns Number of rectangles in union
   */
  getSize(): number {
    return this.rects.length;
  }

  /**
   * Clear the union
   */
  clear(): void {
    this.rects = [];
  }

  /**
   * Check if container fully covers contained
   * @param container - Outer rectangle
   * @param contained - Inner rectangle
   * @returns true if contained is fully inside container
   */
  private fullyCovers(container: Rect, contained: Rect): boolean {
    return (
      container.x <= contained.x &&
      container.y <= contained.y &&
      container.x + container.width >= contained.x + contained.width &&
      container.y + container.height >= contained.y + contained.height
    );
  }

  /**
   * Check if two rectangles intersect
   * @param a - First rectangle
   * @param b - Second rectangle
   * @returns true if rectangles overlap
   */
  private intersects(a: Rect, b: Rect): boolean {
    return !(
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );
  }

  /**
   * Subtract covering from target, return remaining pieces
   * @param target - Rectangle to subtract from
   * @param covering - Rectangle to subtract
   * @returns Array of remaining rectangle pieces
   */
  private subtract(target: Rect, covering: Rect): Rect[] {
    const parts: Rect[] = [];

    // Bottom slice (below covering)
    if (target.y < covering.y) {
      parts.push({
        x: target.x,
        y: target.y,
        width: target.width,
        height: covering.y - target.y,
      });
    }

    // Top slice (above covering)
    if (covering.y + covering.height < target.y + target.height) {
      parts.push({
        x: target.x,
        y: covering.y + covering.height,
        width: target.width,
        height: target.y + target.height - (covering.y + covering.height),
      });
    }

    // Calculate vertical overlap bounds
    const y_lo = Math.max(target.y, covering.y);
    const y_hi = Math.min(target.y + target.height, covering.y + covering.height);

    // Left slice
    if (target.x < covering.x) {
      parts.push({
        x: target.x,
        y: y_lo,
        width: covering.x - target.x,
        height: y_hi - y_lo,
      });
    }

    // Right slice
    if (covering.x + covering.width < target.x + target.width) {
      parts.push({
        x: covering.x + covering.width,
        y: y_lo,
        width: target.x + target.width - (covering.x + covering.width),
        height: y_hi - y_lo,
      });
    }

    return parts;
  }
}
