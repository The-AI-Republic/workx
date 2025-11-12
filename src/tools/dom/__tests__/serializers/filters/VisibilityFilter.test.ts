/**
 * Unit tests for VisibilityFilter
 * Test visible, hidden, aria-hidden, dialog exception
 */

import { describe, it, expect } from 'vitest';
import { VisibilityFilter } from '../../../serializers/filters/VisibilityFilter';
import { VirtualNode } from '../../../types';

describe('VisibilityFilter', () => {
  const filter = new VisibilityFilter();

  const createNode = (options: Partial<VirtualNode> = {}): VirtualNode => {
    return {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 1,
      nodeName: 'DIV',
      tier: 'structural',
      ...options
    };
  };

  describe('zero bounding box filtering', () => {
    it('should filter elements with zero width', () => {
      const node = createNode({
        boundingBox: { x: 0, y: 0, width: 0, height: 100 }
      });

      const result = filter.filter(node);
      expect(result).toBeNull();
    });

    it('should filter elements with zero height', () => {
      const node = createNode({
        boundingBox: { x: 0, y: 0, width: 100, height: 0 }
      });

      const result = filter.filter(node);
      expect(result).toBeNull();
    });

    it('should keep elements with non-zero dimensions', () => {
      const node = createNode({
        boundingBox: { x: 0, y: 0, width: 100, height: 50 }
      });

      const result = filter.filter(node);
      expect(result).not.toBeNull();
      expect(result?.backendNodeId).toBe(node.backendNodeId);
    });

    it('should keep elements without bounding box data', () => {
      const node = createNode({
        boundingBox: undefined
      });

      const result = filter.filter(node);
      expect(result).not.toBeNull();
    });
  });

  describe('CSS hiding styles filtering', () => {
    it('should filter elements with display:none', () => {
      const node = createNode({
        computedStyle: { display: 'none' }
      });

      const result = filter.filter(node);
      expect(result).toBeNull();
    });

    it('should filter elements with visibility:hidden', () => {
      const node = createNode({
        computedStyle: { visibility: 'hidden' }
      });

      const result = filter.filter(node);
      expect(result).toBeNull();
    });

    it('should filter elements with opacity:0', () => {
      const node = createNode({
        computedStyle: { opacity: '0' }
      });

      const result = filter.filter(node);
      expect(result).toBeNull();
    });

    it('should keep elements with visible styles', () => {
      const node = createNode({
        computedStyle: {
          display: 'block',
          visibility: 'visible',
          opacity: '1'
        }
      });

      const result = filter.filter(node);
      expect(result).not.toBeNull();
    });

    it('should keep elements without computed style data', () => {
      const node = createNode({
        computedStyle: undefined
      });

      const result = filter.filter(node);
      expect(result).not.toBeNull();
    });
  });

  describe('aria-hidden filtering', () => {
    it('should filter elements with aria-hidden=true', () => {
      const node = createNode({
        attributes: ['aria-hidden', 'true']
      });

      const result = filter.filter(node);
      expect(result).toBeNull();
    });

    it('should keep elements with aria-hidden=false', () => {
      const node = createNode({
        attributes: ['aria-hidden', 'false']
      });

      const result = filter.filter(node);
      expect(result).not.toBeNull();
    });

    it('should keep elements without aria-hidden attribute', () => {
      const node = createNode({
        attributes: ['class', 'foo']
      });

      const result = filter.filter(node);
      expect(result).not.toBeNull();
    });
  });

  describe('dialog exception', () => {
    it('should preserve dialog elements even with aria-hidden=true', () => {
      const dialog = createNode({
        attributes: ['aria-hidden', 'true'],
        accessibility: { role: 'dialog' }
      });

      const result = filter.filter(dialog);
      expect(result).not.toBeNull();
    });

    it('should preserve alertdialog elements even with aria-hidden=true', () => {
      const alertDialog = createNode({
        attributes: ['aria-hidden', 'true'],
        accessibility: { role: 'alertdialog' }
      });

      const result = filter.filter(alertDialog);
      expect(result).not.toBeNull();
    });

    it('should preserve elements with modal class even with aria-hidden=true', () => {
      const modal = createNode({
        attributes: ['aria-hidden', 'true', 'class', 'modal-dialog']
      });

      const result = filter.filter(modal);
      expect(result).not.toBeNull();
    });

    it('should preserve elements with overlay class even with aria-hidden=true', () => {
      const overlay = createNode({
        attributes: ['aria-hidden', 'true', 'class', 'overlay-container']
      });

      const result = filter.filter(overlay);
      expect(result).not.toBeNull();
    });

    it('should preserve dialog elements even with zero height', () => {
      const dialog = createNode({
        boundingBox: { x: 0, y: 0, width: 100, height: 0 },
        accessibility: { role: 'dialog' }
      });

      const result = filter.filter(dialog);
      expect(result).not.toBeNull();
    });

    it('should preserve alertdialog elements even with zero width', () => {
      const alertDialog = createNode({
        boundingBox: { x: 0, y: 0, width: 0, height: 100 },
        accessibility: { role: 'alertdialog' }
      });

      const result = filter.filter(alertDialog);
      expect(result).not.toBeNull();
    });

    it('should preserve elements with modal class even with zero dimensions', () => {
      const modal = createNode({
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        attributes: ['class', 'modal-container']
      });

      const result = filter.filter(modal);
      expect(result).not.toBeNull();
    });

    it('should preserve elements with dialog class even with zero dimensions', () => {
      const dialogClass = createNode({
        boundingBox: { x: 0, y: 0, width: 100, height: 0 },
        attributes: ['class', 'dialog-wrapper']
      });

      const result = filter.filter(dialogClass);
      expect(result).not.toBeNull();
    });

    it('should preserve elements with overlay class even with zero dimensions', () => {
      const overlay = createNode({
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        attributes: ['class', 'overlay-backdrop']
      });

      const result = filter.filter(overlay);
      expect(result).not.toBeNull();
    });

    it('should preserve nested dialogs with zero-dimension container (X.com scenario)', () => {
      // Outer dialog container with zero height (like Node 3532)
      const outerDialog = createNode({
        boundingBox: { x: 0, y: 780, width: 1497.5, height: 0 },
        accessibility: { role: 'dialog' },
        children: [
          // Inner dialog with proper dimensions (like Node 3538)
          createNode({
            backendNodeId: 2,
            boundingBox: { x: 448.75, y: 812.5, width: 600, height: 366 },
            accessibility: { role: 'dialog' },
            attributes: ['aria-modal', 'true']
          })
        ]
      });

      const result = filter.filter(outerDialog);
      expect(result).not.toBeNull();
      expect(result?.children).toHaveLength(1);
      expect(result?.children?.[0].backendNodeId).toBe(2);
    });
  });

  describe('recursive filtering', () => {
    it('should filter children of visible elements', () => {
      const parent = createNode({
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [
          createNode({
            backendNodeId: 2,
            boundingBox: { x: 0, y: 0, width: 0, height: 0 } // invisible child
          }),
          createNode({
            backendNodeId: 3,
            boundingBox: { x: 50, y: 50, width: 50, height: 50 } // visible child
          })
        ]
      });

      const result = filter.filter(parent);
      expect(result).not.toBeNull();
      expect(result?.children).toHaveLength(1);
      expect(result?.children?.[0].backendNodeId).toBe(3);
    });

    it('should keep parent even if all children filtered out', () => {
      const parent = createNode({
        boundingBox: { x: 0, y: 0, width: 200, height: 200 },
        children: [
          createNode({
            backendNodeId: 2,
            computedStyle: { display: 'none' }
          }),
          createNode({
            backendNodeId: 3,
            computedStyle: { visibility: 'hidden' }
          })
        ]
      });

      const result = filter.filter(parent);
      expect(result).not.toBeNull();
      expect(result?.children).toBeUndefined(); // All children filtered
    });
  });

  describe('real-world scenarios', () => {
    it('should filter hidden loading spinner', () => {
      const spinner = createNode({
        attributes: ['class', 'spinner', 'aria-hidden', 'true'],
        computedStyle: { opacity: '0' }
      });

      const result = filter.filter(spinner);
      expect(result).toBeNull();
    });

    it('should preserve visible modal dialog', () => {
      const modal = createNode({
        attributes: ['class', 'modal-dialog', 'aria-hidden', 'true'],
        accessibility: { role: 'dialog' },
        boundingBox: { x: 100, y: 100, width: 400, height: 300 },
        computedStyle: { display: 'block', opacity: '1' }
      });

      const result = filter.filter(modal);
      expect(result).not.toBeNull();
    });

    it('should filter collapsed accordion section', () => {
      const accordion = createNode({
        attributes: ['aria-hidden', 'true'],
        boundingBox: { x: 0, y: 0, width: 300, height: 0 } // Collapsed
      });

      const result = filter.filter(accordion);
      expect(result).toBeNull();
    });
  });
});
