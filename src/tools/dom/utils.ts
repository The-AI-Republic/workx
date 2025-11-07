import type { VirtualNode } from './types';
import { NODE_TYPE_TEXT } from './types';

/**
 * Helper utilities for DOM tool CDP implementation
 */

/**
 * Compute heuristics for interactive element detection
 */
export function computeHeuristics(attributes: string[] = []): NonNullable<VirtualNode['heuristics']> {
  const attrMap = new Map<string, string>();

  for (let i = 0; i < attributes.length; i += 2) {
    attrMap.set(attributes[i], attributes[i + 1]);
  }

  return {
    hasOnClick: attrMap.has('onclick'),
    hasDataTestId: attrMap.has('data-testid'),
    hasCursorPointer: attrMap.get('style')?.includes('cursor: pointer') || attrMap.get('style')?.includes('cursor:pointer') || false,
    isVisuallyInteractive: attrMap.has('role') || attrMap.has('tabindex')
  };
}

/**
 * Classify node into semantic, non-semantic, or structural tier
 */
export function classifyNode(
  cdpNode: any,
  axNode: any | null,
  heuristics?: VirtualNode['heuristics']
): 'semantic' | 'non-semantic' | 'structural' {
  // Has proper accessibility role - semantic
  if (axNode?.role?.value && axNode.role.value !== 'generic') {
    return 'semantic';
  }

  // Has heuristic markers - non-semantic interactive
  if (heuristics && (heuristics.hasOnClick || heuristics.hasDataTestId)) {
    return 'non-semantic';
  }

  // Everything else is structural
  return 'structural';
}

/**
 * Determine interaction type from node properties
 */
export function determineInteractionType(
  cdpNode: any,
  axNode: any | null
): 'click' | 'input' | 'select' | 'link' | undefined {
  const role = axNode?.role?.value;

  // Check accessibility role first
  if (role === 'button' || role === 'menuitem') return 'click';
  if (role === 'textbox' || role === 'searchbox') return 'input';
  if (role === 'combobox' || role === 'listbox') return 'select';
  if (role === 'link') return 'link';

  // Check HTML tag
  const tag = cdpNode.localName?.toLowerCase();
  if (tag === 'button') return 'click';
  if (tag === 'input' || tag === 'textarea') return 'input';
  if (tag === 'select') return 'select';
  if (tag === 'a') return 'link';

  // Check heuristics
  const attrs = cdpNode.attributes || [];
  const attrMap = new Map<string, string>();
  for (let i = 0; i < attrs.length; i += 2) {
    attrMap.set(attrs[i], attrs[i + 1]);
  }

  if (attrMap.has('onclick') || attrMap.get('style')?.includes('cursor: pointer')) {
    return 'click';
  }

  return undefined;
}

/**
 * Extract text content from node
 * Only returns text for actual text nodes, not aggregated from children
 */
export function getTextContent(node: VirtualNode): string | undefined {
  if (node.nodeType === NODE_TYPE_TEXT && node.nodeValue) {
    return node.nodeValue.trim();
  }

  return undefined;
}

/**
 * Detect JavaScript framework from DOM tree
 *
 * Heuristics:
 * - React: data-reactroot, data-reactid, _reactRootContainer, __reactContainer
 * - Vue: data-v-, __vue__, v-cloak
 * - Angular: ng-version, ng-app, _ngcontent-, _nghost-
 * - Svelte: svelte-
 */
export function detectFramework(root: VirtualNode): string | null {
  const search = (node: VirtualNode, depth: number = 0): string | null => {
    if (depth > 10) return null; // Limit search depth for performance

    // Check attributes
    if (node.attributes) {
      const attrs = node.attributes.join(' ');

      // React detection
      if (attrs.includes('data-reactroot') || attrs.includes('data-reactid')) {
        return 'react';
      }

      // Vue detection
      if (attrs.includes('data-v-') || attrs.includes('v-cloak')) {
        return 'vue';
      }

      // Angular detection
      if (attrs.includes('ng-version') || attrs.includes('ng-app') ||
          attrs.includes('_ngcontent-') || attrs.includes('_nghost-')) {
        return 'angular';
      }

      // Svelte detection
      if (attrs.includes('svelte-')) {
        return 'svelte';
      }
    }

    // Recurse to children
    if (node.children) {
      for (const child of node.children) {
        const result = search(child, depth + 1);
        if (result) return result;
      }
    }

    return null;
  };

  return search(root);
}
