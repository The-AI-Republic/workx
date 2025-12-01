/**
 * VisibilityFilter (F1): Remove hidden and invisible elements
 *
 * Removes elements that are not visible to the user:
 * - Zero bounding box (width = 0 or height = 0)
 * - aria-hidden="true" (with exception for dialogs/modals)
 * - display: none
 * - visibility: hidden
 * - opacity: 0
 *
 * Exception: Dialog/modal elements are preserved even if aria-hidden,
 * as they may contain interactive content that becomes visible.
 *
 * Stage 1 Signal Filtering
 */

import type { VirtualNode } from '../../types';

export class VisibilityFilter {
  /**
   * Filter tree to remove invisible elements
   * @param tree - VirtualNode tree to filter
   * @returns Filtered tree with invisible elements removed
   */
  filter(tree: VirtualNode): VirtualNode | null {
    // Always preserve html, head, and body - they are structural elements
    const tagName = (tree.localName || tree.nodeName || '').toLowerCase();
    const isStructuralRoot = tagName === 'html' || tagName === 'head' || tagName === 'body';

    // Check if this node should be filtered out (unless structural)
    if (!isStructuralRoot && this.isInvisible(tree)) {
      return null;
    }

    const result = { ...tree };

    // Recursively filter children
    if (tree.children && tree.children.length > 0) {
      const filteredChildren = tree.children
        .map(child => this.filter(child))
        .filter((child): child is VirtualNode => child !== null);
      result.children = filteredChildren.length > 0 ? filteredChildren : undefined;
    }

    // Recursively filter shadow roots
    if (tree.shadowRoots && tree.shadowRoots.length > 0) {
      const filteredShadowRoots = tree.shadowRoots
        .map(sr => this.filter(sr))
        .filter((sr): sr is VirtualNode => sr !== null);
      result.shadowRoots = filteredShadowRoots.length > 0 ? filteredShadowRoots : undefined;
    }

    // Recursively filter content document
    if (tree.contentDocument) {
      result.contentDocument = this.filter(tree.contentDocument) || undefined;
    }

    return result;
  }

  /**
   * Check if element is invisible
   * @param node - VirtualNode to check
   * @returns true if invisible, false if visible
   */
  private isInvisible(node: VirtualNode): boolean {
    // Check zero bounding box
    if (this.hasZeroBoundingBox(node)) {
      return true;
    }

    // Check computed styles
    if (this.hasHiddenStyles(node)) {
      return true;
    }

    // Check aria-hidden (with dialog exception)
    if (this.isAriaHidden(node)) {
      return true;
    }

    return false;
  }

  /**
   * Check if element has zero width or height
   */
  private hasZeroBoundingBox(node: VirtualNode): boolean {
    if (!node.boundingBox) {
      // No bounding box data available - assume visible
      return false;
    }

    const { width, height } = node.boundingBox;
    const hasZeroDimensions = width === 0 || height === 0;

    if (!hasZeroDimensions) {
      return false;
    }

    // Exception: Preserve zero-dimension containers if they have visible descendants
    // Common CSS pattern: wrapper elements with zero bounding box that contain
    // absolutely/fixed-positioned children with proper dimensions
    // Examples: dialogs, modals, tooltips, popovers, dropdowns
    if (this.hasVisibleDescendant(node)) {
      return false;
    }

    return true;
  }

  /**
   * Check if node has any descendant with non-zero dimensions
   */
  private hasVisibleDescendant(node: VirtualNode): boolean {
    // Check children
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        // Check if this child has non-zero dimensions
        if (child.boundingBox) {
          const { width, height } = child.boundingBox;
          if (width > 0 && height > 0) {
            return true;
          }
        }

        // Recursively check this child's descendants
        if (this.hasVisibleDescendant(child)) {
          return true;
        }
      }
    }

    // Check shadow roots
    if (node.shadowRoots && node.shadowRoots.length > 0) {
      for (const shadowRoot of node.shadowRoots) {
        // Shadow roots themselves don't usually have bounding boxes, so check their children
        if (this.hasVisibleDescendant(shadowRoot)) {
          return true;
        }
      }
    }

    // Check content document (iframe)
    if (node.contentDocument) {
      if (this.hasVisibleDescendant(node.contentDocument)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if element has CSS hiding styles
   */
  private hasHiddenStyles(node: VirtualNode): boolean {
    if (!node.computedStyle) {
      // No computed style data - assume visible
      return false;
    }

    const { display, visibility, opacity } = node.computedStyle;

    // display: none
    if (display === 'none') {
      return true;
    }

    // visibility: hidden
    if (visibility === 'hidden') {
      return true;
    }

    // opacity: 0
    if (opacity === '0') {
      return true;
    }

    return false;
  }

  /**
   * Check if element is aria-hidden (with dialog exception)
   */
  private isAriaHidden(node: VirtualNode): boolean {
    // Check for aria-hidden attribute
    if (!node.attributes) {
      return false;
    }

    let ariaHidden = false;
    for (let i = 0; i < node.attributes.length; i += 2) {
      if (node.attributes[i] === 'aria-hidden' && node.attributes[i + 1] === 'true') {
        ariaHidden = true;
        break;
      }
    }

    if (!ariaHidden) {
      return false;
    }

    // Exception: Preserve dialog/modal elements even if aria-hidden
    // Dialogs are often aria-hidden when closed, but still contain interactive content
    const role = node.accessibility?.role;
    if (role === 'dialog' || role === 'alertdialog') {
      return false;
    }

    // Check for common modal/dialog class names
    for (let i = 0; i < (node.attributes?.length || 0); i += 2) {
      if (node.attributes![i] === 'class') {
        const className = node.attributes![i + 1].toLowerCase();
        if (
          className.includes('modal') ||
          className.includes('dialog') ||
          className.includes('overlay')
        ) {
          return false;
        }
      }
    }

    return true;
  }
}
