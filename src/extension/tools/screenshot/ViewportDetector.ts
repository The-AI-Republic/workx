/**
 * ViewportDetector - Calculate element visibility in viewport
 *
 * Determines whether DOM elements are visible in the current viewport
 * using CDP's DOM.getBoxModel and Runtime.evaluate for viewport bounds.
 *
 * Visibility threshold: >50% of element area must be visible
 */

export interface ViewportBounds {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface ViewportVisibility {
  inViewport: boolean;
  visibilityPercent: number;
}

export class ViewportDetector {
  /**
   * Check if element is in viewport using CDP commands
   *
   * @param sendCommand - CDP command sender function
   * @param backendNodeId - CDP backend node ID
   * @param viewportBounds - Current viewport bounds (optional, will fetch if not provided)
   * @returns Viewport visibility information
   */
  static async isInViewport(
    sendCommand: <T = any>(method: string, params?: any) => Promise<T>,
    backendNodeId: number,
    viewportBounds?: ViewportBounds
  ): Promise<ViewportVisibility> {
    try {
      // 1. Get viewport bounds if not provided
      const viewport = viewportBounds || await this.getViewportBounds(sendCommand);

      // 2. Get element box model
      const boxModel = await sendCommand<any>('DOM.getBoxModel', { backendNodeId });

      if (!boxModel?.model?.content) {
        // Element has no box model (display:none, detached, etc.)
        return { inViewport: false, visibilityPercent: 0 };
      }

      const { content } = boxModel.model;

      // 3. Parse element coordinates (content quad: [x1, y1, x2, y1, x2, y2, x1, y2])
      const elemX = content[0];
      const elemY = content[1];
      const elemWidth = Math.abs(content[2] - content[0]);
      const elemHeight = Math.abs(content[5] - content[1]);

      // Handle zero-size elements
      if (elemWidth === 0 || elemHeight === 0) {
        return { inViewport: false, visibilityPercent: 0 };
      }

      // 4. Convert to viewport coordinates (element coords are absolute, relative to document)
      const elemLeft = elemX - viewport.scrollX;
      const elemTop = elemY - viewport.scrollY;
      const elemRight = elemLeft + elemWidth;
      const elemBottom = elemTop + elemHeight;

      // 5. Calculate intersection with viewport bounds
      const intersectLeft = Math.max(elemLeft, 0);
      const intersectTop = Math.max(elemTop, 0);
      const intersectRight = Math.min(elemRight, viewport.width);
      const intersectBottom = Math.min(elemBottom, viewport.height);

      // 6. Compute visibility percentage
      const hasIntersection = intersectRight > intersectLeft && intersectBottom > intersectTop;
      if (!hasIntersection) {
        return { inViewport: false, visibilityPercent: 0 };
      }

      const intersectArea = (intersectRight - intersectLeft) * (intersectBottom - intersectTop);
      const elementArea = elemWidth * elemHeight;
      const visibilityPercent = (intersectArea / elementArea) * 100;

      return {
        inViewport: visibilityPercent > 50, // >50% threshold
        visibilityPercent: visibilityPercent
      };
    } catch (error: any) {
      // Element not found, detached, or other CDP error
      // Default to not in viewport
      console.debug('[ViewportDetector] Failed to detect viewport visibility:', error.message);
      return { inViewport: false, visibilityPercent: 0 };
    }
  }

  /**
   * Get current viewport bounds using CDP Runtime.evaluate
   */
  static async getViewportBounds(
    sendCommand: <T = any>(method: string, params?: any) => Promise<T>
  ): Promise<ViewportBounds> {
    const result = await sendCommand<any>('Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })',
      returnByValue: true
    });

    return result.result.value;
  }
}
