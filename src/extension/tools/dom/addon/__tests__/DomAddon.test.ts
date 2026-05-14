import { describe, it, expect, beforeEach } from 'vitest';
import { DomAddon, type DomAddonContext, type DomAddonResult } from '../DomAddon';
import type { VirtualNode } from '../../types';

/**
 * Concrete subclass for testing the abstract DomAddon base class
 */
class TestAddon extends DomAddon {
  readonly name = 'TestAddon';

  async read(_tree: VirtualNode, _context: DomAddonContext): Promise<DomAddonResult> {
    return { executed: true, success: true, nodesAugmented: 0 };
  }

  // Expose protected methods for testing
  public exposeFindNodes(tree: VirtualNode, predicate: (node: VirtualNode) => boolean): VirtualNode[] {
    return this.findNodes(tree, predicate);
  }

  public exposeTraverseTree(node: VirtualNode, callback: (node: VirtualNode) => void): void {
    this.traverseTree(node, callback);
  }

  public exposeCreateTextNode(text: string, parentBackendNodeId: number): VirtualNode {
    return this.createTextNode(text, parentBackendNodeId);
  }
}

/** Helper to build a minimal VirtualNode */
function makeNode(overrides: Partial<VirtualNode> = {}): VirtualNode {
  return {
    nodeId: 1,
    backendNodeId: 100,
    nodeType: 1,
    nodeName: 'DIV',
    tier: 'semantic',
    ...overrides,
  };
}

