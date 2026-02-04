/**
 * Coordinate Calculator for Visual Effects
 *
 * Calculates viewport coordinates for elements, including those inside iframes.
 * Visual effects always render at page level, so iframe element coordinates
 * must be translated to viewport coordinates.
 *
 * @module ui_effect/utils/coordinateCalculator
 */

/**
 * Viewport coordinate position
 */
export interface ViewportPosition {
  /** X coordinate in viewport pixels */
  x: number;
  /** Y coordinate in viewport pixels */
  y: number;
}

/**
 * Get viewport coordinates for an element
 *
 * Calculates the position of an element relative to the viewport,
 * accounting for nested iframes by recursively accumulating offsets.
 *
 * For elements in iframes:
 * 1. Get element's position within its document
 * 2. Walk up iframe hierarchy, accumulating offsets
 * 3. Return final viewport coordinates
 *
 * @param element - DOM element to calculate position for
 * @returns Viewport coordinates {x, y} or null if element is detached/invalid
 *
 * @example
 * // Element in main page
 * const coords = getViewportCoordinates(button);
 * // coords = { x: 100, y: 200 }
 *
 * @example
 * // Element inside iframe
 * const coords = getViewportCoordinates(iframeButton);
 * // coords = { x: 150, y: 250 } (iframe offset + element offset)
 */
export function getViewportCoordinates(element: Element): ViewportPosition | null {
  try {
    // Get element's bounding box in its own document
    const rect = element.getBoundingClientRect();

    // Start with element's position in its document
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;

    // Walk up the iframe hierarchy to accumulate offsets
    let currentWindow: Window | null = element.ownerDocument.defaultView;

    while (currentWindow && currentWindow.parent !== currentWindow) {
      try {
        // Find the iframe element in the parent document
        const frameElement = currentWindow.frameElement;

        if (!frameElement) {
          // Can't access parent (cross-origin) - use current coordinates
          break;
        }

        // Get iframe's position in parent document
        const frameRect = frameElement.getBoundingClientRect();

        // Add iframe offset to accumulated position
        x += frameRect.left;
        y += frameRect.top;

        // Move up to parent window
        currentWindow = currentWindow.parent;
      } catch (error) {
        // Cross-origin access blocked - stop accumulating
        console.debug('[CoordinateCalculator] Cross-origin iframe detected, using current coordinates', error);
        break;
      }
    }

    return { x, y };
  } catch (error) {
    console.error('[CoordinateCalculator] Failed to calculate viewport coordinates:', error);
    return null;
  }
}

/**
 * Get viewport coordinates from bounding box
 *
 * Calculates center point of a DOMRect relative to viewport.
 * Used when element reference is not available (e.g., cross-origin iframes).
 *
 * @param boundingBox - DOMRect with position information
 * @returns Viewport coordinates {x, y}
 *
 * @example
 * const coords = getViewportCoordinatesFromRect(new DOMRect(10, 20, 100, 50));
 * // coords = { x: 60, y: 45 } (center of rectangle)
 */
export function getViewportCoordinatesFromRect(boundingBox: DOMRect): ViewportPosition {
  return {
    x: boundingBox.left + boundingBox.width / 2,
    y: boundingBox.top + boundingBox.height / 2,
  };
}

/**
 * Validate viewport coordinates are within bounds
 *
 * Checks if coordinates are within the current viewport dimensions.
 * Used to detect if cursor target is offscreen.
 *
 * @param position - Viewport coordinates to validate
 * @returns true if coordinates are within viewport bounds
 *
 * @example
 * const isValid = isWithinViewport({ x: 100, y: 200 });
 * // true if viewport is at least 100x200 pixels
 */
export function isWithinViewport(position: ViewportPosition): boolean {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    position.x <= window.innerWidth &&
    position.y <= window.innerHeight
  );
}

/**
 * Calculate distance between two viewport positions
 *
 * Uses Euclidean distance formula.
 * Used to determine animation duration based on travel distance.
 *
 * @param from - Starting position
 * @param to - Target position
 * @returns Distance in pixels
 *
 * @example
 * const distance = calculateDistance({ x: 0, y: 0 }, { x: 30, y: 40 });
 * // distance = 50 (pixels)
 */
export function calculateDistance(from: ViewportPosition, to: ViewportPosition): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.sqrt(dx * dx + dy * dy);
}
