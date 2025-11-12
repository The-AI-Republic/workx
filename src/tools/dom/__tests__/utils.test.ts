import { describe, it, expect } from 'vitest';
import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT, NODE_TYPE_DOCUMENT_FRAGMENT } from '../types';
import { computeHeuristics, classifyNode, determineInteractionType, getTextContent } from '../utils';
import type { VirtualNode } from '../types';

describe('computeHeuristics', () => {
  it('should detect onclick handler', () => {
    const heuristics = computeHeuristics(['onclick', 'handleClick()']);
    expect(heuristics.hasOnClick).toBe(true);
    expect(heuristics.hasDataTestId).toBe(false);
  });

  it('should detect data-testid', () => {
    const heuristics = computeHeuristics(['data-testid', 'submit-button']);
    expect(heuristics.hasDataTestId).toBe(true);
    expect(heuristics.hasOnClick).toBe(false);
  });

  it('should detect cursor pointer', () => {
    const heuristics = computeHeuristics(['style', 'cursor: pointer; color: red']);
    expect(heuristics.hasCursorPointer).toBe(true);
  });

  it('should detect cursor pointer without spaces', () => {
    const heuristics = computeHeuristics(['style', 'cursor:pointer']);
    expect(heuristics.hasCursorPointer).toBe(true);
  });

  it('should detect role attribute', () => {
    const heuristics = computeHeuristics(['role', 'button']);
    expect(heuristics.isVisuallyInteractive).toBe(true);
  });

  it('should detect tabindex', () => {
    const heuristics = computeHeuristics(['tabindex', '0']);
    expect(heuristics.isVisuallyInteractive).toBe(true);
  });

  it('should handle empty attributes', () => {
    const heuristics = computeHeuristics([]);
    expect(heuristics.hasOnClick).toBe(false);
    expect(heuristics.hasDataTestId).toBe(false);
    expect(heuristics.hasCursorPointer).toBe(false);
    expect(heuristics.isVisuallyInteractive).toBe(false);
  });
});

describe('classifyNode', () => {
  it('should classify semantic node with proper role', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'button' } };
    const heuristics = { hasOnClick: false, hasDataTestId: false, hasCursorPointer: false, isVisuallyInteractive: false };

    const tier = classifyNode(cdpNode, axNode, heuristics);
    expect(tier).toBe('semantic');
  });

  it('should not classify generic role as semantic', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'generic' } };
    const heuristics = { hasOnClick: false, hasDataTestId: false, hasCursorPointer: false, isVisuallyInteractive: false };

    const tier = classifyNode(cdpNode, axNode, heuristics);
    expect(tier).toBe('structural');
  });

  it('should classify non-semantic with onclick', () => {
    const cdpNode = { localName: 'div' };
    const axNode = null;
    const heuristics = { hasOnClick: true, hasDataTestId: false, hasCursorPointer: false, isVisuallyInteractive: false };

    const tier = classifyNode(cdpNode, axNode, heuristics);
    expect(tier).toBe('non-semantic');
  });

  it('should classify non-semantic with data-testid', () => {
    const cdpNode = { localName: 'div' };
    const axNode = null;
    const heuristics = { hasOnClick: false, hasDataTestId: true, hasCursorPointer: false, isVisuallyInteractive: false };

    const tier = classifyNode(cdpNode, axNode, heuristics);
    expect(tier).toBe('non-semantic');
  });

  it('should classify structural node', () => {
    const cdpNode = { localName: 'div' };
    const axNode = null;
    const heuristics = { hasOnClick: false, hasDataTestId: false, hasCursorPointer: false, isVisuallyInteractive: false };

    const tier = classifyNode(cdpNode, axNode, heuristics);
    expect(tier).toBe('structural');
  });
});

describe('determineInteractionType', () => {
  it('should detect button role as click', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'button' } };

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('click');
  });

  it('should detect menuitem role as click', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'menuitem' } };

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('click');
  });

  it('should detect textbox role as input', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'textbox' } };

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('input');
  });

  it('should detect searchbox role as input', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'searchbox' } };

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('input');
  });

  it('should detect combobox role as select', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'combobox' } };

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('select');
  });

  it('should detect link role as link', () => {
    const cdpNode = { localName: 'div' };
    const axNode = { role: { value: 'link' } };

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('link');
  });

  it('should detect button tag as click', () => {
    const cdpNode = { localName: 'button', attributes: [] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('click');
  });

  it('should detect input tag as input', () => {
    const cdpNode = { localName: 'input', attributes: [] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('input');
  });

  it('should detect textarea tag as input', () => {
    const cdpNode = { localName: 'textarea', attributes: [] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('input');
  });

  it('should detect select tag as select', () => {
    const cdpNode = { localName: 'select', attributes: [] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('select');
  });

  it('should detect anchor tag as link', () => {
    const cdpNode = { localName: 'a', attributes: [] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('link');
  });

  it('should detect onclick as click', () => {
    const cdpNode = { localName: 'div', attributes: ['onclick', 'handleClick()'] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('click');
  });

  it('should detect cursor pointer as click', () => {
    const cdpNode = { localName: 'div', attributes: ['style', 'cursor: pointer'] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBe('click');
  });

  it('should return undefined for non-interactive element', () => {
    const cdpNode = { localName: 'div', attributes: [] };
    const axNode = null;

    const type = determineInteractionType(cdpNode, axNode);
    expect(type).toBeUndefined();
  });
});

describe('getTextContent', () => {
  it('should extract text from text node', () => {
    const node: VirtualNode = {
      nodeId: 1,
      backendNodeId: 100,
      nodeType: NODE_TYPE_TEXT,
      nodeName: '#text',
      nodeValue: '  Hello World  ',
      tier: 'structural'
    };

    const text = getTextContent(node);
    expect(text).toBe('Hello World');
  });

  it('should aggregate text from children', () => {
    const node: VirtualNode = {
      nodeId: 1,
      backendNodeId: 100,
      nodeType: NODE_TYPE_ELEMENT,
      nodeName: 'DIV',
      tier: 'structural',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: NODE_TYPE_TEXT,
          nodeName: '#text',
          nodeValue: 'Hello ',
          tier: 'structural'
        },
        {
          nodeId: 3,
          backendNodeId: 102,
          nodeType: NODE_TYPE_TEXT,
          nodeName: '#text',
          nodeValue: 'World',
          tier: 'structural'
        }
      ]
    };

    const text = getTextContent(node);
    expect(text).toBe('Hello World'); // Trimmed, single space between words
  });

  it('should limit text to 100 characters', () => {
    const longText = 'a'.repeat(150);
    const node: VirtualNode = {
      nodeId: 1,
      backendNodeId: 100,
      nodeType: NODE_TYPE_ELEMENT,
      nodeName: 'DIV',
      tier: 'structural',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: NODE_TYPE_TEXT,
          nodeName: '#text',
          nodeValue: longText,
          tier: 'structural'
        }
      ]
    };

    const text = getTextContent(node);
    expect(text!.length).toBeLessThanOrEqual(100);
  });

  it('should return undefined for empty content', () => {
    const node: VirtualNode = {
      nodeId: 1,
      backendNodeId: 100,
      nodeType: NODE_TYPE_ELEMENT,
      nodeName: 'DIV',
      tier: 'structural'
    };

    const text = getTextContent(node);
    expect(text).toBeUndefined();
  });
});
