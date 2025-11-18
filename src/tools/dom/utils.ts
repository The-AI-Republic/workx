import type { VirtualNode, SerializedNode, LayoutData } from './types';
import { NODE_TYPE_TEXT } from './types';

/**
 * Helper utilities for DOM tool CDP implementation
 */

/**
 * Check if element is vertically scrollable
 * Requires scroll height > client height AND overflow-y allows scrolling
 */
export function isVerticallyScrollable(
  scrollRects?: { width: number; height: number },
  clientRects?: { width: number; height: number },
  computedStyle?: { overflowY?: string }
): boolean {
  if (!scrollRects || !clientRects) {
    return false;
  }

  const hasOverflow = scrollRects.height > clientRects.height;
  if (!hasOverflow) {
    return false;
  }

  const overflowY = computedStyle?.overflowY;
  return overflowY === 'auto' || overflowY === 'scroll';
}

/**
 * Check if element is horizontally scrollable
 * Requires scroll width > client width AND overflow-x allows scrolling
 */
export function isHorizontallyScrollable(
  scrollRects?: { width: number; height: number },
  clientRects?: { width: number; height: number },
  computedStyle?: { overflowX?: string }
): boolean {
  if (!scrollRects || !clientRects) {
    return false;
  }

  const hasOverflow = scrollRects.width > clientRects.width;
  if (!hasOverflow) {
    return false;
  }

  const overflowX = computedStyle?.overflowX;
  return overflowX === 'auto' || overflowX === 'scroll';
}

/**
 * Compute scrollable direction from layout data
 * Returns 'vertical', 'horizontal', 'both', or undefined
 */
export function computeScrollable(
  layoutData?: LayoutData
): 'vertical' | 'horizontal' | 'both' | undefined {
  if (!layoutData?.scrollRects || !layoutData?.clientRects) {
    return undefined;
  }

  const isVertical = isVerticallyScrollable(
    layoutData.scrollRects,
    layoutData.clientRects,
    layoutData.computedStyle
  );
  const isHorizontal = isHorizontallyScrollable(
    layoutData.scrollRects,
    layoutData.clientRects,
    layoutData.computedStyle
  );

  if (isVertical && isHorizontal) return 'both';
  if (isVertical) return 'vertical';
  if (isHorizontal) return 'horizontal';
  return undefined;
}

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

/**
 * Convert SerializedNode tree back to HTML string
 *
 * This function reconstructs HTML from the serialized DOM representation,
 * including attributes derived from the SerializedNode fields.
 *
 * @param node - The serialized node to convert
 * @param indent - Current indentation level (for pretty printing)
 * @returns HTML string representation
 */
export function serializedNodeToHtml(node: SerializedNode | null, indent: number = 0): string {
  if (!node) return '';

  const indentStr = '  '.repeat(indent);
  const tag = node.tag;

  // Handle text nodes specially - render inline without wrapper tags
  if (tag === '#text') {
    return node.text ? escapeHtml(node.text) : '';
  }

  // Self-closing tags
  const selfClosingTags = ['input', 'img', 'br', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'];
  const isSelfClosing = selfClosingTags.includes(tag);

  // Build attributes from SerializedNode fields
  const attributes: string[] = [];

  // Add node_id as id attribute for reference
  attributes.push(`id="${node.node_id}"`);

  // Add role if present
  if (node.role) {
    attributes.push(`role="${escapeHtml(node.role)}"`);
  }

  // Add aria-label if present
  if (node.aria_label) {
    attributes.push(`aria-label="${escapeHtml(node.aria_label)}"`);
  }

  // Add href for links
  if (node.href) {
    attributes.push(`href="${escapeHtml(node.href)}"`);
  }

  // Add input type
  if (node.input_type) {
    attributes.push(`type="${escapeHtml(node.input_type)}"`);
  }

  // Add placeholder/hint
  if (node.hint) {
    attributes.push(`placeholder="${escapeHtml(node.hint)}"`);
  }

  // Add value for form inputs
  if (node.value !== undefined) {
    attributes.push(`value="${escapeHtml(node.value)}"`);
  }

  // Add data-testid from testid field
  if (node.testid) {
    attributes.push(`data-testid="${escapeHtml(node.testid)}"`);
  }

  // Add states as attributes
  if (node.states) {
    for (const [key, value] of Object.entries(node.states)) {
      if (typeof value === 'boolean') {
        if (value) {
          attributes.push(key); // Boolean attributes (e.g., disabled, checked)
        }
      } else {
        attributes.push(`${key}="${escapeHtml(String(value))}"`);
      }
    }
  }

  // Add bounding box as data attribute (for debugging/reference)
  if (node.bbox) {
    attributes.push(`data-bbox="${node.bbox.join(',')}"`);
  }

  // Build opening tag
  const attrStr = attributes.length > 0 ? ' ' + attributes.join(' ') : '';
  let html = `${indentStr}<${tag}${attrStr}`;

  if (isSelfClosing) {
    html += ' />\n';
    return html;
  }

  html += '>';

  // Add text content if present (inline, no newline)
  if (node.text) {
    html += escapeHtml(node.text);
  }

  // Process children
  if (node.kids && node.kids.length > 0) {
    // If we have text content, don't add newlines (keep inline)
    if (!node.text) {
      html += '\n';
    }

    for (const child of node.kids) {
      const childHtml = serializedNodeToHtml(child, node.text ? 0 : indent + 1);
      html += childHtml;
    }

    // Closing tag indentation
    if (!node.text) {
      html += indentStr;
    }
  } else if (node.text) {
    // Text content already added, no indentation needed
  } else {
    // Empty element, no newline before closing tag
  }

  // not include closing tag for token efficiency
  html += `</${tag}>\n`;

  return html;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const htmlEscapeMap: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  return text.replace(/[&<>"']/g, (char) => htmlEscapeMap[char]);
}
