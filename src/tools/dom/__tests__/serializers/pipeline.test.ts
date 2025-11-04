/**
 * Integration test for SerializationPipeline
 * Test full three-stage pipeline with baseline comparison
 */

import { describe, it, expect } from 'vitest';
import { SerializationPipeline } from '../../serializers/SerializationPipeline';
import { DEFAULT_PIPELINE_CONFIG, BASELINE_PIPELINE_CONFIG } from '../../types';
import { VirtualNode } from '../../types';

describe('SerializationPipeline Integration', () => {
  const createTestTree = (): VirtualNode => {
    return {
      nodeId: 1,
      backendNodeId: 10001,
      nodeType: 1,
      nodeName: 'HTML',
      localName: 'html',
      tier: 'structural',
      children: [
        {
          nodeId: 2,
          backendNodeId: 10002,
          nodeType: 1,
          nodeName: 'HEAD',
          localName: 'head',
          tier: 'structural',
          children: [
            {
              nodeId: 3,
              backendNodeId: 10003,
              nodeType: 1,
              nodeName: 'SCRIPT',
              localName: 'script',
              tier: 'structural',
              nodeValue: 'console.log("test")'
            },
            {
              nodeId: 4,
              backendNodeId: 10004,
              nodeType: 1,
              nodeName: 'STYLE',
              localName: 'style',
              tier: 'structural',
              nodeValue: 'body { margin: 0; }'
            }
          ]
        },
        {
          nodeId: 5,
          backendNodeId: 10005,
          nodeType: 1,
          nodeName: 'BODY',
          localName: 'body',
          tier: 'structural',
          children: [
            {
              nodeId: 6,
              backendNodeId: 10006,
              nodeType: 1,
              nodeName: 'BUTTON',
              localName: 'button',
              tier: 'semantic',
              interactionType: 'click',
              accessibility: { role: 'button', name: 'Submit' },
              boundingBox: { x: 100, y: 100, width: 120, height: 40 },
              attributes: ['id', 'submit-btn', 'type', 'submit']
            },
            {
              nodeId: 7,
              backendNodeId: 10007,
              nodeType: 1,
              nodeName: 'DIV',
              localName: 'div',
              tier: 'structural',
              boundingBox: { x: 0, y: 0, width: 0, height: 0 } // Hidden wrapper
            },
            {
              nodeId: 8,
              backendNodeId: 10008,
              nodeType: 1,
              nodeName: 'INPUT',
              localName: 'input',
              tier: 'semantic',
              interactionType: 'input',
              accessibility: { role: 'textbox', value: '' },
              boundingBox: { x: 100, y: 150, width: 200, height: 30 },
              attributes: ['type', 'text', 'placeholder', 'Enter name']
            }
          ]
        }
      ]
    };
  };

  describe('full pipeline execution', () => {
    it('should execute all three stages successfully', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      expect(result).toBeDefined();
      expect(result.tree).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.idRemapper).toBeDefined();
    });

    it('should provide IdRemapper with registered nodes', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      expect(result.idRemapper.getNodeCount()).toBeGreaterThan(0);
    });

    it('should calculate compaction metrics', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      expect(result.metrics.totalNodes).toBeGreaterThan(0);
      expect(result.metrics.compactionScore).toBeGreaterThanOrEqual(0);
      expect(result.metrics.compactionScore).toBeLessThanOrEqual(1);
    });
  });

  describe('stage 1: signal filtering', () => {
    it('should remove script and style elements', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      // Check if script/style nodes were filtered
      const hasScript = JSON.stringify(result.tree).includes('SCRIPT');
      const hasStyle = JSON.stringify(result.tree).includes('STYLE');

      expect(hasScript).toBe(false);
      expect(hasStyle).toBe(false);
    });

    it('should remove elements with zero bounding box', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      // Hidden div should be filtered
      const findNode = (node: VirtualNode, id: number): VirtualNode | null => {
        if (node.backendNodeId === id) return node;
        if (node.children) {
          for (const child of node.children) {
            const found = findNode(child, id);
            if (found) return found;
          }
        }
        return null;
      };

      const hiddenDiv = findNode(result.tree, 10007);
      expect(hiddenDiv).toBeNull(); // Should be filtered out
    });

    it('should keep visible interactive elements', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      const findNode = (node: VirtualNode, id: number): VirtualNode | null => {
        if (node.backendNodeId === id) return node;
        if (node.children) {
          for (const child of node.children) {
            const found = findNode(child, id);
            if (found) return found;
          }
        }
        return null;
      };

      const button = findNode(result.tree, 10006);
      const input = findNode(result.tree, 10008);

      expect(button).not.toBeNull();
      expect(input).not.toBeNull();
    });
  });

  describe('stage 2: structure simplification', () => {
    it('should remove redundant attributes', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'BUTTON',
        localName: 'button',
        tier: 'semantic',
        attributes: ['role', 'button', 'type', ''], // role=button redundant, type empty
        boundingBox: { x: 0, y: 0, width: 100, height: 40 }
      };

      const pipeline = new SerializationPipeline();
      const result = pipeline.execute(tree);

      // Redundant role should be removed
      const hasRedundantRole = result.tree.attributes?.includes('button');
      expect(hasRedundantRole).toBe(false);
    });
  });

  describe('stage 3: payload optimization', () => {
    it('should assign sequential IDs', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      // Check that IdRemapper was populated
      const nodeCount = result.idRemapper.getNodeCount();
      expect(nodeCount).toBeGreaterThan(0);

      // Verify sequential ID mapping
      const mappings = result.idRemapper.getMappings();
      for (let i = 0; i < mappings.length; i++) {
        expect(mappings[i].sequentialId).toBe(i + 1);
      }
    });

    it('should prune non-semantic attributes', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'BUTTON',
        localName: 'button',
        tier: 'semantic',
        attributes: [
          'id', 'submit-btn', // semantic
          'class', 'btn btn-primary', // non-semantic (visual)
          'data-testid', 'submit-button', // semantic (testing)
          'style', 'color: red' // non-semantic (visual)
        ],
        boundingBox: { x: 0, y: 0, width: 100, height: 40 }
      };

      const pipeline = new SerializationPipeline();
      const result = pipeline.execute(tree);

      // class and style should be removed
      const hasClass = result.tree.attributes?.includes('class');
      const hasStyle = result.tree.attributes?.includes('style');

      // id and data-testid should be kept
      const hasId = result.tree.attributes?.includes('id');
      const hasDataTestId = result.tree.attributes?.includes('data-testid');

      expect(hasClass).toBe(false);
      expect(hasStyle).toBe(false);
      expect(hasId).toBe(true);
      expect(hasDataTestId).toBe(true);
    });

    it('should compact numeric bounding boxes', () => {
      const tree: VirtualNode = {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 1,
        nodeName: 'BUTTON',
        localName: 'button',
        tier: 'semantic',
        boundingBox: { x: 100.7, y: 200.3, width: 50.9, height: 30.1 }
      };

      const pipeline = new SerializationPipeline();
      const result = pipeline.execute(tree);

      // Bounding box should be rounded to integers
      expect(result.tree.boundingBox?.x).toBe(101);
      expect(result.tree.boundingBox?.y).toBe(200);
      expect(result.tree.boundingBox?.width).toBe(51);
      expect(result.tree.boundingBox?.height).toBe(30);
    });
  });

  describe('baseline comparison', () => {
    it('should reduce node count compared to baseline', () => {
      const tree = createTestTree();

      // Baseline: no filters/optimizations
      const baselinePipeline = new SerializationPipeline(BASELINE_PIPELINE_CONFIG);
      const baselineResult = baselinePipeline.execute(tree);

      // Full pipeline: all optimizations
      const fullPipeline = new SerializationPipeline(DEFAULT_PIPELINE_CONFIG);
      const fullResult = fullPipeline.execute(tree);

      expect(fullResult.metrics.serializedNodes).toBeLessThan(baselineResult.metrics.serializedNodes);
    });

    it('should achieve measurable token reduction', () => {
      const tree = createTestTree();

      const pipeline = new SerializationPipeline();
      const result = pipeline.execute(tree);

      // Should achieve some token reduction
      expect(result.metrics.tokenReductionRate).toBeGreaterThan(0);
    });
  });

  describe('configuration', () => {
    it('should respect filter configuration flags', () => {
      const tree = createTestTree();

      // Disable all filters
      const config = {
        ...DEFAULT_PIPELINE_CONFIG,
        enableVisibilityFilter: false,
        enableTextNodeFilter: false,
        enableNoiseFilter: false,
        enableSemanticContainerFilter: false,
        enablePaintOrderFilter: false
      };

      const pipeline = new SerializationPipeline(config);
      const result = pipeline.execute(tree);

      // With filters disabled, script/style should remain
      const hasScript = JSON.stringify(result.tree).includes('SCRIPT');
      expect(hasScript).toBe(true);
    });
  });

  describe('metrics tracking', () => {
    it('should track stage durations', () => {
      const tree = createTestTree();
      const pipeline = new SerializationPipeline();

      const result = pipeline.execute(tree);

      expect(result.metrics.stage1TimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.stage2TimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.stage3TimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.serializationTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
