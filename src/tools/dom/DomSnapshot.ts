import type {
  DomSnapshot as IDomSnapshot,
  VirtualNode,
  RawSerializedDom,
  SerializedNode,
  SnapshotStats,
  PageContext,
  FrameMetadata
} from './types';
import type { SerializationOptions } from '../../types/domTool';
import { getTextContent, serializedNodeToHtml } from './utils';
import { SerializationPipeline } from './serializers/SerializationPipeline';
import { DEFAULT_SERIALIZATION_OPTIONS } from '../../types/domTool';
import type { ViewportBounds } from '../screenshot/ViewportDetector';

/**
 * Registry for managing frame metadata in multi-frame DOM snapshots
 * Supports main frame (0) and up to 5 iframes (1-5)
 */
export class FrameRegistry {
  private frames: Map<number, FrameMetadata> = new Map();

  /**
   * Register a frame with its metadata
   */
  addFrame(metadata: FrameMetadata): void {
    if (metadata.frameId < 0 || metadata.frameId > 5) {
      throw new Error(`Frame ID out of range (0-5): ${metadata.frameId}`);
    }
    this.frames.set(metadata.frameId, metadata);
  }

  /**
   * Get frame metadata by frameId
   */
  getFrame(frameId: number): FrameMetadata | undefined {
    return this.frames.get(frameId);
  }

  /**
   * Check if a frame exists
   */
  hasFrame(frameId: number): boolean {
    return this.frames.has(frameId);
  }

  /**
   * Get count of iframes (excluding main frame)
   */
  getIframeCount(): number {
    return Math.max(0, this.frames.size - 1); // Subtract main frame
  }

  /**
   * Get all registered frames
   */
  getAllFrames(): FrameMetadata[] {
    return Array.from(this.frames.values());
  }

  /**
   * Get next available iframe ID (1-5)
   * Returns null if max iframes reached
   */
  getNextIframeId(): number | null {
    for (let i = 1; i <= 5; i++) {
      if (!this.frames.has(i)) {
        return i;
      }
    }
    return null; // Max 5 iframes reached
  }
}

export class DomSnapshot implements IDomSnapshot {
  readonly virtualDom: VirtualNode;
  readonly timestamp: Date;
  readonly pageContext: PageContext;
  readonly stats: SnapshotStats;
  readonly frameRegistry: FrameRegistry;

  private _backendNodeMap?: Map<number, VirtualNode[]>;
  private _serialized?: RawSerializedDom;

  constructor(
    virtualDom: VirtualNode,
    pageContext: PageContext,
    stats: SnapshotStats,
    frameRegistry?: FrameRegistry
  ) {
    this.virtualDom = virtualDom;
    this.pageContext = pageContext;
    this.stats = stats;
    this.timestamp = new Date();

    // Initialize frame registry with main frame if not provided
    this.frameRegistry = frameRegistry || new FrameRegistry();
    if (!this.frameRegistry.hasFrame(0)) {
      // Register main frame with viewport dimensions
      this.frameRegistry.addFrame({
        frameId: 0,
        backendNodeId: 0, // Main frame has no iframe element
        viewport: {
          width: pageContext.viewport.width,
          height: pageContext.viewport.height,
          scrollX: pageContext.viewport.scrollX ?? 0,
          scrollY: pageContext.viewport.scrollY ?? 0
        }
        // No boundingBox for main frame
      });
    }
  }


  /**
   * Build a flat map of backendNodeId -> VirtualNode[] for quick lookups
   * Since backendNodeIds are NOT unique across iframes, we store arrays of nodes
   */
  private buildBackendNodeMap(): Map<number, VirtualNode[]> {
    if (this._backendNodeMap) return this._backendNodeMap;

    this._backendNodeMap = new Map();
    const traverse = (node: VirtualNode) => {
      const existing = this._backendNodeMap!.get(node.backendNodeId);
      if (existing) {
        existing.push(node);
      } else {
        this._backendNodeMap!.set(node.backendNodeId, [node]);
      }
      if (node.children) {
        node.children.forEach(traverse);
      }
      if (node.shadowRoots) {
        node.shadowRoots.forEach(traverse);
      }
      if (node.contentDocument) {
        traverse(node.contentDocument);
      }
    };
    traverse(this.virtualDom);
    return this._backendNodeMap;
  }

