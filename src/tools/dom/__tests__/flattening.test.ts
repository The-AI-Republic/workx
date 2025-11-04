import { describe, it, expect } from 'vitest';
import { DomSnapshot } from '../DomSnapshot';
import { NODE_TYPE_ELEMENT } from '../types';
import type { VirtualNode, PageContext, SnapshotStats } from '../types';

/**
 * Test suite specifically for verifying the Two-Pass flattening logic
 * as specified in the CDP design document.
 *
 * Pass 1: Build complete 1:1 VirtualNode tree (already tested in DomService)
 * Pass 2: Flatten to remove structural junk nodes
 *
 * Flattening Rules:
 * 1. Keep semantic nodes (Tier 1) with full metadata
 * 2. Keep non-semantic nodes (Tier 2) with full metadata
 * 3. Keep semantic containers (form, table, dialog, etc.) with minimal metadata
 * 4. Hoist children of structural nodes (remove wrapper, promote children)
 * 5. Discard leaf structural nodes
 */
describe('DomSnapshot Flattening Logic', () => {
  const mockPageContext: PageContext = {
    url: 'https://example.com',
    title: 'Test',
    frameId: 'main',
    loaderId: 'loader1',
    viewport: { width: 1920, height: 1080 },
    frameTree: []
  };

  const mockStats: SnapshotStats = {
    totalNodes: 0,
    interactiveNodes: 0,
    semanticNodes: 0,
    nonSemanticNodes: 0,
    structuralNodes: 0,
    frameCount: 0,
    shadowRootCount: 0,
    snapshotDuration: 0
  };

  describe('Rule 1 & 2: Keep semantic and non-semantic nodes', () => {
    it('should keep semantic button with full metadata', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'BUTTON',
        localName: 'button',
        tier: 'semantic',
        interactionType: 'click',
        accessibility: {
          role: 'button',
          name: 'Submit Form'
        },
        attributes: ['id', 'submit-btn', 'class', 'btn-primary']
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      expect(serialized.page.body.node_id).toBe(100); // backendNodeId
      expect(serialized.page.body.tag).toBe('button');
      expect(serialized.page.body.role).toBe('button');
      expect(serialized.page.body['aria-label']).toBe('Submit Form');
    });

    it('should keep non-semantic div with onclick handler', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'non-semantic', // Has onclick but no proper role
        interactionType: 'click',
        heuristics: {
          hasOnClick: true,
          hasDataTestId: false,
          hasCursorPointer: false,
          isVisuallyInteractive: false
        },
        attributes: ['onclick', 'handleClick()']
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      expect(serialized.page.body.node_id).toBe(100); // backendNodeId
      expect(serialized.page.body.tag).toBe('div');
      // Non-semantic nodes are kept because they're interactive
    });
  });

  describe('Rule 3: Keep semantic containers', () => {
    it('should keep form container with minimal metadata', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'FORM',
        localName: 'form',
        tier: 'structural', // Forms are structural but should be kept
        accessibility: { role: 'form' },
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'INPUT',
            localName: 'input',
            tier: 'semantic',
            interactionType: 'input',
            accessibility: { role: 'textbox', name: 'Email' }
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      expect(serialized.page.body.node_id).toBe(100); // backendNodeId
      expect(serialized.page.body.tag).toBe('form');
      expect(serialized.page.body.role).toBe('form');
      expect(serialized.page.body.children).toBeDefined();
      expect(serialized.page.body.children?.length).toBe(1);
      expect(serialized.page.body.children?.[0].tag).toBe('input');
    });
  });

  describe('Rule 4: Hoist children of structural nodes', () => {
    it('should remove structural div wrapper and hoist button child', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural', // Wrapper div
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            interactionType: 'click',
            accessibility: { role: 'button', name: 'Click Me' }
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      // Div wrapper removed, button hoisted to root
      expect(serialized.page.body.node_id).toBe(101); // Button's backendNodeId, not div's
      expect(serialized.page.body.tag).toBe('button');
      expect(serialized.page.body.role).toBe('button');
    });

    it('should hoist multiple children from structural wrapper', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            accessibility: { role: 'button', name: 'Button 1' }
          },
          {
            nodeId: 3,
            backendNodeId: 102,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            accessibility: { role: 'button', name: 'Button 2' }
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      // When multiple children, a minimal wrapper is kept for grouping
      expect(serialized.page.body.children).toBeDefined();
      expect(serialized.page.body.children?.length).toBe(2);
      expect(serialized.page.body.children?.[0].tag).toBe('button');
      expect(serialized.page.body.children?.[1].tag).toBe('button');
    });

    it('should hoist through nested structural wrappers', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'DIV',
        localName: 'div',
        tier: 'structural',
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 3,
                backendNodeId: 102,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'BUTTON',
                localName: 'button',
                tier: 'semantic',
                accessibility: { role: 'button', name: 'Deep Button' }
              }
            ]
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      // Both wrapper divs removed, button hoisted to root
      expect(serialized.page.body.node_id).toBe(102); // Button's backendNodeId
      expect(serialized.page.body.tag).toBe('button');
      expect(serialized.page.body['aria-label']).toBe('Deep Button');
    });
  });

  describe('Rule 5: Discard leaf structural nodes', () => {
    it('should remove empty structural div', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'FORM',
        localName: 'form',
        tier: 'structural',
        accessibility: { role: 'form' },
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural'
            // No children - leaf structural node
          },
          {
            nodeId: 3,
            backendNodeId: 102,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            accessibility: { role: 'button', name: 'Submit' }
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      // Form is semantic container (kept)
      expect(serialized.page.body.tag).toBe('form');
      expect(serialized.page.body.children).toBeDefined();
      // Empty div discarded, only button remains
      expect(serialized.page.body.children?.length).toBe(1);
      expect(serialized.page.body.children?.[0].tag).toBe('button');
    });
  });

  describe('Complex real-world scenarios', () => {
    it('should flatten typical form structure', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'FORM',
        localName: 'form',
        tier: 'structural',
        accessibility: { role: 'form' },
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural',
            children: [
              {
                nodeId: 3,
                backendNodeId: 102,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'LABEL',
                localName: 'label',
                tier: 'structural',
                children: []
              },
              {
                nodeId: 4,
                backendNodeId: 103,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'INPUT',
                localName: 'input',
                tier: 'semantic',
                interactionType: 'input',
                accessibility: { role: 'textbox', name: 'Email' },
                attributes: ['type', 'email', 'placeholder', 'Enter email']
              }
            ]
          },
          {
            nodeId: 5,
            backendNodeId: 104,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'BUTTON',
            localName: 'button',
            tier: 'semantic',
            interactionType: 'click',
            accessibility: { role: 'button', name: 'Submit' }
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      // Form kept (semantic container)
      expect(serialized.page.body.tag).toBe('form');
      expect(serialized.page.body.role).toBe('form');

      // Should have 2 children: input and button (div and label removed)
      expect(serialized.page.body.children?.length).toBe(2);

      const children = serialized.page.body.children!;
      expect(children[0].tag).toBe('input');
      expect(children[0].placeholder).toBe('Enter email');
      expect(children[1].tag).toBe('button');
      expect(children[1]['aria-label']).toBe('Submit');
    });

    it('should handle mixed semantic and structural content', () => {
      const vdom: VirtualNode = {
        nodeId: 1,
        backendNodeId: 100,
        nodeType: NODE_TYPE_ELEMENT,
        nodeName: 'NAV',
        localName: 'nav',
        tier: 'structural',
        accessibility: { role: 'navigation' },
        children: [
          {
            nodeId: 2,
            backendNodeId: 101,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'DIV',
            localName: 'div',
            tier: 'structural', // Container div
            children: [
              {
                nodeId: 3,
                backendNodeId: 102,
                nodeType: NODE_TYPE_ELEMENT,
                nodeName: 'A',
                localName: 'a',
                tier: 'semantic',
                interactionType: 'link',
                accessibility: { role: 'link', name: 'Home' },
                attributes: ['href', '/home']
              }
            ]
          },
          {
            nodeId: 4,
            backendNodeId: 103,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'SPAN',
            localName: 'span',
            tier: 'structural' // Empty span
          },
          {
            nodeId: 5,
            backendNodeId: 104,
            nodeType: NODE_TYPE_ELEMENT,
            nodeName: 'A',
            localName: 'a',
            tier: 'semantic',
            interactionType: 'link',
            accessibility: { role: 'link', name: 'About' },
            attributes: ['href', '/about']
          }
        ]
      };

      const snapshot = new DomSnapshot(vdom, mockPageContext, mockStats);
      const serialized = snapshot.serialize();

      // Nav kept (semantic container)
      expect(serialized.page.body.tag).toBe('nav');
      expect(serialized.page.body.role).toBe('navigation');

      // Should have 2 links (div and span removed)
      expect(serialized.page.body.children?.length).toBe(2);
      expect(serialized.page.body.children?.[0].tag).toBe('a');
      expect(serialized.page.body.children?.[0].href).toBe('/home');
      expect(serialized.page.body.children?.[1].tag).toBe('a');
      expect(serialized.page.body.children?.[1].href).toBe('/about');
    });
  });
});
