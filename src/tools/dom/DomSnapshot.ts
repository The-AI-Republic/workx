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

  private _backendNodeMap?: Map<number, VirtualNode>;
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
   * Build a flat map of backendNodeId -> VirtualNode for quick lookups
   */
  private buildBackendNodeMap(): Map<number, VirtualNode> {
    if (this._backendNodeMap) return this._backendNodeMap;

    this._backendNodeMap = new Map();
    const traverse = (node: VirtualNode) => {
      this._backendNodeMap!.set(node.backendNodeId, node);
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
   */
  getNodeByBackendId(backendNodeId: number): VirtualNode | null {
    return this.buildBackendNodeMap().get(backendNodeId) ?? null;
  }


  isStale(maxAgeMs: number = 30000): boolean {
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

    // Extract body node from virtualDom before processing
    // If no body tag found, returns the root node as fallback
    const bodyVirtualNode = this.findBodyNode(this.virtualDom);

    // Use SerializationPipeline for compaction on body node only
    const pipeline = new SerializationPipeline();
    const result = pipeline.execute(bodyVirtualNode);

    // Build flattened tree structure from pipeline result with v3 schema
    const bodyBeforeFilter = this.flatternNode(result.tree, opts);

    // Apply viewport filtering to only include visible nodes
    const body = this.filterByViewport(bodyBeforeFilter);

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
    // Case 1: Keep semantic and non-semantic nodes (Tier 1 & 2)
    if (this.isSemanticNode(node)) {
      return this.buildSerializedNode(node, opts);
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
      const tag = node.localName || node.nodeName.toLowerCase();
      const isStructuralRoot = ['html', 'body'].includes(tag);

      if (flattenedChildren.length === 1 && !isStructuralRoot) {
        return flattenedChildren[0];
      }

      // If multiple children (OR single child that wasn't hoisted), return structural node
      if (flattenedChildren.length > 0) {
        const frameIndex = node.frameIndex ?? 0;
        const structuralNode: SerializedNode = {
          node_id: `${frameIndex}:${node.backendNodeId}`,
          frame_id: frameIndex,
          tag: node.localName || node.nodeName.toLowerCase(),
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
        const tag = node.localName || node.nodeName.toLowerCase();
        // Only preserve critical structural nodes when empty (body, main)
        // Note: html and #document are excluded since we extract body directly
        if (tag === 'body' || tag === 'main') {
          console.warn(`[DomSnapshot] All children filtered out for <${tag}>. Returning placeholder node.`);
          const frameIndex = node.frameIndex ?? 0;
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
   * Check if node is a semantic container that should be preserved for structure
   */
  private isSemanticContainer(node: VirtualNode): boolean {
    const role = node.accessibility?.role || '';
    const containerRoles = ['form', 'table', 'dialog', 'navigation', 'main', 'region', 'article', 'section'];
    return containerRoles.includes(role);
  }

  /**
   * Find body node from VirtualNode tree
   * Traverses the tree to find the body element and returns it directly
   *
   * Expected structure: #document > html > body
   * If no body tag is found, returns the input node as fallback
   */
  private findBodyNode(node: VirtualNode): VirtualNode {

    // If this is the body node, return it
    const nodeName = node.localName || node.nodeName.toLowerCase();
    if (nodeName === 'body') {
      return node;
    }

    // If this node has children, search recursively
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        const bodyNode = this.findBodyNode(child);
        // Only return if we actually found a body node (not the fallback)
        const childNodeName = bodyNode?.localName || bodyNode?.nodeName.toLowerCase();
        if (bodyNode && childNodeName === 'body') {
          return bodyNode;
        }
      }
    }

    // Body not found - return input node as fallback
    return node;
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