  /**
   * Get VirtualNode by backendNodeId (stable ID used in serialization)
   * Note: This returns the first match found. For frame-aware lookup, use resolveNodeByBackendIdAndFrame()
   */
  getNodeByBackendId(backendNodeId: number): VirtualNode | null {
    const nodes = this.buildBackendNodeMap().get(backendNodeId);
    return nodes?.[0] ?? null;
  }

  /**
   * Get ALL VirtualNodes with the given backendNodeId
   * backendNodeIds are NOT unique across iframes, so multiple nodes may match
   * @returns Array of matching nodes with their frame information
   */
  getAllNodesByBackendId(backendNodeId: number): VirtualNode[] {
    return this.buildBackendNodeMap().get(backendNodeId) ?? [];
  }

  /**
   * Resolve node by backendNodeId with frame-aware disambiguation
   *
   * Logic:
   * 1. Search for all nodes with the given backendNodeId
   * 2. If exactly one match found, return it (even if frameId doesn't match)
   * 3. If multiple matches found, filter by frameId
   * 4. If no matches after filtering, return null
   *
   * @param backendNodeId - The backend node ID to search for
   * @param frameId - The frame ID to use for disambiguation (0-5)
   * @returns The resolved VirtualNode or null if not found
   */
  resolveNodeByBackendIdAndFrame(backendNodeId: number, frameId: number): VirtualNode | null {
    const matches = this.getAllNodesByBackendId(backendNodeId);

    if (matches.length === 0) {
      return null;
    }

    if (matches.length === 1) {
      // Single match - use it regardless of frameId
      const node = matches[0];
      if (node.frameIndex !== undefined && node.frameIndex !== frameId) {
        console.warn(`[DomSnapshot] Node ${backendNodeId} found in frame ${node.frameIndex}, but frameId ${frameId} was specified. Using found node.`);
      }
      return node;
    }

    // Multiple matches - filter by frameId
    const frameMatches = matches.filter(node => node.frameIndex === frameId);

    if (frameMatches.length === 1) {
      return frameMatches[0];
    }

    if (frameMatches.length === 0) {
      console.warn(`[DomSnapshot] Multiple nodes found with backendNodeId ${backendNodeId} but none in frame ${frameId}. Found in frames: ${matches.map(n => n.frameIndex).join(', ')}`);
      // Fall back to first match
      return matches[0];
    }

    // Multiple matches even after frame filtering (shouldn't happen but handle gracefully)
    console.warn(`[DomSnapshot] Multiple nodes with same backendNodeId ${backendNodeId} in frame ${frameId}. Using first match.`);
    return frameMatches[0];
  }


  isStale(maxAgeMs: number = 180000): boolean { // Default 3 minutes
    return Date.now() - this.timestamp.getTime() > maxAgeMs;
  }

  getStats(): SnapshotStats {
    return { ...this.stats };
  }

