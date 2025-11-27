import { DomSnapshot, FrameRegistry } from './DomSnapshot';
import type {
  VirtualNode,
  ActionResult,
  SerializedDom,
  RawSerializedDom,
  PageContext,
  SnapshotStats,
  ServiceConfig,
  PerformanceMetrics,
  FrameMetadata
} from './types';
import { NODE_ID_WINDOW, NODE_ID_DOCUMENT } from './types';
import { computeHeuristics, classifyNode, determineInteractionType, detectFramework, serializedNodeToHtml, computeScrollable, parseNodeId } from './utils';
import type { TypeOptions } from '../../types/domTool';

export class DomService {
  private static instances = new Map<number, DomService>();

  private tabId: number;
  private isAttached: boolean = false;
  private currentSnapshot: DomSnapshot | null = null;
  private config: ServiceConfig;
  private metrics: PerformanceMetrics; // Performance metrics tracking

  private constructor(tabId: number, config?: Partial<ServiceConfig>) {
    this.tabId = tabId;
    this.config = {
      enableVisualEffects: true,
      maxTreeDepth: 100,
      snapshotTimeout: 120000,
      retryAttempts: 2,
      enableMetrics: true,
      ...config
    };

    // Initialize performance metrics
    this.metrics = {
      snapshotCount: 0,
      snapshotCacheHits: 0,
      snapshotCacheMisses: 0,
      totalSnapshotDuration: 0,
      averageSnapshotDuration: 0,
      actionCount: 0,
      actionsByType: {
        click: 0,
        type: 0,
        scroll: 0,
        keypress: 0
      },
      totalActionDuration: 0,
      averageActionDuration: 0,
      errorCount: 0,
      errorsByType: {},
      lastReset: new Date()
    };
  }

  static async forTab(tabId: number, config?: Partial<ServiceConfig>): Promise<DomService> {
    if (!this.instances.has(tabId)) {
      const service = new DomService(tabId, config);
      await service.attach();
      this.instances.set(tabId, service);
    }
    return this.instances.get(tabId)!;
  }

