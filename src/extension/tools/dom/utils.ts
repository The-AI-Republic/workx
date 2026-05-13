import type { VirtualNode, SerializedNode, LayoutData, ParsedNodeId } from './types';
import { NODE_TYPE_TEXT } from './types';

/**
 * Parse a node ID string into frameId and backendNodeId
 *
 * Supports formats:
 * - "1:42" → { frameId: 1, backendNodeId: 42 }
 * - "0:42" → { frameId: 0, backendNodeId: 42 }
 * - "42" or 42 → { frameId: 0, backendNodeId: 42 } (backward compatible)
 * - "-1" → { frameId: 0, backendNodeId: -1 } (main frame scroll target)
 * - "1:-1" → { frameId: 1, backendNodeId: -1 } (iframe scroll target)
 *
 * @param input - Node ID as string or number
 * @returns Parsed node ID with frameId and backendNodeId
 * @throws Error if input format is invalid
 */
export function parseNodeId(input: string | number): ParsedNodeId {
  // Handle numeric input (backward compatibility)
  if (typeof input === 'number') {
    return { frameId: 0, backendNodeId: input };
  }

  const str = String(input).trim();

  // Handle bare number format (backward compatibility)
  if (!str.includes(':')) {
    const backendNodeId = parseInt(str, 10);
    if (isNaN(backendNodeId)) {
      throw new Error(`Invalid node ID format: "${input}"`);
    }
    return { frameId: 0, backendNodeId };
  }

  // Handle frame-scoped format "frameId:backendNodeId"
  const parts = str.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid node ID format: "${input}"`);
  }

  const frameId = parseInt(parts[0], 10);
  const backendNodeId = parseInt(parts[1], 10);

  if (isNaN(frameId) || isNaN(backendNodeId)) {
    throw new Error(`Invalid node ID format: "${input}"`);
  }

  if (frameId < 0 || frameId > 5) {
    throw new Error(`Frame ID out of range (0-5): ${frameId}`);
  }

  return { frameId, backendNodeId };
}

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
  const overflowY = computedStyle?.overflowY;
  if (overflowY == 'auto' || overflowY == 'scroll') {
    return true;
  }

  if (!scrollRects || !clientRects) {
    return false;
  }

  return scrollRects.height > clientRects.height;
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
  const overflowX = computedStyle?.overflowX;
  if (overflowX == 'auto' || overflowX == 'scroll') {
    return true;
  }

  if (!scrollRects || !clientRects) {
    return false;
  }

  return scrollRects.width > clientRects.width;
}

/**
 * Compute scrollable direction from layout data
 * Returns 'vertical', 'horizontal', 'vertical and horizontal', or undefined
 */
export function computeScrollable(
  layoutData?: LayoutData
): 'vertical' | 'horizontal' | 'vertical and horizontal' | undefined {
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

  if (isVertical && isHorizontal) return 'vertical and horizontal';
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
 *
 * Classification priority:
 * 1. Accessibility role (semantic) - highest priority
 * 2. HTML tag semantics (semantic/non-semantic) - fallback when no a11y data
 * 3. Heuristic markers (non-semantic) - onclick, data-testid
 * 4. Default (structural) - everything else
 *
 * @param axNode - Accessibility node from CDP Accessibility.getFullAXTree
 * @param heuristics - Computed heuristics from element attributes
 * @param cdpNode - Optional CDP DOM node for HTML tag fallback (used when axNode unavailable)
 */
export function classifyNode(
  axNode: any | null,
  heuristics?: VirtualNode['heuristics'],
  cdpNode?: any
): 'semantic' | 'non-semantic' | 'structural' {
  // Priority 0: Text nodes (nodeType 3) are semantic - they contain the actual content
  if (cdpNode?.nodeType === 3) {
    return 'semantic';
  }

  // Priority 1: Has proper accessibility role - semantic
  if (axNode?.role?.value && axNode.role.value !== 'generic' && axNode.role.value !== 'none' && axNode?.ignored !== true) {
    return 'semantic';
  }

  // Priority 2: HTML tag fallback when accessibility data is unavailable
  // This is critical for iframe elements where Accessibility.getFullAXTree may not return data
  if (!axNode && cdpNode) {
    const tag = (cdpNode.localName || cdpNode.nodeName || '').toLowerCase();
    const attributes = cdpNode.attributes || [];

    // Build attribute map for checking specific conditions
    const attrMap = new Map<string, string>();
    for (let i = 0; i < attributes.length; i += 2) {
      attrMap.set(attributes[i], attributes[i + 1]);
    }

    // Inherently semantic/interactive HTML elements
    // These elements have implicit ARIA roles and are always interactive
    const semanticTags = new Set([
      'button',    // role: button
      'input',     // role: textbox/checkbox/radio/etc based on type
      'select',    // role: combobox/listbox
      'textarea',  // role: textbox
      'option',    // role: option
      'optgroup',  // role: group
      'details',   // role: group (disclosure widget)
      'summary',   // role: button (disclosure trigger)
      'dialog',    // role: dialog
      'menu',      // role: menu
      'menuitem',  // role: menuitem
      'meter',     // role: meter
      'progress',  // role: progressbar
      'output',    // role: status
    ]);

    // Elements that are semantic only with certain attributes
    // <a> is only a link if it has href
    // <area> is only clickable if it has href
    if (tag === 'a' && attrMap.has('href')) {
      return 'semantic';
    }
    if (tag === 'area' && attrMap.has('href')) {
      return 'semantic';
    }

    // Elements with explicit role attribute
    if (attrMap.has('role')) {
      const role = attrMap.get('role');
      if (role && role !== 'none' && role !== 'presentation' && role !== 'generic') {
        return 'semantic';
      }
    }

    // Inherently semantic tags
    if (semanticTags.has(tag)) {
      return 'semantic';
    }

    // Elements with tabindex are focusable and thus interactive
    if (attrMap.has('tabindex')) {
      const tabindex = attrMap.get('tabindex');
      // tabindex >= 0 means focusable
      if (tabindex && parseInt(tabindex, 10) >= 0) {
        return 'non-semantic';
      }
    }

    // Contenteditable elements are interactive
    if (attrMap.get('contenteditable') === 'true' || attrMap.get('contenteditable') === '') {
      return 'non-semantic';
    }
  }

  // Priority 3: Has heuristic markers - non-semantic interactive
  if (heuristics && (heuristics.hasOnClick || heuristics.hasDataTestId)) {
    return 'non-semantic';
  }

  // Priority 4: Everything else is structural
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

  // Add aria-label if present (with scrollable appended if available)
  if (node.aria_label) {
    let ariaLabel = node.aria_label;
    if (node.scrollable !== undefined) {
      ariaLabel += ` | scrollable: ${node.scrollable}`;
    }
    attributes.push(`aria-label="${escapeHtml(ariaLabel)}"`);
  } else if (node.scrollable !== undefined) {
    // Add aria-label with just scrollable info if no existing aria-label
    attributes.push(`aria-label="scrollable: ${node.scrollable}"`);
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

  // Add data-frame-id for iframe elements to indicate which frame the content belongs to
  if (tag === 'iframe' && node.content_document) {
    // Extract frame ID from the first child's node_id (format: "frameId:backendNodeId")
    const contentFrameId = node.content_document.frame_id;
    if (contentFrameId !== undefined && contentFrameId > 0) {
      attributes.push(`data-frame-id="${contentFrameId}"`);
    }
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
  } else if (node.content_document) {
    // Process iframe content document
    html += '\n';
    const contentHtml = serializedNodeToHtml(node.content_document, indent + 1);
    html += contentHtml;
    html += indentStr;
  } else if (node.shadow_roots && node.shadow_roots.length > 0) {
    // Process shadow roots
    html += '\n';
    for (const shadowRoot of node.shadow_roots) {
      const shadowHtml = serializedNodeToHtml(shadowRoot, indent + 1);
      html += shadowHtml;
    }
    html += indentStr;
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