  serialize(options?: SerializationOptions): RawSerializedDom {
    if (this._serialized) {
      return this._serialized;
    }

    const start = Date.now();

    // Merge with defaults
    const opts = {
      ...DEFAULT_SERIALIZATION_OPTIONS,
      ...options,
      // Deep merge metadata options
      metadata: {
        ...DEFAULT_SERIALIZATION_OPTIONS.metadata,
        ...options?.metadata
      }
    };

    // Ddebug log
    // test>>
    console.log(`[DomSnapshot] $$$ virtual dom before serializing: ${JSON.stringify(this.virtualDom, null, 2)}`);
    // test<<


    // Use SerializationPipeline for compaction
    // virtualDom is typically #document with html as child, or html directly
    const pipeline = new SerializationPipeline();
    const result = pipeline.execute(this.virtualDom);
    // test>>
    console.log(`[DomSnapshot] $$$ virtual dom after pipeline: ${JSON.stringify(result, null, 2)}`);
    // test<<

    // Build flattened tree structure from pipeline result with v3 schema
    const htmlBeforeFilter = this.flatternNode(result.tree, opts);
    // test>>
    console.log(`[DomSnapshot] $$$ html after flattening: ${JSON.stringify(htmlBeforeFilter, null, 2)}`);
    // test<<

    // Apply viewport filtering to only include visible nodes
    let body = this.filterByViewport(htmlBeforeFilter);
    // test>>
    console.log(`[DomSnapshot] $$$ body after viewport filtering: ${JSON.stringify(body, null, 2)}`);
    // test<<

    // Fallback if body is null (shouldn't happen but prevents crashes)
    if (!body) {
      console.error('[DomSnapshot] filterByViewport returned null, using htmlBeforeFilter as fallback');
      body = htmlBeforeFilter;
    }

    // Calculate viewport overflow (pixels outside viewport in each direction)
    const viewport = this.pageContext.viewport;
    const scrollX = viewport.scrollX ?? 0;
    const scrollY = viewport.scrollY ?? 0;
    const pageWidth = viewport.pageWidth ?? viewport.width;
    const pageHeight = viewport.pageHeight ?? viewport.height;

    const overflowTop = scrollY;
    const overflowBottom = Math.max(0, pageHeight - viewport.height - scrollY);
    const overflowLeft = scrollX;
    const overflowRight = Math.max(0, pageWidth - viewport.width - scrollX);

    // Build v3 RawSerializedDom with normalized field names (will be stringified in DomService)
    this._serialized = {
      page: {
        context: {
          url: this.pageContext.url,
          title: this.pageContext.title,
          viewport: {
            width: viewport.width,
            height: viewport.height,
            overflowTop,
            overflowBottom,
            overflowLeft,
            overflowRight
          }
        },
        body: body!
        // Note: Collection-level states from MetadataBucketer would go here
        // This is deferred to future optimization as it requires refactoring
        // the serialization to separate node data from state data
      }
    };

    this.stats.serializationDuration = Date.now() - start;

    return this._serialized;
  }