describe('DomAddon (base class)', () => {
  let addon: TestAddon;

  beforeEach(() => {
    addon = new TestAddon();
  });

  // -------------------------------------------------------------------------
  // createTextNode
  // -------------------------------------------------------------------------
  describe('createTextNode', () => {
    it('should create a text node with the given text', () => {
      const node = addon.exposeCreateTextNode('Hello World', 42);
      expect(node.nodeValue).toBe('Hello World');
    });

    it('should set nodeType to 3 (TEXT_NODE)', () => {
      const node = addon.exposeCreateTextNode('test', 10);
      expect(node.nodeType).toBe(3);
    });

    it('should set nodeName to #text', () => {
      const node = addon.exposeCreateTextNode('test', 10);
      expect(node.nodeName).toBe('#text');
    });

    it('should set nodeId to -1 (synthetic)', () => {
      const node = addon.exposeCreateTextNode('test', 10);
      expect(node.nodeId).toBe(-1);
    });

    it('should derive backendNodeId from parent with +0.1 offset', () => {
      const node = addon.exposeCreateTextNode('test', 200);
      expect(node.backendNodeId).toBeCloseTo(200.1, 5);
    });

    it('should set tier to semantic', () => {
      const node = addon.exposeCreateTextNode('test', 10);
      expect(node.tier).toBe('semantic');
    });

    it('should handle empty text', () => {
      const node = addon.exposeCreateTextNode('', 5);
      expect(node.nodeValue).toBe('');
    });

    it('should handle very long text', () => {
      const longText = 'A'.repeat(100000);
      const node = addon.exposeCreateTextNode(longText, 5);
      expect(node.nodeValue).toBe(longText);
      expect(node.nodeValue!.length).toBe(100000);
    });

    it('should handle special characters in text', () => {
      const special = '<script>alert("xss")</script>\n\t&amp;';
      const node = addon.exposeCreateTextNode(special, 5);
      expect(node.nodeValue).toBe(special);
    });
  });

  // -------------------------------------------------------------------------
  // traverseTree
  // -------------------------------------------------------------------------
  describe('traverseTree', () => {
    it('should visit a single node', () => {
      const root = makeNode();
      const visited: VirtualNode[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n));
      expect(visited).toHaveLength(1);
      expect(visited[0]).toBe(root);
    });

    it('should visit all children recursively', () => {
      const child1 = makeNode({ nodeId: 2, backendNodeId: 101 });
      const child2 = makeNode({ nodeId: 3, backendNodeId: 102 });
      const grandchild = makeNode({ nodeId: 4, backendNodeId: 103 });
      child1.children = [grandchild];
      const root = makeNode({ children: [child1, child2] });

      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1, 2, 4, 3]);
    });

    it('should traverse shadow roots', () => {
      const shadowChild = makeNode({ nodeId: 10, backendNodeId: 200 });
      const shadowRoot = makeNode({
        nodeId: 5,
        backendNodeId: 150,
        children: [shadowChild],
      });
      const root = makeNode({ shadowRoots: [shadowRoot] });

      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1, 5, 10]);
    });

    it('should traverse contentDocument', () => {
      const docChild = makeNode({ nodeId: 20, backendNodeId: 300 });
      const contentDoc = makeNode({
        nodeId: 15,
        backendNodeId: 250,
        children: [docChild],
      });
      const root = makeNode({ contentDocument: contentDoc });

      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1, 15, 20]);
    });

    it('should traverse children, shadow roots, and contentDocument', () => {
      const child = makeNode({ nodeId: 2, backendNodeId: 101 });
      const shadowChild = makeNode({ nodeId: 10, backendNodeId: 200 });
      const shadowRoot = makeNode({ nodeId: 5, backendNodeId: 150, children: [shadowChild] });
      const docChild = makeNode({ nodeId: 20, backendNodeId: 300 });
      const contentDoc = makeNode({ nodeId: 15, backendNodeId: 250, children: [docChild] });

      const root = makeNode({
        children: [child],
        shadowRoots: [shadowRoot],
        contentDocument: contentDoc,
      });

      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      // order: root, child, shadowRoot, shadowChild, contentDoc, docChild
      expect(visited).toEqual([1, 2, 5, 10, 15, 20]);
    });

    it('should handle node with no children, shadowRoots, or contentDocument', () => {
      const root = makeNode();
      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1]);
    });

    it('should handle deeply nested trees', () => {
      let current = makeNode({ nodeId: 0, backendNodeId: 0 });
      const root = current;
      for (let i = 1; i <= 50; i++) {
        const child = makeNode({ nodeId: i, backendNodeId: i });
        current.children = [child];
        current = child;
      }

      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toHaveLength(51);
      expect(visited[0]).toBe(0);
      expect(visited[50]).toBe(50);
    });

    it('should handle multiple shadow roots', () => {
      const sr1 = makeNode({ nodeId: 10, backendNodeId: 200 });
      const sr2 = makeNode({ nodeId: 11, backendNodeId: 201 });
      const root = makeNode({ shadowRoots: [sr1, sr2] });

      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1, 10, 11]);
    });

    it('should handle empty children array', () => {
      const root = makeNode({ children: [] });
      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1]);
    });

    it('should handle empty shadowRoots array', () => {
      const root = makeNode({ shadowRoots: [] });
      const visited: number[] = [];
      addon.exposeTraverseTree(root, (n) => visited.push(n.nodeId));
      expect(visited).toEqual([1]);
    });
  });

  // -------------------------------------------------------------------------
  // findNodes
  // -------------------------------------------------------------------------
  describe('findNodes', () => {
    it('should return empty array when no nodes match', () => {
      const root = makeNode({ nodeName: 'DIV' });
      const results = addon.exposeFindNodes(root, (n) => n.nodeName === 'SPAN');
      expect(results).toEqual([]);
    });

    it('should find root node if it matches', () => {
      const root = makeNode({ nodeName: 'DIV' });
      const results = addon.exposeFindNodes(root, (n) => n.nodeName === 'DIV');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(root);
    });

    it('should find multiple matching nodes', () => {
      const span1 = makeNode({ nodeId: 2, nodeName: 'SPAN', backendNodeId: 101 });
      const span2 = makeNode({ nodeId: 3, nodeName: 'SPAN', backendNodeId: 102 });
      const div = makeNode({ nodeId: 4, nodeName: 'DIV', backendNodeId: 103 });
      const root = makeNode({ children: [span1, div, span2] });

      const results = addon.exposeFindNodes(root, (n) => n.nodeName === 'SPAN');
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(span1);
      expect(results[1]).toBe(span2);
    });

    it('should find nodes in nested children', () => {
      const target = makeNode({ nodeId: 5, nodeName: 'CANVAS', backendNodeId: 105 });
      const inner = makeNode({ nodeId: 3, nodeName: 'DIV', backendNodeId: 103, children: [target] });
      const root = makeNode({ children: [inner] });

      const results = addon.exposeFindNodes(root, (n) => n.nodeName === 'CANVAS');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(target);
    });

    it('should find nodes in shadow roots', () => {
      const target = makeNode({ nodeId: 10, nodeName: 'BUTTON', backendNodeId: 200 });
      const shadowRoot = makeNode({ nodeId: 5, backendNodeId: 150, children: [target] });
      const root = makeNode({ shadowRoots: [shadowRoot] });

      const results = addon.exposeFindNodes(root, (n) => n.nodeName === 'BUTTON');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(target);
    });

    it('should find nodes in contentDocument', () => {
      const target = makeNode({ nodeId: 20, nodeName: 'INPUT', backendNodeId: 300 });
      const contentDoc = makeNode({ nodeId: 15, backendNodeId: 250, children: [target] });
      const root = makeNode({ contentDocument: contentDoc });

      const results = addon.exposeFindNodes(root, (n) => n.nodeName === 'INPUT');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(target);
    });

    it('should support complex predicates', () => {
      const interactive = makeNode({
        nodeId: 2,
        nodeName: 'BUTTON',
        backendNodeId: 101,
        tier: 'semantic',
        interactionType: 'click',
      });
      const nonInteractive = makeNode({ nodeId: 3, nodeName: 'DIV', backendNodeId: 102 });
      const root = makeNode({ children: [interactive, nonInteractive] });

      const results = addon.exposeFindNodes(
        root,
        (n) => n.tier === 'semantic' && n.interactionType === 'click'
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(interactive);
    });
  });

  // -------------------------------------------------------------------------
  // Abstract contract
  // -------------------------------------------------------------------------
  describe('abstract contract', () => {
    it('should have a name property', () => {
      expect(addon.name).toBe('TestAddon');
    });

    it('should implement read method', async () => {
      const tree = makeNode();
      const context: DomAddonContext = {
        tabId: 1,
        url: 'https://example.com',
        title: 'Test',
        sendCommand: async () => ({} as any),
      };
      const result = await addon.read(tree, context);
      expect(result.executed).toBe(true);
      expect(result.success).toBe(true);
    });
  });
});