  async attach(): Promise<void> {
    if (this.isAttached) return;

    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
      this.isAttached = true;

      // Enable required domains
      await this.sendCommand('DOM.enable', {});
      await this.sendCommand('Accessibility.enable', {});
      await this.sendCommand('Page.enable', {}); // Enable Page domain for lifecycle events

      // Listen for invalidation events
      chrome.debugger.onEvent.addListener(this.handleCdpEvent.bind(this));

      // Listen for debugger detach (connection loss)
      chrome.debugger.onDetach.addListener(this.handleDebuggerDetach.bind(this));
    } catch (error: any) {
      if (error.message?.includes('already attached')) {
        throw new Error('ALREADY_ATTACHED: DevTools is open on this tab. Please close DevTools.');
      }
      throw new Error(`ATTACH_FAILED: ${error.message}`);
    }
  }

  async detach(): Promise<void> {
    if (!this.isAttached) return;

    try {
      await chrome.debugger.detach({ tabId: this.tabId });
      this.isAttached = false;
      this.currentSnapshot = null;
      DomService.instances.delete(this.tabId);
    } catch (error: any) {
      console.warn(`[DomService] Detach error: ${error.message}`);
    }
  }

  invalidateSnapshot(): void {
    this.currentSnapshot = null;
  }

  getCurrentSnapshot(): DomSnapshot | null {
    return this.currentSnapshot;
  }

  async getSerializedDom(): Promise<SerializedDom> {
    // Track cache hits/misses
    if (!this.currentSnapshot || this.currentSnapshot.isStale()) {
      if (this.config.enableMetrics) {
        this.metrics.snapshotCacheMisses++;
      }
      await this.buildSnapshot();
    } else {
      if (this.config.enableMetrics) {
        this.metrics.snapshotCacheHits++;
      }
    }

    // CDP MIGRATION: Trigger undulate visual effect (via Runtime.evaluate, not message passing)
    await this.triggerVisualEffect('undulate');

    // Get raw serialized DOM (numbers and SerializedNode)
    const rawDom = this.currentSnapshot!.serialize();

    // Transform to stringified format for LLM consumption:
    // 1. Viewport dimensions: Add "px" suffix to all numeric values
    // 2. Body: Convert SerializedNode tree to HTML string representation
    const htmlContent = serializedNodeToHtml(rawDom.page.body);

    const serializedDom = {
      page: {
        context: {
          url: rawDom.page.context.url,
          title: rawDom.page.context.title,
          viewport: {
            width: `${rawDom.page.context.viewport.width}px`,
            height: `${rawDom.page.context.viewport.height}px`,
            overflowTop: `${rawDom.page.context.viewport.overflowTop}px`,
            overflowBottom: `${rawDom.page.context.viewport.overflowBottom}px`,
            overflowLeft: `${rawDom.page.context.viewport.overflowLeft}px`,
            overflowRight: `${rawDom.page.context.viewport.overflowRight}px`
          }
        },
        body: htmlContent,
      }
    };

    return serializedDom;
  }

  /**
   * Wait for page to finish loading before accessing DOM
   * This prevents issues with DOM.getDocument being called while page is still loading
   *
   * Enhanced for SPA detection: After page load, waits for meaningful content to appear
   * to avoid capturing empty React/Vue/Angular loading screens
   */
  private async waitForPageLoad(): Promise<void> {
    try {
      // Step 1: Wait for document.readyState === 'complete'
      const readyStateResult = await this.sendCommand<any>('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true
      });

      const readyState = readyStateResult.result.value;

      if (readyState !== 'complete') {
        console.log(`[DomService] Page loading (readyState: ${readyState}), waiting for load event...`);

        // Wait for load event
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('PAGE_LOAD_TIMEOUT: Page did not finish loading within 30 seconds'));
          }, 30000); // 30 second timeout

          const eventListener = (source: chrome.debugger.Debuggee, method: string) => {
            if (source.tabId === this.tabId && method === 'Page.loadEventFired') {
              clearTimeout(timeout);
              chrome.debugger.onEvent.removeListener(eventListener);
              console.log('[DomService] Page load event fired');
              resolve();
            }
          };

          chrome.debugger.onEvent.addListener(eventListener);
        });
      }

      // Step 2: Check for SPA loading indicators and wait for meaningful content
      console.log('[DomService] Checking for SPA content rendering...');

      const maxWaitForContent = 10000; // 10 seconds max wait for SPA content
      const checkInterval = 500; // Check every 500ms
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitForContent) {
        // Check if page has meaningful interactive content
        const contentCheck = await this.sendCommand<any>('Runtime.evaluate', {
          expression: `
            (function() {
              // Count interactive elements (buttons, links, inputs)
              const buttons = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
              const links = document.querySelectorAll('a[href]');
              const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');

              // Count text content (excluding script/style tags)
              const body = document.body;
              const textContent = body ? body.innerText.trim() : '';

              // Check for common loading indicators
              const loadingIndicators = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="progress"], [aria-busy="true"], [role="progressbar"]');

              // Detect if page is still showing only loading screen
              const hasLoadingIndicator = loadingIndicators.length > 0;
              const hasMinimalContent = textContent.length < 100 && buttons.length < 3 && links.length < 3 && inputs.length < 2;

              return {
                interactiveCount: buttons.length + links.length + inputs.length,
                textLength: textContent.length,
                hasLoadingIndicator: hasLoadingIndicator,
                isStillLoading: hasLoadingIndicator && hasMinimalContent,
                timestamp: Date.now()
              };
            })()
          `,
          returnByValue: true
        });

        const contentStats = contentCheck.result.value;
        console.log(`[DomService] Content check: ${contentStats.interactiveCount} interactive elements, ${contentStats.textLength} chars, loading: ${contentStats.isStillLoading}`);

        // If page has meaningful content and no loading indicators, proceed
        if (!contentStats.isStillLoading && (contentStats.interactiveCount > 5 || contentStats.textLength > 200)) {
          console.log('[DomService] Meaningful content detected, proceeding with snapshot');
          return;
        }

        // If page is clearly stuck on loading screen, wait a bit more
        if (contentStats.isStillLoading) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
        } else {
          // No loading indicator but minimal content - might be legitimate minimal page
          console.log('[DomService] No loading indicator, proceeding with snapshot');
          return;
        }
      }

      // Timeout reached - proceed anyway
      console.warn('[DomService] SPA content wait timeout - proceeding with snapshot (page may still be rendering)');

    } catch (error: any) {
      console.warn(`[DomService] Could not wait for page load: ${error.message}. Continuing anyway...`);
      // Continue even if we can't wait - some pages may have issues but DOM might still be accessible
    }
  }

  /**
   * Build complete VirtualNode tree from CDP DOM and Accessibility APIs
   *
   * CSP COMPATIBILITY: CDP operates at browser level, bypassing Content-Security-Policy
   * restrictions that would block content script injection. This enables DOM access on high-security
   * sites (banking, enterprise apps) where traditional content scripts fail.
   *
   * The pierce: true parameter ensures cross-origin iframe and shadow DOM traversal.
   *
   * Enhanced with DOMSnapshot.captureSnapshot() for paint order and layout data
   */
  async buildSnapshot(): Promise<DomSnapshot> {
    if (!this.isAttached) {
      throw new Error('NOT_ATTACHED: Must call attach() first');
    }

    const start = Date.now();

    // Wait for page to finish loading before accessing DOM
    await this.waitForPageLoad();

    // Add timeout protection for slow-loading iframes
    const snapshotPromise = (async () => {
      // Parallel fetch: DOM tree + A11y tree + DOMSnapshot (paint order + layout)
      // Note: A11y fetch may fail on some CSP-restricted pages - we handle this gracefully
      // Note: DOMSnapshot may fail on older Chrome (<92) or CSP-restricted pages - graceful fallback
      const [axTree, domTree, domSnapshot] = await Promise.all([
        // Get accessibility tree for semantic classification
        this.sendCommand<any>('Accessibility.getFullAXTree', { depth: -1 }).catch(() => null),
        this.sendCommand<any>('DOM.getDocument', { depth: -1, pierce: true })
          .catch((error: any) => {
            // X-Frame-Options DENY detection
            if (error.message?.includes('Frame') || error.message?.includes('X-Frame-Options')) {
              throw new Error('FRAME_DENIED: Page has X-Frame-Options DENY header. Cross-origin frames cannot be accessed.');
            }
            throw error;
          }),
        // Fetch paint order and layout data via DOMSnapshot.captureSnapshot()
        this.sendCommand<any>('DOMSnapshot.captureSnapshot', {
          computedStyles: ['opacity', 'background-color', 'display', 'visibility', 'cursor', 'overflow-x', 'overflow-y'],
          includePaintOrder: true,
          includeDOMRects: true
        }).catch((error: any) => {
          console.warn('[DomService] DOMSnapshot.captureSnapshot() unavailable, falling back to basic mode:', error.message);
          return null;
        })
      ]);
      return { axTree, domTree, domSnapshot };
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`SNAPSHOT_TIMEOUT: Snapshot took longer than ${this.config.snapshotTimeout}ms. Consider reducing depth or page complexity.`)), this.config.snapshotTimeout);
    });

    const { axTree, domTree, domSnapshot } = await Promise.race([snapshotPromise, timeoutPromise]);

    // Build enrichment map: backendNodeId → AXNode
    const axMap = new Map<number, any>();
    if (axTree?.nodes) {
      for (const axNode of axTree.nodes) {
        if (axNode.backendDOMNodeId) {
          axMap.set(axNode.backendDOMNodeId, axNode);
        }
      }
    }

    // Fetch device pixel ratio early to normalize CDP coordinates to CSS pixels
    let devicePixelRatio = 1;
    try {
      const dprResult = await this.sendCommand<any>('Runtime.evaluate', {
        expression: 'window.devicePixelRatio',
        returnByValue: true
      });
      if (dprResult?.result?.value) {
        devicePixelRatio = dprResult.result.value;
      }
    } catch (error) {
      console.warn('[DomService] Could not get devicePixelRatio, using default 1');
    }

    // Build layout map: backendNodeId → LayoutData from DOMSnapshot
    // Convert device pixels to CSS pixels for web standard compatibility
    const layoutMap = this.buildLayoutMap(domSnapshot, devicePixelRatio);

    // Build virtual DOM tree with frame tracking
    let nodeCounter = 0;
    const frameRegistry = new FrameRegistry();

    // Track iframe count for the 5 iframe limit
    let iframeCount = 0;
    const MAX_IFRAMES = 5;

    const buildVirtualTree = (cdpNode: any, depth: number = 0, iframeDepth: number = 0, currentFrameIndex: number = 0): VirtualNode | null => {
      // Pathological case protection for deeply nested iframes
      if (depth > this.config.maxTreeDepth) {
        console.warn(`[DomService] Max tree depth (${this.config.maxTreeDepth}) reached at iframe depth ${iframeDepth}. Tree traversal stopped.`);
        return null;
      }

      // Skip nested iframes (layer 2+) - only process layer 1
      if (iframeDepth > 1) {
        return null;
      }

      nodeCounter++;
      const backendNodeId = cdpNode.backendNodeId;
      const axNode = axMap.get(backendNodeId);
      const heuristics = computeHeuristics(cdpNode.attributes);
      const layoutData = layoutMap.get(backendNodeId); // Get layout data

      const tier = classifyNode(axNode, heuristics);

      const vNode: VirtualNode = {
        nodeId: cdpNode.nodeId,
        backendNodeId,
        nodeType: cdpNode.nodeType,
        nodeName: cdpNode.nodeName,
        localName: cdpNode.localName,
        nodeValue: cdpNode.nodeValue,
        attributes: cdpNode.attributes,
        frameId: cdpNode.frameId,
        shadowRootType: cdpNode.shadowRootType,
        tier,
        interactionType: determineInteractionType(cdpNode, axNode),
        accessibility: axNode
          ? {
            role: axNode.role?.value,
            name: axNode.name?.value,
            description: axNode.description?.value,
            value: axNode.value?.value,
            checked: axNode.checked?.value === 'true',
            disabled: axNode.disabled,
            expanded: axNode.expanded,
            level: axNode.level,
            required: axNode.required
          }
          : undefined,
        heuristics,
        // Attach layout data from DOMSnapshot.captureSnapshot()
        boundingBox: layoutData?.boundingBox,
        paintOrder: layoutData?.paintOrder,
        computedStyle: layoutData?.computedStyle,
        scrollRects: layoutData?.scrollRects,
        clientRects: layoutData?.clientRects,
        // Compute scrollability based on dimensions and overflow styles
        scrollable: computeScrollable(layoutData),
        // Assign frame index for multi-frame support
        frameIndex: currentFrameIndex
      };

      // Recurse to children
      if (cdpNode.children) {
        vNode.children = cdpNode.children
          .map((c: any) => buildVirtualTree(c, depth + 1, iframeDepth, currentFrameIndex))
          .filter((n: VirtualNode | null) => n !== null) as VirtualNode[];
      }

      // Recurse to shadow roots
      if (cdpNode.shadowRoots) {
        vNode.shadowRoots = cdpNode.shadowRoots
          .map((c: any) => buildVirtualTree(c, depth + 1, iframeDepth, currentFrameIndex))
          .filter((n: VirtualNode | null) => n !== null) as VirtualNode[];
      }

      // Recurse to iframe content document
      if (cdpNode.contentDocument) {
        // Check iframe limit before processing
        if (iframeCount >= MAX_IFRAMES) {
          // Don't process this iframe's content - max limit reached
        } else {
          iframeCount++;
          const newFrameIndex = iframeCount; // 1-5 for iframes
          const nextIframeDepth = iframeDepth + 1;

          // Register iframe metadata
          const iframeMetadata: FrameMetadata = {
            frameId: newFrameIndex,
            backendNodeId: backendNodeId, // The iframe element's backendNodeId
            viewport: {
              // Use bounding box dimensions as iframe viewport
              width: layoutData?.boundingBox?.width ?? 0,
              height: layoutData?.boundingBox?.height ?? 0,
              scrollX: 0, // Will be updated if we can get scroll position
              scrollY: 0
            },
            boundingBox: layoutData?.boundingBox
          };
          frameRegistry.addFrame(iframeMetadata);

          const contentDoc = buildVirtualTree(cdpNode.contentDocument, depth + 1, nextIframeDepth, newFrameIndex);
          if (contentDoc) {
            vNode.contentDocument = contentDoc;
          }
        }
      }

      return vNode;
    };

    const virtualDom = buildVirtualTree(domTree.root);

    if (!virtualDom) {
      throw new Error('SNAPSHOT_FAILED: Could not build tree');
    }

    // Compute stats
    const stats: SnapshotStats = {
      totalNodes: nodeCounter,
      interactiveNodes: 0,
      semanticNodes: 0,
      nonSemanticNodes: 0,
      structuralNodes: 0,
      frameCount: 0,
      shadowRootCount: 0,
      snapshotDuration: Date.now() - start
    };

    this.computeStats(virtualDom, stats);

    // Memory pressure detection for large pages
    if (stats.totalNodes > 50000) {
      console.warn(`[DomService] MEMORY_PRESSURE: Page has ${stats.totalNodes} nodes (>50k threshold). Consider reducing maxTreeDepth or limiting snapshot scope to improve performance.`);
    }

    // Detect framework
    const framework = detectFramework(virtualDom);

    // Get page context with viewport scroll position
    const tab = await chrome.tabs.get(this.tabId);

    // Fetch viewport dimensions, scroll position, and page dimensions from the page
    // Fallback values assume viewport = page (no overflow) if Runtime.evaluate fails
    let viewportData = {
      width: tab.width || 0,
      height: tab.height || 0,
      scrollX: 0,
      scrollY: 0,
      pageWidth: tab.width || 0,  // Fallback: assume page width = viewport width (no horizontal overflow)
      pageHeight: tab.height || 0, // Fallback: assume page height = viewport height (no vertical overflow)
      devicePixelRatio: 1
    };
    try {
      const viewportResult = await this.sendCommand<any>('Runtime.evaluate', {
        expression: '({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight, devicePixelRatio: window.devicePixelRatio, visualViewportScale: window.visualViewport?.scale || 1 })',
        returnByValue: true
      });
      if (viewportResult?.result?.value) {
        viewportData = viewportResult.result.value;
      }
    } catch (error) {
      // Fallback to tab dimensions if Runtime.evaluate fails
      console.warn('[DomService] Could not get viewport and page dimensions, using fallback (assumes no overflow)');
    }

    const pageContext: PageContext = {
      url: tab.url || '',
      title: tab.title || '',
      frameId: 'main',
      loaderId: '',
      viewport: viewportData,
      frameTree: [],
      frameworkDetected: framework
    };

    this.currentSnapshot = new DomSnapshot(virtualDom, pageContext, stats, frameRegistry);

    // Track snapshot metrics
    if (this.config.enableMetrics) {
      this.metrics.snapshotCount++;
      this.metrics.totalSnapshotDuration += stats.snapshotDuration;
      this.metrics.averageSnapshotDuration = this.metrics.totalSnapshotDuration / this.metrics.snapshotCount;
    }

    return this.currentSnapshot;
  }

  private async sendCommand<T>(method: string, params: any): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }

  private async sendCommandWithRetry<T>(method: string, params: any): Promise<T> {
    for (let i = 0; i < this.config.retryAttempts; i++) {
      try {
        return await this.sendCommand<T>(method, params);
      } catch (error: any) {
        if (i === this.config.retryAttempts - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100)); // 100ms, 200ms
      }
    }
    throw new Error('Retry exhausted');
  }

  private handleCdpEvent(source: chrome.debugger.Debuggee, method: string, params?: any): void {
    if (source.tabId !== this.tabId) return;

    if (method === 'DOM.documentUpdated') {
      this.invalidateSnapshot();
    }
  }

  // Handle CDP connection loss
  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId !== this.tabId) return;

    console.error(`[DomService] CDP_CONNECTION_LOST: Debugger detached from tab ${this.tabId}. Reason: ${reason}`);
    this.isAttached = false;
    this.currentSnapshot = null;
    DomService.instances.delete(this.tabId);

    // If detach was unexpected (not user-initiated), log for debugging
    if (reason !== 'target_closed' && reason !== 'canceled_by_user') {
      console.warn(`[DomService] Unexpected debugger detach. Reason: ${reason}. Future operations will require re-attach.`);
    }
  }

  /**
   * Build layout map from DOMSnapshot data
   * Extracts layout information (bounding boxes, paint order, styles, etc.) and maps
   * them to backendNodeIds for efficient lookup during tree construction
   *
   * @param domSnapshot - CDP DOMSnapshot data
   * @param devicePixelRatio - Device pixel ratio for converting coordinates
   * NOTE: CDP returns coordinates in device pixels, we convert to CSS pixels (web standard)
   */
  private buildLayoutMap(domSnapshot: any, devicePixelRatio: number = 1): Map<number, any> {
    const layoutMap = new Map<number, any>();

    if (!domSnapshot?.documents) {
      return layoutMap;
    }

    const strings = domSnapshot.strings || [];
    const styleProperties = ['opacity', 'background-color', 'display', 'visibility', 'cursor', 'overflow-x', 'overflow-y'];

    // Iterate over all documents (main frame + iframes)
    for (const doc of domSnapshot.documents) {
      const layout = doc.layout;

      if (!layout || !layout.nodeIndex) {
        continue;
      }

      // Extract backendNodeIds from the nodes structure
      const backendNodeIds = doc.nodes?.backendNodeId || [];

      for (let i = 0; i < layout.nodeIndex.length; i++) {
        const nodeIndex = layout.nodeIndex[i];
        const backendNodeId = backendNodeIds[nodeIndex];

        // backendNodeId can be 0, so check for undefined explicitly
        if (backendNodeId === undefined) continue;

        const layoutData: any = {};

        // Bounding box (bounds are stored as [x, y, width, height] arrays)
        // CDP returns device pixels, convert to CSS pixels (web standard)
        if (layout.bounds && layout.bounds[i]) {
          const bounds = layout.bounds[i];
          const devicePixels = {
            x: bounds[0],
            y: bounds[1],
            width: bounds[2],
            height: bounds[3]
          };

          // Convert from device pixels to CSS pixels
          layoutData.boundingBox = {
            x: devicePixels.x / devicePixelRatio,
            y: devicePixels.y / devicePixelRatio,
            width: devicePixels.width / devicePixelRatio,
            height: devicePixels.height / devicePixelRatio
          };
        }

        // Paint order
        if (layout.paintOrders && layout.paintOrders[i] !== undefined) {
          layoutData.paintOrder = layout.paintOrders[i];
        }

        // Scroll dimensions
        if (layout.scrollRects && layout.scrollRects[i]) {
          const scrollRect = layout.scrollRects[i];
          layoutData.scrollRects = {
            width: scrollRect[0],
            height: scrollRect[1]
          };
        }

        // Client dimensions
        if (layout.clientRects && layout.clientRects[i]) {
          const clientRect = layout.clientRects[i];
          layoutData.clientRects = {
            width: clientRect[0],
            height: clientRect[1]
          };
        }

        // Computed styles
        if (layout.styles && layout.styles[i]) {
          const styleIndices = layout.styles[i];
          const computedStyle: any = {};

          for (let j = 0; j < styleIndices.length && j < styleProperties.length; j++) {
            const propertyName = styleProperties[j];
            const propertyValue = strings[styleIndices[j]];

            // Map to camelCase for our interface
            if (propertyName === 'opacity') computedStyle.opacity = propertyValue;
            if (propertyName === 'background-color') computedStyle.backgroundColor = propertyValue;
            if (propertyName === 'display') computedStyle.display = propertyValue;
            if (propertyName === 'visibility') computedStyle.visibility = propertyValue;
            if (propertyName === 'cursor') computedStyle.cursor = propertyValue;
            if (propertyName === 'overflow-x') computedStyle.overflowX = propertyValue;
            if (propertyName === 'overflow-y') computedStyle.overflowY = propertyValue;
          }

          if (Object.keys(computedStyle).length > 0) {
            layoutData.computedStyle = computedStyle;
          }
        }

        // Only add to map if we have actual layout data
        if (Object.keys(layoutData).length > 0) {
          layoutMap.set(backendNodeId, layoutData);
        }
      }
    }

    return layoutMap;
  }

  private computeStats(node: VirtualNode, stats: SnapshotStats, countedFrames: Set<number> = new Set()): void {
    if (node.tier === 'semantic') stats.semanticNodes++;
    else if (node.tier === 'non-semantic') stats.nonSemanticNodes++;
    else stats.structuralNodes++;

    if (node.interactionType) stats.interactiveNodes++;

    // Count unique frames (excluding main frame 0)
    if (node.frameIndex !== undefined && node.frameIndex > 0 && !countedFrames.has(node.frameIndex)) {
      countedFrames.add(node.frameIndex);
      stats.frameCount++;
    }

    if (node.shadowRootType) stats.shadowRootCount++;

    if (node.children) {
      for (const child of node.children) {
        this.computeStats(child, stats, countedFrames);
      }
    }
    if (node.shadowRoots) {
      for (const child of node.shadowRoots) {
        this.computeStats(child, stats, countedFrames);
      }
    }
    if (node.contentDocument) {
      this.computeStats(node.contentDocument, stats, countedFrames);
    }
  }

  /**
   * Ensure visual effects are initialized (lazy initialization)
   *
   * LAZY INITIALIZATION: Visual effects only mount when first needed, saving memory/CPU on non-working tabs.
   * This method checks if visual effects are initialized, and if not, dispatches an init event.
   * The content script listens for this event and mounts the VisualEffectController.
   *
   * Subsequent calls are cached (only checks once per DomService instance).
   */
  private visualEffectsInitialized: boolean = false;

  private async ensureVisualEffectsInitialized(): Promise<void> {
    this.visualEffectsInitialized = true;
    // Already checked and initialized in this DomService instance
    // if (this.visualEffectsInitialized) return;

    // try {
    //   // Check if visual effects are initialized in the page
    //   const checkResult = await this.sendCommand<any>('Runtime.evaluate', {
    //     expression: '!!window.__browserx_visual_effects_initialized__',
    //     returnByValue: true
    //   });

    //   const isInitialized = checkResult?.result?.value === true;

    //   if (!isInitialized) {
    //     console.log(`[DomService] Initializing visual effects on tab ${this.tabId}...`);

    //     // Dispatch init event to trigger lazy initialization
    //     await this.sendCommand('Runtime.evaluate', {
    //       expression: `
    //         (function() {
    //           const event = new CustomEvent('browserx:init-visual-effects', {
    //             bubbles: false,
    //             cancelable: false
    //           });
    //           document.dispatchEvent(event);
    //         })()
    //       `,
    //       returnByValue: false,
    //       awaitPromise: false
    //     });

    //     // Wait briefly for initialization to complete (~100ms for Svelte mount + WebGL setup)
    //     await new Promise(resolve => setTimeout(resolve, 150));
    //   }

    //   // Cache result to avoid repeated checks
    //   this.visualEffectsInitialized = true;
    // } catch (error: any) {
    //   // Graceful degradation - visual effects unavailable but actions continue
    //   console.debug(`[DomService] Could not initialize visual effects on tab ${this.tabId}: ${error.message || 'Unknown error'}`);
    //   this.visualEffectsInitialized = true; // Don't retry on every action
    // }
  }

  /**
   * Trigger visual effect via CDP Runtime.evaluate
   *
   * CDP MIGRATION: Instead of chrome.tabs.sendMessage (async, CSP-blocked),
   * we inject JavaScript directly via CDP Runtime.evaluate:
   * - Synchronous execution (awaitable)
   * - CSP-safe (CDP bypasses Content Security Policy)
   * - Preserves existing sophisticated visual effects (WebGL ripples, animated cursor, etc.)
   * - No message passing latency
   *
   * LAZY INITIALIZATION: Visual effects are initialized on first use (ensureVisualEffectsInitialized).
   * The injected code dispatches a CustomEvent that VisualEffectController listens for.
   */
  private async triggerVisualEffect(type: 'ripple' | 'undulate', x?: number, y?: number): Promise<void> {
    if (!this.config.enableVisualEffects) return;

    try {
      // Ensure visual effects are initialized (lazy init on first use)
      await this.ensureVisualEffectsInitialized();

      // Inject JavaScript to dispatch custom event
      const expression = `
        (function() {
          try {
            const event = new CustomEvent('browserx:show-visual-effect', {
              detail: { type: ${JSON.stringify(type)}, x: ${x ?? 'undefined'}, y: ${y ?? 'undefined'} },
              bubbles: false,
              cancelable: false
            });
            document.dispatchEvent(event);
            return { success: true };
          } catch (error) {
            return { success: false, error: error.message };
          }
        })()
      `;

      await this.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false
      });
    } catch (error: any) {
      // Graceful degradation - visual effects unavailable but actions continue
      // This can happen on:
      // - Pages not yet loaded (content script not initialized)
      // - Pages with strict CSP that blocks content script entirely
      // - Browser contexts where content script isn't injected
      console.debug(`[DomService] Visual effect unavailable on tab ${this.tabId}: ${error.message || 'Unknown error'}. Actions will continue without visual feedback.`);
    }
  }

  // Action methods (T037-T045 will implement these)
  async click(nodeId: number | string): Promise<ActionResult> {
    const start = Date.now();

    // Parse frame-scoped node ID
    let parsedId;
    try {
      parsedId = parseNodeId(nodeId);
    } catch (error: any) {
      return {
        success: false,
        duration: Date.now() - start,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: typeof nodeId === 'number' ? nodeId : -1,
        actionType: 'click',
        timestamp: new Date().toISOString()
      };
    }

    try {
      if (!this.currentSnapshot) {
        throw new Error('NODE_NOT_FOUND: No snapshot available');
      }

      // Validate frame exists
      if (!this.currentSnapshot.frameRegistry.hasFrame(parsedId.frameId)) {
        throw new Error(`FRAME_NOT_FOUND: Frame ${parsedId.frameId} not found in snapshot`);
      }

      const backendNodeId = parsedId.backendNodeId;

      // Verify node exists in snapshot
      const node = this.currentSnapshot.getNodeByBackendId(backendNodeId);
      if (!node) {
        throw new Error(`NODE_NOT_FOUND: Node ${nodeId} not found in snapshot`);
      }

      // Get box model for coordinates
      let boxModel;
      try {
        boxModel = await this.sendCommand<any>('DOM.getBoxModel', { backendNodeId });
      } catch (error: any) {
        // SVG elements don't have box models - try getting content quads instead
        if (error.message?.includes('Could not compute box model')) {
          if (node?.nodeName?.toLowerCase() === 'svg' || node?.nodeName?.toLowerCase().includes('svg')) {
            console.warn('[DomService] SVG element detected - using alternative click method');
            // For SVG, try to get bounding rect via JavaScript
            throw new Error('SVG_CLICK_NOT_SUPPORTED: Direct SVG element clicking not yet fully implemented. Consider clicking parent element.');
          }
        }
        throw error;
      }

      let { content } = boxModel.model;

      // Element visibility verification
      const width = Math.abs(content[2] - content[0]);
      const height = Math.abs(content[5] - content[1]);
      if (width === 0 || height === 0) {
        throw new Error('ELEMENT_NOT_VISIBLE: Element has zero width or height. It may be hidden or display:none.');
      }

      // Calculate initial center coordinates
      let centerX = (content[0] + content[2]) / 2;
      let centerY = (content[1] + content[5]) / 2;

      // Check if element is within viewport and scroll if needed
      // Only check viewport if visual effects are enabled (optimization)
      if (this.config.enableVisualEffects) {
        const viewportResult = await this.sendCommand<any>('Runtime.evaluate', {
          expression: '({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })',
          returnByValue: true
        });
        const viewport = viewportResult.result.value;

        // Element is in viewport if its center is visible on screen
        // Note: content coordinates are absolute (relative to document), not viewport
        const isInViewport =
          centerX >= viewport.scrollX &&
          centerX <= viewport.scrollX + viewport.width &&
          centerY >= viewport.scrollY &&
          centerY <= viewport.scrollY + viewport.height;

        if (!isInViewport) {
          // Scroll element into view
          await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId });

          // Wait for scroll animation to complete
          await new Promise(resolve => setTimeout(resolve, 100));

          // Get box model AGAIN after scrolling (element position has changed)
          const updatedBoxModel = await this.sendCommand<any>('DOM.getBoxModel', { backendNodeId });
          content = updatedBoxModel.model.content;

          // Recalculate center coordinates with new position
          centerX = (content[0] + content[2]) / 2;
          centerY = (content[1] + content[5]) / 2;
        }
      } else {
        // Visual effects disabled - still scroll into view if needed, but don't wait
        await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => { });
      }

      // CDP MIGRATION: Trigger ripple visual effect BEFORE click (with correct coordinates)
      await this.triggerVisualEffect('ripple', centerX, centerY);

      // Dispatch click at the correct position
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: centerX,
        y: centerY,
        button: 'left',
        clickCount: 1
      });

      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: centerX,
        y: centerY,
        button: 'left'
      });

      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('click', duration, true);

      return {
        success: true,
        duration,
        changes: {
          navigationOccurred: false,
          domMutations: 1,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: nodeId, // Return the original sequential ID that LLM provided
        actionType: 'click',
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      this.invalidateSnapshot(); // Always invalidate, even on error

      const duration = Date.now() - start;
      this.trackActionMetrics('click', duration, false, error.message);

      return {
        success: false,
        duration,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: nodeId, // Return the original sequential ID that LLM provided
        actionType: 'click',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Detect element type for typing strategy selection
   */
  private async detectElementType(backendNodeId: number): Promise<'input' | 'textarea' | 'contenteditable' | 'unknown'> {
    try {
      const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
      if (!resolveResult?.object?.objectId) return 'unknown';

      const result = await this.sendCommand<any>('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function() {
          const tagName = this.tagName?.toLowerCase();
          const isContentEditable = this.contentEditable === 'true' || this.contentEditable === '';

          if (tagName === 'input') return 'input';
          if (tagName === 'textarea') return 'textarea';
          if (isContentEditable) return 'contenteditable';
          return 'unknown';
        }`,
        returnByValue: true
      });

      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => {});
      return result?.result?.value || 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Clear contenteditable element (rich text editors like Quill, Slate, etc.)
   */
  private async clearContentEditable(backendNodeId: number): Promise<void> {
    const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
    if (!resolveResult?.object?.objectId) {
      throw new Error('Could not resolve node for clearing');
    }

    try {
      // Strategy 1: Select all and delete for contenteditable
      // This works better than direct innerHTML manipulation for rich text editors
      await this.sendCommand('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function() {
          // Focus the element
          this.focus();

          // Select all content
          const range = document.createRange();
          range.selectNodeContents(this);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);

          return { selected: true };
        }`,
        returnByValue: true
      });

      // Wait for selection
      await new Promise(resolve => setTimeout(resolve, 50));

      // Send Backspace key to delete selected content
      // This triggers the editor's event handlers properly
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace'
      });
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace'
      });

      // Alternative: Send Delete key
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Delete',
        code: 'Delete'
      });
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Delete',
        code: 'Delete'
      });

      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => {});
    }
  }

  /**
   * Type text character-by-character (simulates human typing)
   * Works well for rich text editors (Quill, Slate, Draft.js, ProseMirror)
   */
  private async typeCharByChar(text: string, speed: number = 50): Promise<void> {
    for (const char of text) {
      // Determine key code and key name
      const key = char;
      const code = this.getKeyCode(char);

      // Dispatch keydown event
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: key,
        code: code,
        text: char
      });

      // Dispatch keyup event
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: key,
        code: code,
        text: char
      });

      // Wait between characters to simulate human typing
      if (speed > 0) {
        await new Promise(resolve => setTimeout(resolve, speed));
      }
    }
  }

  /**
   * Type text using paste simulation (Ctrl+V)
   * Works well for rich text editors and is faster than char-by-char
   */
  private async typePaste(text: string, backendNodeId: number): Promise<void> {
    const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
    if (!resolveResult?.object?.objectId) {
      throw new Error('Could not resolve node for paste');
    }

    try {
      // Use execCommand('insertText') which triggers proper events
      await this.sendCommand('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function(text) {
          // Focus the element
          this.focus();

          // Try execCommand first (works for many rich text editors)
          if (document.execCommand) {
            const success = document.execCommand('insertText', false, text);
            if (success) return { method: 'execCommand', success: true };
          }

          // Fallback: Dispatch paste event manually
          const dataTransfer = new DataTransfer();
          dataTransfer.setData('text/plain', text);

          const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
          });

          this.dispatchEvent(pasteEvent);

          // Also fire beforeinput and input events
          const beforeInputEvent = new InputEvent('beforeinput', {
            data: text,
            inputType: 'insertFromPaste',
            bubbles: true,
            cancelable: true
          });
          this.dispatchEvent(beforeInputEvent);

          const inputEvent = new InputEvent('input', {
            data: text,
            inputType: 'insertFromPaste',
            bubbles: true
          });
          this.dispatchEvent(inputEvent);

          return { method: 'events', success: true };
        }`,
        arguments: [{ value: text }],
        returnByValue: true
      });
    } finally {
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => {});
    }
  }

  /**
   * Get key code for a character
   */
  private getKeyCode(char: string): string {
    if (char === ' ') return 'Space';
    if (char === '\n') return 'Enter';
    if (char === '\t') return 'Tab';
    if (/[a-z]/i.test(char)) return `Key${char.toUpperCase()}`;
    if (/[0-9]/.test(char)) return `Digit${char}`;

    // Special characters
    const specialKeys: Record<string, string> = {
      '.': 'Period',
      ',': 'Comma',
      ';': 'Semicolon',
      "'": 'Quote',
      '[': 'BracketLeft',
      ']': 'BracketRight',
      '\\': 'Backslash',
      '-': 'Minus',
      '=': 'Equal',
      '/': 'Slash'
    };

    return specialKeys[char] || 'Unidentified';
  }

  async type(nodeId: number | string, text: string, options?: TypeOptions): Promise<ActionResult> {
    const start = Date.now();

    // Parse frame-scoped node ID
    let parsedId;
    try {
      parsedId = parseNodeId(nodeId);
    } catch (error: any) {
      return {
        success: false,
        duration: Date.now() - start,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: typeof nodeId === 'number' ? nodeId : -1,
        actionType: 'type',
        timestamp: new Date().toISOString()
      };
    }

    try {
      if (!this.currentSnapshot) {
        throw new Error('NODE_NOT_FOUND: No snapshot available');
      }

      // Validate frame exists
      if (!this.currentSnapshot.frameRegistry.hasFrame(parsedId.frameId)) {
        throw new Error(`FRAME_NOT_FOUND: Frame ${parsedId.frameId} not found in snapshot`);
      }

      const backendNodeId = parsedId.backendNodeId;

      // Verify node exists in snapshot
      const node = this.currentSnapshot.getNodeByBackendId(backendNodeId);
      if (!node) {
        throw new Error(`NODE_NOT_FOUND: Node ${nodeId} not found`);
      }

      // Detect element type
      const elementType = await this.detectElementType(backendNodeId);
      console.log(`[DomService] Element type detected: ${elementType}`);

      // Determine typing method
      // Threshold for switching to paste method for long content
      const LONG_CONTENT_THRESHOLD = 300;

      let method = options?.method || 'auto';
      if (method === 'auto') {
        // Auto-detect best method based on element type AND content length
        if (text.length > LONG_CONTENT_THRESHOLD) {
          // For long content (>300 chars), always use paste for efficiency
          method = 'paste';
          console.log(`[DomService] Long content detected (${text.length} chars > ${LONG_CONTENT_THRESHOLD}), using paste method`);
        } else if (elementType === 'contenteditable') {
          // For short content in rich text editors, use char-by-char
          method = 'char-by-char';
        } else {
          // For short content in simple inputs, use instant
          method = 'instant';
        }
      }
      console.log(`[DomService] Using typing method: ${method}`);

      // 1. Robust Focus: Scroll into view and Click
      await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId });

      // Get box model for coordinates to click (ensures focus works on complex frameworks)
      let boxModel;
      try {
        boxModel = await this.sendCommand<any>('DOM.getBoxModel', { backendNodeId });
      } catch (e) {
        // Fallback if box model fails (e.g. SVG), just try DOM.focus
      }

      if (boxModel) {
        const { content } = boxModel.model;
        const centerX = (content[0] + content[2]) / 2;
        const centerY = (content[1] + content[5]) / 2;

        await this.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: centerX,
          y: centerY,
          button: 'left',
          clickCount: 1
        });
        await this.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: centerX,
          y: centerY,
          button: 'left',
          clickCount: 1
        });
      } else {
        // Fallback
        await this.sendCommand('DOM.focus', { backendNodeId });
      }

      // Wait a bit for focus to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // 2. Clear if requested
      if (options?.clearFirst) {
        if (elementType === 'contenteditable') {
          // Use special clearing for contenteditable elements
          await this.clearContentEditable(backendNodeId);
        } else {
          // For input/textarea elements
          const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });

          if (resolveResult?.object?.objectId) {
            // Clear the input value and fire events
            await this.sendCommand('Runtime.callFunctionOn', {
              objectId: resolveResult.object.objectId,
              functionDeclaration: `function() {
                // Set value to empty string
                this.value = '';

                // Fire input event (React listens to this)
                const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                this.dispatchEvent(inputEvent);

                // Fire change event
                const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                this.dispatchEvent(changeEvent);

                return { cleared: true };
              }`,
              returnByValue: true
            });

            // Release the object reference
            await this.sendCommand('Runtime.releaseObject', {
              objectId: resolveResult.object.objectId
            }).catch(() => { });

            // Wait for framework to process events
            await new Promise(resolve => setTimeout(resolve, 50));
          } else {
            // Fallback to keyboard method if resolve fails
            console.warn('[DomService] Could not resolve node for clearing, falling back to keyboard method');
            await this.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'a',
              code: 'KeyA',
              modifiers: 2 // Ctrl
            });
            await this.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
              modifiers: 2
            });
            await this.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Backspace',
              code: 'Backspace'
            });
            await this.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Backspace',
              code: 'Backspace'
            });
          }
        }
      }

      // 3. Type text using the appropriate method
      if (method === 'char-by-char') {
        // Character-by-character typing (best for rich text editors)
        const speed = options?.speed !== undefined ? options.speed : 50; // Default 50ms between chars
        await this.typeCharByChar(text, speed);
      } else if (method === 'paste') {
        // Paste simulation (fast, works for rich text editors)
        await this.typePaste(text, backendNodeId);
      } else {
        // Instant typing (CDP Input.insertText, works for simple inputs)
        await this.sendCommand('Input.insertText', { text });

        // For React controlled components, additionally fire events
        if (elementType === 'input' || elementType === 'textarea') {
          try {
            const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
            if (resolveResult?.object?.objectId) {
              await this.sendCommand('Runtime.callFunctionOn', {
                objectId: resolveResult.object.objectId,
                functionDeclaration: `function() {
                  const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                  this.dispatchEvent(inputEvent);
                  const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                  this.dispatchEvent(changeEvent);
                  return { value: this.value };
                }`,
                returnByValue: true
              });
              await this.sendCommand('Runtime.releaseObject', {
                objectId: resolveResult.object.objectId
              }).catch(() => { });
            }
          } catch (error) {
            console.debug('[DomService] Could not fire additional events after typing');
          }
        }
      }

      // 4. Commit (Enter) if requested or implied
      if (options?.commit === 'enter' || text.endsWith('\n')) {
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter'
        });
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter'
        });
      }

      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('type', duration, true);

      return {
        success: true,
        duration,
        changes: {
          navigationOccurred: false,
          domMutations: 1,
          scrollChanged: false,
          valueChanged: true,
          newValue: text
        },
        nodeId: nodeId, // Return the original sequential ID that LLM provided
        actionType: 'type',
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('type', duration, false, error.message);

      return {
        success: false,
        duration,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: nodeId, // Return the original sequential ID that LLM provided
        actionType: 'type',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Scroll by relative offset (delta)
   * @param nodeId - Target node ID (use NODE_ID_WINDOW/-1 for window scroll, or frame-scoped like "1:-1" for iframe scroll)
   * @param scrollX - Horizontal scroll offset in pixels (positive = right, negative = left), defaults to 0
   * @param scrollY - Vertical scroll offset in pixels (positive = down, negative = up), defaults to 80% of window height
   */
  async scroll(nodeId: number | string, scrollX: number = 0, scrollY?: number): Promise<ActionResult> {
    const start = Date.now();

    // Parse frame-scoped node ID, default to main frame window scroll on failure
    let parsedId;
    try {
      parsedId = parseNodeId(nodeId);
    } catch (error: any) {
      console.warn(`[DomService] scroll: parseNodeId failed for "${nodeId}", defaulting to main frame window scroll: ${error.message}`);
      parsedId = { frameId: 0, backendNodeId: NODE_ID_WINDOW };
    }

    try {
      // Capture scroll position BEFORE scroll
      let beforeScrollPos: { x: number; y: number } = { x: 0, y: 0 };
      let afterScrollPos: { x: number; y: number } = { x: 0, y: 0 };
      let scrollLimitReached = false;

      // actualScrollY will be computed based on scroll context if not provided or 0
      let actualScrollY = scrollY;

      // Handle window/document scroll (backendNodeId === -1)
      if (parsedId.backendNodeId === NODE_ID_WINDOW) {
        if (parsedId.frameId === 0) {
          // Main frame window scroll - capture before position
          const beforeResult = await this.sendCommand<any>('Runtime.evaluate', {
            expression: '({ x: window.scrollX, y: window.scrollY, maxX: document.documentElement.scrollWidth - window.innerWidth, maxY: document.documentElement.scrollHeight - window.innerHeight, viewportHeight: window.innerHeight })',
            returnByValue: true
          });
          beforeScrollPos = { x: beforeResult.result.value.x, y: beforeResult.result.value.y };
          const maxScroll = { x: beforeResult.result.value.maxX, y: beforeResult.result.value.maxY };

          // Get default scrollY if not provided or 0: 80% of main window height
          if (!actualScrollY) {
            const windowHeight = beforeResult.result.value.viewportHeight || 600;
            actualScrollY = Math.floor(windowHeight * 0.8);
          }

          // Execute scroll
          await this.sendCommand('Runtime.evaluate', {
            expression: `window.scrollTo({ left: window.scrollX + ${scrollX}, top: window.scrollY + ${actualScrollY}, behavior: 'smooth' })`,
            returnByValue: false
          });

          // Wait for smooth scroll animation to complete
          await new Promise(resolve => setTimeout(resolve, 500));

          // Capture after position
          const afterResult = await this.sendCommand<any>('Runtime.evaluate', {
            expression: '({ x: window.scrollX, y: window.scrollY })',
            returnByValue: true
          });
          afterScrollPos = { x: afterResult.result.value.x, y: afterResult.result.value.y };

          // Check if we hit scroll limits
          scrollLimitReached = (
            (actualScrollY > 0 && afterScrollPos.y >= maxScroll.y) || // scrolling down and hit bottom
            (actualScrollY < 0 && afterScrollPos.y <= 0) || // scrolling up and hit top
            (scrollX > 0 && afterScrollPos.x >= maxScroll.x) || // scrolling right and hit right edge
            (scrollX < 0 && afterScrollPos.x <= 0) // scrolling left and hit left edge
          );
        } else {
          // Iframe window scroll - need to scroll the iframe's document
          if (!this.currentSnapshot) {
            throw new Error('NODE_NOT_FOUND: No snapshot available');
          }

          const frameMetadata = this.currentSnapshot.frameRegistry.getFrame(parsedId.frameId);
          if (!frameMetadata) {
            throw new Error(`FRAME_NOT_FOUND: Frame ${parsedId.frameId} not found in snapshot`);
          }

          // Resolve the iframe element and scroll its content document
          const resolveResult = await this.sendCommand<any>('DOM.resolveNode', {
            backendNodeId: frameMetadata.backendNodeId
          });

          if (!resolveResult?.object?.objectId) {
            throw new Error(`RESOLVE_FAILED: Could not resolve iframe element for frame ${parsedId.frameId}`);
          }

          // Capture before position and iframe dimensions
          const beforeResult = await this.sendCommand<any>('Runtime.callFunctionOn', {
            objectId: resolveResult.object.objectId,
            functionDeclaration: `function() {
              if (this.contentWindow) {
                return {
                  x: this.contentWindow.scrollX,
                  y: this.contentWindow.scrollY,
                  maxX: this.contentWindow.document.documentElement.scrollWidth - this.contentWindow.innerWidth,
                  maxY: this.contentWindow.document.documentElement.scrollHeight - this.contentWindow.innerHeight,
                  iframeHeight: this.offsetHeight || this.clientHeight || 0
                };
              }
              return { x: 0, y: 0, maxX: 0, maxY: 0, iframeHeight: 0 };
            }`,
            returnByValue: true
          });
          beforeScrollPos = { x: beforeResult.result.value.x, y: beforeResult.result.value.y };
          const maxScroll = { x: beforeResult.result.value.maxX, y: beforeResult.result.value.maxY };

          // Get default scrollY if not provided or 0: 80% of iframe's offsetHeight
          if (!actualScrollY) {
            const iframeHeight = beforeResult.result.value.iframeHeight || 600;
            actualScrollY = Math.floor(iframeHeight * 0.8);
          }

          // Scroll the iframe's content window
          await this.sendCommand('Runtime.callFunctionOn', {
            objectId: resolveResult.object.objectId,
            functionDeclaration: `function() {
              if (this.contentWindow) {
                this.contentWindow.scrollTo({
                  left: this.contentWindow.scrollX + ${scrollX},
                  top: this.contentWindow.scrollY + ${actualScrollY},
                  behavior: 'smooth'
                });
              }
            }`,
            returnByValue: false
          });

          // Wait for animation
          await new Promise(resolve => setTimeout(resolve, 500));

          // Capture after position
          const afterResult = await this.sendCommand<any>('Runtime.callFunctionOn', {
            objectId: resolveResult.object.objectId,
            functionDeclaration: `function() {
              if (this.contentWindow) {
                return { x: this.contentWindow.scrollX, y: this.contentWindow.scrollY };
              }
              return { x: 0, y: 0 };
            }`,
            returnByValue: true
          });
          afterScrollPos = { x: afterResult.result.value.x, y: afterResult.result.value.y };

          // Check scroll limits
          scrollLimitReached = (
            (actualScrollY > 0 && afterScrollPos.y >= maxScroll.y) ||
            (actualScrollY < 0 && afterScrollPos.y <= 0) ||
            (scrollX > 0 && afterScrollPos.x >= maxScroll.x) ||
            (scrollX < 0 && afterScrollPos.x <= 0)
          );

          // Release the object reference
          await this.sendCommand('Runtime.releaseObject', {
            objectId: resolveResult.object.objectId
          }).catch(() => { });
        }
      } else {
        // Scroll specific element by relative offset
        if (!this.currentSnapshot) {
          throw new Error('NODE_NOT_FOUND: No snapshot available');
        }

        // Validate frame exists
        if (!this.currentSnapshot.frameRegistry.hasFrame(parsedId.frameId)) {
          throw new Error(`FRAME_NOT_FOUND: Frame ${parsedId.frameId} not found in snapshot`);
        }

        const backendNodeId = parsedId.backendNodeId;

        // Verify node exists in snapshot
        const node = this.currentSnapshot.getNodeByBackendId(backendNodeId);
        if (!node) {
          throw new Error(`NODE_NOT_FOUND: Node ${nodeId} not found`);
        }

        // Use CDP DOM.resolveNode to get a RemoteObject reference to the element
        const resolveResult = await this.sendCommand<any>('DOM.resolveNode', {
          backendNodeId
        });

        if (!resolveResult?.object?.objectId) {
          throw new Error(`RESOLVE_FAILED: Could not resolve node ${nodeId}`);
        }

        // Capture before position and container dimensions
        const beforeResult = await this.sendCommand<any>('Runtime.callFunctionOn', {
          objectId: resolveResult.object.objectId,
          functionDeclaration: `function() {
            return {
              x: this.scrollLeft,
              y: this.scrollTop,
              maxX: this.scrollWidth - this.clientWidth,
              maxY: this.scrollHeight - this.clientHeight,
              containerHeight: this.clientHeight || 0
            };
          }`,
          returnByValue: true
        });
        beforeScrollPos = { x: beforeResult.result.value.x, y: beforeResult.result.value.y };
        const maxScroll = { x: beforeResult.result.value.maxX, y: beforeResult.result.value.maxY };

        // Get default scrollY if not provided or 0: 80% of container's clientHeight (min 100px if height is 0)
        if (!actualScrollY) {
          const containerHeight = beforeResult.result.value.containerHeight;
          actualScrollY = containerHeight > 0 ? Math.floor(containerHeight * 0.8) : 100;
        }

        // Execute scroll with smooth animation
        await this.sendCommand('Runtime.callFunctionOn', {
          objectId: resolveResult.object.objectId,
          functionDeclaration: `function() { this.scrollTo({ left: this.scrollLeft + ${scrollX}, top: this.scrollTop + ${actualScrollY}, behavior: 'smooth' }); }`,
          returnByValue: false
        });

        // Wait for animation
        await new Promise(resolve => setTimeout(resolve, 500));

        // Capture after position
        const afterResult = await this.sendCommand<any>('Runtime.callFunctionOn', {
          objectId: resolveResult.object.objectId,
          functionDeclaration: `function() { return { x: this.scrollLeft, y: this.scrollTop }; }`,
          returnByValue: true
        });
        afterScrollPos = { x: afterResult.result.value.x, y: afterResult.result.value.y };

        // Check scroll limits
        scrollLimitReached = (
          (actualScrollY > 0 && afterScrollPos.y >= maxScroll.y) ||
          (actualScrollY < 0 && afterScrollPos.y <= 0) ||
          (scrollX > 0 && afterScrollPos.x >= maxScroll.x) ||
          (scrollX < 0 && afterScrollPos.x <= 0)
        );

        // Release the object reference to prevent memory leaks
        await this.sendCommand('Runtime.releaseObject', {
          objectId: resolveResult.object.objectId
        }).catch(() => { }); // Ignore errors on cleanup
      }

      this.invalidateSnapshot();

      const duration = Date.now() - start;

      // Calculate actual scroll delta
      const actualDelta = {
        x: afterScrollPos.x - beforeScrollPos.x,
        y: afterScrollPos.y - beforeScrollPos.y
      };

      // Determine if scroll actually changed
      const scrollChanged = actualDelta.x !== 0 || actualDelta.y !== 0;

      this.trackActionMetrics('scroll', duration, scrollChanged);

      return {
        success: scrollChanged,
        duration,
        ...(scrollChanged ? {} : { error: 'Scroll position did not change' }),
        changes: {
          navigationOccurred: false,
          domMutations: scrollChanged ? 1 : 0,
          scrollChanged,
          previousScrollPosition: beforeScrollPos,
          currentScrollPosition: afterScrollPos,
          actualScrollDelta: actualDelta,
          scrollLimitReached,
          valueChanged: false
        },
        nodeId: nodeId,
        actionType: 'scroll',
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('scroll', duration, false, error.message);

      return {
        success: false,
        duration,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: nodeId,
        actionType: 'scroll',
        timestamp: new Date().toISOString()
      };
    }
  }

  async keypress(key: string, modifiers?: string[]): Promise<ActionResult> {
    const start = Date.now();

    try {
      let modifierBits = 0;
      if (modifiers) {
        if (modifiers.includes('Ctrl')) modifierBits |= 2;
        if (modifiers.includes('Shift')) modifierBits |= 8;
        if (modifiers.includes('Alt')) modifierBits |= 1;
        if (modifiers.includes('Meta')) modifierBits |= 4;
      }

      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: `Key${key.toUpperCase()}`,
        modifiers: modifierBits
      });

      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: `Key${key.toUpperCase()}`,
        modifiers: modifierBits
      });

      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('keypress', duration, true);

      return {
        success: true,
        duration,
        changes: {
          navigationOccurred: false,
          domMutations: 1,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: NODE_ID_DOCUMENT,
        actionType: 'keypress',
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('keypress', duration, false, error.message);

      return {
        success: false,
        duration,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: NODE_ID_DOCUMENT,
        actionType: 'keypress',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Scroll element into view with configurable alignment
   */
  async scrollIntoView(
    nodeId: number | string,
    options?: { block?: 'start' | 'center' | 'end' | 'nearest'; inline?: 'start' | 'center' | 'end' | 'nearest' }
  ): Promise<ActionResult> {
    const start = Date.now();

    // Parse frame-scoped node ID
    let parsedId;
    try {
      parsedId = parseNodeId(nodeId);
    } catch (error: any) {
      return {
        success: false,
        duration: Date.now() - start,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId: typeof nodeId === 'number' ? nodeId : -1,
        actionType: 'scroll',
        timestamp: new Date().toISOString()
      };
    }

    try {
      const backendNodeId = parsedId.backendNodeId;

      // Use CDP's scrollIntoViewIfNeeded for basic scrolling
      await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId });

      // If specific alignment options provided, use JavaScript scrollIntoView
      if (options?.block || options?.inline) {
        const scrollOptions = JSON.stringify({
          behavior: 'smooth',
          block: options.block || 'center',
          inline: options.inline || 'nearest'
        });

        await this.sendCommand('Runtime.evaluate', {
          expression: `
            (function() {
              const node = document.querySelector('[data-node-id="${nodeId}"]');
              if (node) {
                node.scrollIntoView(${scrollOptions});
              }
            })()
          `,
          returnByValue: true
        });
      }

      // Wait for scroll animation to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('scroll', duration, true);

      return {
        success: true,
        duration,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: true,
          valueChanged: false
        },
        nodeId,
        actionType: 'scroll',
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      this.invalidateSnapshot();

      const duration = Date.now() - start;
      this.trackActionMetrics('scroll', duration, false, error.message);

      return {
        success: false,
        duration,
        error: error.message,
        changes: {
          navigationOccurred: false,
          domMutations: 0,
          scrollChanged: false,
          valueChanged: false
        },
        nodeId,
        actionType: 'scroll',
        timestamp: new Date().toISOString()
      };
    }
  }

  // Performance metrics tracking helper
  private trackActionMetrics(actionType: 'click' | 'type' | 'scroll' | 'keypress', duration: number, success: boolean, error?: string): void {
    if (!this.config.enableMetrics) return;

    this.metrics.actionCount++;
    this.metrics.actionsByType[actionType]++;
    this.metrics.totalActionDuration += duration;
    this.metrics.averageActionDuration = this.metrics.totalActionDuration / this.metrics.actionCount;

    if (!success && error) {
      this.metrics.errorCount++;
      const errorType = error.split(':')[0] || 'UNKNOWN_ERROR';
      this.metrics.errorsByType[errorType] = (this.metrics.errorsByType[errorType] || 0) + 1;
    }
  }

  // Get current performance metrics
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  // Reset performance metrics
  resetMetrics(): void {
    this.metrics = {
      snapshotCount: 0,
      snapshotCacheHits: 0,
      snapshotCacheMisses: 0,
      totalSnapshotDuration: 0,
      averageSnapshotDuration: 0,
      actionCount: 0,
      actionsByType: {
        click: 0,
        type: 0,
        scroll: 0,
        keypress: 0
      },
      totalActionDuration: 0,
      averageActionDuration: 0,
      errorCount: 0,
      errorsByType: {},
      lastReset: new Date()
    };
  }

  // Get metrics summary for logging
  getMetricsSummary(): string {
    const cacheHitRate = this.metrics.snapshotCacheHits + this.metrics.snapshotCacheMisses > 0
      ? ((this.metrics.snapshotCacheHits / (this.metrics.snapshotCacheHits + this.metrics.snapshotCacheMisses)) * 100).toFixed(1)
      : '0.0';

    return `
[DomService Performance Metrics]
Snapshots: ${this.metrics.snapshotCount} (avg ${this.metrics.averageSnapshotDuration.toFixed(0)}ms)
Cache Hit Rate: ${cacheHitRate}% (${this.metrics.snapshotCacheHits} hits, ${this.metrics.snapshotCacheMisses} misses)
Actions: ${this.metrics.actionCount} (avg ${this.metrics.averageActionDuration.toFixed(0)}ms)
  - Click: ${this.metrics.actionsByType.click}
  - Type: ${this.metrics.actionsByType.type}
  - Scroll: ${this.metrics.actionsByType.scroll}
  - Keypress: ${this.metrics.actionsByType.keypress}
Errors: ${this.metrics.errorCount}
Since: ${this.metrics.lastReset.toISOString()}
    `.trim();
  }
}