  /**
   * Flatten VirtualNode tree to v3 SerializedNode with normalized field names
   *
   * Node preservation rules:
   * - Semantic/non-semantic nodes (Tier 1 & 2): Always kept
   * - Semantic containers (form, table, dialog, navigation, main): Always kept
   * - Scrollable containers: Always kept (enable scroll actions)
   * - Structural nodes with children: Hoisted if single child, kept as grouping if multiple
   * - Leaf structural nodes: Discarded
   *
   * Normalized field mappings:
   * - aria-label → aria_label
   * - children → kids
   * - placeholder → hint
   * - inputType → input_type
   * - boundingBox → bbox (as [x, y, w, h] array)
   * - node IDs → sequential IDs via IdRemapper
   */
  private flatternNode(node: VirtualNode, opts: Required<SerializationOptions>): SerializedNode {
    const tag = node.localName || node.nodeName.toLowerCase();
    const frameIndex = node.frameIndex ?? 0;

    // Special Case: Handle #document node - skip it and process its html child directly
    // DOM.getDocument returns #document as root, with html as its child
    if (tag === '#document') {
      // Find the html child and process it
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          const childTag = (child.localName || child.nodeName || '').toLowerCase();
          if (childTag === 'html') {
            return this.flatternNode(child, opts);
          }
        }
        // If no html found, process first child
        return this.flatternNode(node.children[0], opts);
      }
      // Empty document - shouldn't happen but handle gracefully
      return {
        node_id: `${frameIndex}:${node.backendNodeId}`,
        frame_id: frameIndex,
        tag: 'html',
        scrollable: 'vertical'
      };
    }

    // Special Case: Handle <head> tag - keep empty tag, remove all children
    // This reduces token usage while maintaining document structure
    if (tag === 'head') {
      return {
        node_id: `${frameIndex}:${node.backendNodeId}`,
        frame_id: frameIndex,
        tag: 'head'
        // No kids - intentionally empty
      };
    }

    // Special Case: Handle <html> tag - always mark as scrollable for page scroll
    // This enables LLM to scroll the page by targeting the html element
    if (tag === 'html') {
      return this.buildHtmlNode(node, opts);
    }

    // Case 1: Keep semantic and non-semantic nodes (Tier 1 & 2)
    // But only if they have actual rendering data (not ghost elements from virtual scrolling)
    if (this.isSemanticNode(node)) {
      // Filter out "ghost" semantic nodes - nodes that have tier=semantic based on HTML attributes
      // but no actual rendering data from CDP (common in virtualized lists like Gmail)
      if (!this.hasRenderingData(node)) {
        // Treat as structural node - will be processed in Case 3 (hoist children)
        // This allows any visible children to bubble up
      } else {
        return this.buildSerializedNode(node, opts);
      }
    }

    // Case 2: Keep semantic containers (form, table, dialog, navigation, main)
    if (this.isSemanticContainer(node)) {
      // For containers, create minimal options with no metadata
      const minimalOpts = { ...opts, metadata: DEFAULT_SERIALIZATION_OPTIONS.metadata };
      return this.buildSerializedNode(node, minimalOpts);
    }

    // Case 2.5: Keep scrollable containers - they enable scroll actions
    if (node.scrollable) {
      return this.buildSerializedNode(node, opts);
    }

    // Case 2.6: Keep nodes with shadow roots or content documents (iframes)
    // These act as containers for nested content trees
    if ((node.shadowRoots && node.shadowRoots.length > 0) || node.contentDocument) {
      return this.buildSerializedNode(node, opts);
    }

    // Case 3: Structural node with children - hoist children to parent level
    if (node.children && node.children.length > 0) {
      const flattenedChildren = node.children
        .map(child => this.flatternNode(child, opts))
        .filter((child): child is SerializedNode => child !== null);

      // If only one child, return it directly (hoist)
      // Exception: Don't hoist if this node is a structural root we want to preserve
      const isStructuralRoot = ['html', 'body'].includes(tag);

      if (flattenedChildren.length === 1 && !isStructuralRoot) {
        return flattenedChildren[0];
      }

      // If multiple children (OR single child that wasn't hoisted), return structural node
      if (flattenedChildren.length > 0) {
        const structuralNode: SerializedNode = {
          node_id: `${frameIndex}:${node.backendNodeId}`,
          frame_id: frameIndex,
          tag,
          kids: flattenedChildren
        };
        // Preserve scrollable property for scroll targets
        if (node.scrollable) {
          structuralNode.scrollable = node.scrollable;
        }
        return structuralNode;
      }

      // FIX: If all children were filtered out (flattenedChildren.length === 0),
      // preserve structural root/body nodes as placeholders to prevent tree collapse
      if (flattenedChildren.length === 0) {
        // Only preserve critical structural nodes when empty (body, main)
        if (tag === 'body' || tag === 'main') {
          console.warn(`[DomSnapshot] All children filtered out for <${tag}>. Returning placeholder node.`);
          return {
            node_id: `${frameIndex}:${node.backendNodeId}`,
            frame_id: frameIndex,
            tag,
            kids: [] // Empty kids array to indicate no interactive elements found
          };
        }
        // For other structural nodes with no children after filtering, discard them
        return null as any;
      }
    }

    // Case 4: Leaf structural node with no children - discard
    return null as any;
  }

  /**
   * Build html node with scrollable property always set
   * The html tag serves as the primary scroll target for the page
   */
  private buildHtmlNode(node: VirtualNode, opts: Required<SerializationOptions>): SerializedNode {
    const frameIndex = node.frameIndex ?? 0;

    // Process children (should be head and body)
    const flattenedChildren = node.children
      ? node.children
        .map(child => this.flatternNode(child, opts))
        .filter((child): child is SerializedNode => child !== null)
      : [];

    const htmlNode: SerializedNode = {
      node_id: `${frameIndex}:${node.backendNodeId}`,
      frame_id: frameIndex,
      tag: 'html',
      // Always mark html as vertically scrollable - this is the main page scroll target
      scrollable: 'vertical',
      // Mark html as always in viewport - it's the document root and contains all visible content
      // This ensures filterByViewport preserves all children
      inViewport: true,
      kids: flattenedChildren.length > 0 ? flattenedChildren : undefined
    };

    return htmlNode;
  }

  /**
   * Build SerializedNode with v3 schema (normalized field names)
   */
  private buildSerializedNode(node: VirtualNode, opts: Required<SerializationOptions>): SerializedNode {
    // Get attributes for metadata extraction
    const attrMap = new Map<string, string>();
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        attrMap.set(node.attributes[i], node.attributes[i + 1]);
      }
    }

    // Determine frame index (default to 0 for main frame)
    const frameIndex = node.frameIndex ?? 0;

    // Build base node with v3 field names
    // Format node_id as "<frameId>:<backendNodeId>" for multi-frame support
    const serializedNode: SerializedNode = {
      node_id: `${frameIndex}:${node.backendNodeId}`,
      frame_id: frameIndex,
      tag: node.localName || node.nodeName.toLowerCase()
    };

    // Add role if available (exclude "none" values)
    if (node.accessibility?.role && node.accessibility.role !== 'none') {
      serializedNode.role = node.accessibility.role;
    }

    // Determine if we should include metadata (check any fine-grained flag)
    const shouldIncludeMetadata =
      opts.metadata.includeAriaLabel ||
      opts.metadata.includeText ||
      opts.metadata.includeValue ||
      opts.metadata.includeInputType ||
      opts.metadata.includeHint ||
      opts.metadata.includeBbox ||
      opts.metadata.includeStates ||
      opts.metadata.includeHref;

    // Add metadata based on configuration
    if (shouldIncludeMetadata) {
      // aria_label (normalized from aria-label)
      if (opts.metadata.includeAriaLabel && node.accessibility?.name) {
        serializedNode.aria_label = node.accessibility.name;
      }

      // Text content
      if (opts.metadata.includeText) {
        const text = getTextContent(node);
        if (text) {
          serializedNode.text = text;
        }
      }

      // Value (for inputs)
      if ((opts.metadata.includeValue || opts.includeValues) &&
        typeof node.accessibility?.value === 'string') {
        serializedNode.value = node.accessibility.value;
      }

      // Link href
      if (opts.metadata.includeHref && attrMap.has('href')) {
        serializedNode.href = attrMap.get('href');
      }

      // input_type (normalized from inputType)
      if (opts.metadata.includeInputType && attrMap.has('type')) {
        serializedNode.input_type = attrMap.get('type');
      }

      // hint (normalized from placeholder)
      if (opts.metadata.includeHint && attrMap.has('placeholder')) {
        serializedNode.hint = attrMap.get('placeholder');
      }

      // testid (extracted from data-testid attribute)
      if (attrMap.has('data-testid')) {
        serializedNode.testid = attrMap.get('data-testid');
      }

      // bbox (compact array format [x, y, w, h])
      if (opts.metadata.includeBbox && node.boundingBox) {
        serializedNode.bbox = [
          Math.round(node.boundingBox.x),
          Math.round(node.boundingBox.y),
          Math.round(node.boundingBox.width),
          Math.round(node.boundingBox.height)
        ];
      }

      // inViewport (calculate from boundingBox and viewport bounds)
      if (node.boundingBox) {
        serializedNode.inViewport = this.calculateInViewport(node.boundingBox);
      }

      // scrollable (for LLM to identify scroll targets)
      if (node.scrollable) {
        serializedNode.scrollable = node.scrollable;
      }

      // Build states object from accessibility info
      if (opts.metadata.includeStates) {
        const states: Record<string, boolean | string> = {};
        if (node.accessibility?.disabled !== undefined) states.disabled = node.accessibility.disabled;
        if (node.accessibility?.checked !== undefined) states.checked = node.accessibility.checked;
        if (node.accessibility?.required !== undefined) states.required = node.accessibility.required;
        if (node.accessibility?.expanded !== undefined) states.expanded = node.accessibility.expanded;

        if (Object.keys(states).length > 0) {
          serializedNode.states = states;
        }
      }
    }

    // Recursively flatten children (with v3 field name: kids)
    if (node.children && node.children.length > 0) {
      const flattenedChildren = node.children
        .map(child => this.flatternNode(child, opts))
        .filter((child): child is SerializedNode => child !== null);

      if (flattenedChildren.length > 0) {
        serializedNode.kids = flattenedChildren; // v3: kids instead of children
      }
    }

    // Recursively flatten shadow roots
    if (node.shadowRoots && node.shadowRoots.length > 0) {
      const flattenedShadowRoots = node.shadowRoots
        .map(root => this.flatternNode(root, opts))
        .filter((root): root is SerializedNode => root !== null);

      if (flattenedShadowRoots.length > 0) {
        serializedNode.shadow_roots = flattenedShadowRoots;
      }
    }

    // Recursively flatten content document (iframe)
    if (node.contentDocument) {
      const flattenedContentDoc = this.flatternNode(node.contentDocument, opts);
      if (flattenedContentDoc) {
        serializedNode.content_document = flattenedContentDoc;
      }
    }

    return serializedNode;
  }

  /**
   * Calculate if element is in viewport (>50% visibility threshold)
   *
   * NOTE: All coordinates use CSS pixels (web standard).
   * - boundingBox: Normalized from CDP device pixels to CSS pixels in DomService
   * - viewport dimensions: CSS pixels from window.innerWidth/innerHeight
   *
   * Edge cases:
   * - Elements exactly 50% visible return false (strict > 50% threshold)
   * - Large elements (e.g., backgrounds) extending beyond viewport may return false
   *   if less than 50% is visible, even if they cover the entire viewport
   * - Zero-size elements always return false
   * - Elements completely outside viewport return false
   */
  private calculateInViewport(boundingBox: { x: number; y: number; width: number; height: number }): boolean {
    const viewport = this.pageContext.viewport;

    // Validate inputs
    if (!boundingBox || boundingBox.width == null || boundingBox.height == null) {
      console.warn('[DomSnapshot] Invalid boundingBox passed to calculateInViewport');
      return false;
    }

    // Handle zero-size elements
    if (boundingBox.width === 0 || boundingBox.height === 0) {
      return false;
    }

    // All values are in CSS pixels (standard web measurements)
    const scrollX = viewport.scrollX ?? 0;
    const scrollY = viewport.scrollY ?? 0;

    // Convert element coordinates to viewport coordinates (both in CSS pixels)
    const elemLeft = boundingBox.x - scrollX;
    const elemTop = boundingBox.y - scrollY;
    const elemRight = elemLeft + boundingBox.width;
    const elemBottom = elemTop + boundingBox.height;

    // Calculate intersection with viewport bounds (in CSS pixels)
    const intersectLeft = Math.max(elemLeft, 0);
    const intersectTop = Math.max(elemTop, 0);
    const intersectRight = Math.min(elemRight, viewport.width);
    const intersectBottom = Math.min(elemBottom, viewport.height);

    // Check if there's any intersection
    const hasIntersection = intersectRight > intersectLeft && intersectBottom > intersectTop;
    if (!hasIntersection) {
      return false;
    }

    // Calculate visibility percentage
    const intersectArea = (intersectRight - intersectLeft) * (intersectBottom - intersectTop);
    const elementArea = boundingBox.width * boundingBox.height;
    const visibilityPercent = (intersectArea / elementArea) * 100;

    // Return true if >50% visible
    return visibilityPercent > 50;
  }

  /**
   * Check if node is semantic or non-semantic (interactive)
   */
  private isSemanticNode(node: VirtualNode): boolean {
    return node.tier === 'semantic' || node.tier === 'non-semantic';
  }

  /**
   * Check if node has actual rendering data or meaningful semantic attributes
   *
   * Elements in virtualized lists (like Gmail) may have tier=semantic based on
   * HTML attributes (role="checkbox") but no actual rendering data because
   * they're outside the rendered viewport. These "ghost" nodes should be filtered.
   *
   * A node is considered to have rendering/semantic data if it has any of:
   * - boundingBox (layout data from DOMSnapshot.captureSnapshot)
   * - accessibility.role that is not "none" (from Accessibility.getPartialAXTree)
   * - accessibility.name (aria label from accessibility tree)
   * - Inherently interactive tag (a, button, input, select, textarea)
   * - Meaningful aria-label in HTML attributes
   */
  private hasRenderingData(node: VirtualNode): boolean {
    // Has bounding box - element is laid out
    if (node.boundingBox) {
      return true;
    }

    // Has meaningful accessibility role from CDP (not "none")
    if (node.accessibility?.role && node.accessibility.role !== 'none') {
      return true;
    }

    // Has accessibility name from CDP (aria-label resolved)
    if (node.accessibility?.name) {
      return true;
    }

    // Inherently interactive tags - always keep these
    const tag = (node.localName || node.nodeName || '').toLowerCase();
    const interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'option', 'label'];
    if (interactiveTags.includes(tag)) {
      return true;
    }

    // Check HTML attributes for meaningful semantic data (even without CDP accessibility data)
    // This catches elements that have role/aria-label but weren't included in CDP accessibility tree
    if (node.attributes) {
      const meaningfulRoles = ['button', 'link', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox',
                               'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'combobox',
                               'listbox', 'textbox', 'searchbox', 'menu', 'menubar', 'tablist', 'tree',
                               'grid', 'treegrid', 'toolbar', 'heading', 'option', 'row', 'gridcell',
                               'cell', 'columnheader', 'rowheader', 'alert', 'alertdialog', 'dialog',
                               'status', 'progressbar', 'scrollbar', 'img', 'figure'];

      for (let i = 0; i < node.attributes.length; i += 2) {
        const attrName = node.attributes[i];
        const attrValue = node.attributes[i + 1];

        // Has aria-label
        if (attrName === 'aria-label' && attrValue) {
          return true;
        }

        // Has meaningful interactive role in HTML attributes
        if (attrName === 'role' && meaningfulRoles.includes(attrValue)) {
          return true;
        }

        // Has tabindex >= 0 (focusable element)
        if (attrName === 'tabindex') {
          const tabIndex = parseInt(attrValue, 10);
          if (!isNaN(tabIndex) && tabIndex >= 0) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if node is a semantic container that should be preserved for structure
   */
  private isSemanticContainer(node: VirtualNode): boolean {
    const role = node.accessibility?.role || '';
    const containerRoles = ['form', 'table', 'dialog', 'navigation', 'main', 'region', 'article', 'section'];
    return containerRoles.includes(role);
  }

  /**
   * Filter SerializedNode tree to only include nodes visible in viewport
   *
   * Strategy:
   * 1. If node has inViewport === true, keep it (and all its children)
   * 2. If node has inViewport === false/undefined, recursively filter children:
   *    - If any children are visible, keep this node as a container
   *    - If no children are visible, remove this node
   * 3. Structural nodes (body, main) are always kept to preserve tree structure
   * 4. After filtering, remove the inViewport field from all nodes
   */
  private filterByViewport(node: SerializedNode | null): SerializedNode | null {
    if (!node) return null;


    // Always preserve critical structural nodes (starting from body level)
    const structuralTags = ['body', 'main', 'html'];
    const isStructural = structuralTags.includes(node.tag);


    // If node is explicitly in viewport, keep it and all children
    if (node.inViewport === true) {
      const { inViewport, ...nodeWithoutInViewport } = node;
      return nodeWithoutInViewport;
    }

    // Preserve interactive elements even if inViewport is not set (no bounding box data)
    // Interactive elements are identifiable by role or interactive tags
    const interactiveTags = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'option']);
    const isInteractive = node.role || interactiveTags.has(node.tag);
    if (isInteractive && node.inViewport === undefined) {
      const { inViewport, ...nodeWithoutInViewport } = node;
      return nodeWithoutInViewport;
    }

    // If node has children, recursively filter them
    if (node.kids && node.kids.length > 0) {
      const filteredKids = node.kids
        .map(child => this.filterByViewport(child))
        .filter((child): child is SerializedNode => child !== null);

      // If node has visible children OR is structural, keep it with filtered children
      if (filteredKids.length > 0 || isStructural) {
        const { inViewport, ...nodeWithoutInViewport } = node;
        const result: SerializedNode = {
          ...nodeWithoutInViewport,
          kids: filteredKids.length > 0 ? filteredKids : undefined
        };

        // Also filter shadow roots if present
        if (node.shadow_roots) {
          const filteredShadowRoots = node.shadow_roots
            .map(root => this.filterByViewport(root))
            .filter((root): root is SerializedNode => root !== null);
          if (filteredShadowRoots.length > 0) {
            result.shadow_roots = filteredShadowRoots;
          }
        }

        // Also filter content document if present
        if (node.content_document) {
          const filteredContentDoc = this.filterByViewport(node.content_document);
          if (filteredContentDoc) {
            result.content_document = filteredContentDoc;
          }
        }

        return result;
      }
    }

    // Check shadow roots and content document even if no kids
    let hasVisibleContent = false;
    const result: SerializedNode = { ...node };
    delete result.inViewport;

    if (node.shadow_roots) {
      const filteredShadowRoots = node.shadow_roots
        .map(root => this.filterByViewport(root))
        .filter((root): root is SerializedNode => root !== null);
      if (filteredShadowRoots.length > 0) {
        result.shadow_roots = filteredShadowRoots;
        hasVisibleContent = true;
      } else {
        delete result.shadow_roots;
      }
    }

    if (node.content_document) {
      const filteredContentDoc = this.filterByViewport(node.content_document);
      if (filteredContentDoc) {
        result.content_document = filteredContentDoc;
        hasVisibleContent = true;
      } else {
        delete result.content_document;
      }
    }

    if (hasVisibleContent || isStructural) {
      return result;
    }

    // Node is not in viewport and has no visible children - remove it
    return null;
  }
}
