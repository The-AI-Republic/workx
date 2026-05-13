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
import { NODE_ID_DOCUMENT } from './types';
import { computeHeuristics, classifyNode, determineInteractionType, detectFramework, serializedNodeToHtml, computeScrollable, parseNodeId } from './utils';
import type { TypeOptions } from '../../../types/domTool';
import { DomPlugin, type DomPluginContext } from './plugins/DomPlugin';
import { googleDocPlugin } from './plugins/GoogleDocPlugin';
import type { DebuggerClient, CDPEventCallback } from '../../../core/tools/browser/DebuggerClient';
// Static import — forTab() is only used in extension builds where DOMTool is registered.
// Dynamic import() is banned in Chrome extension service workers.
import { ChromeDebuggerClient } from '../browser/ChromeDebuggerClient';

export class DomService {
  private static instances = new Map<string, DomService>();

  private client: DebuggerClient;
  private instanceKey: string;
  private tabId: number;
  private isAttached: boolean = false;
  private currentSnapshot: DomSnapshot | null = null;
  private config: ServiceConfig;
  private metrics: PerformanceMetrics; // Performance metrics tracking
  private plugins: DomPlugin[] = [googleDocPlugin]; // DOM plugins for special content handling

  private constructor(client: DebuggerClient, instanceKey: string, config?: Partial<ServiceConfig>) {
    this.client = client;
    this.instanceKey = instanceKey;
    this.tabId = -1; // Set by factory methods
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

  /**
   * Extension factory: creates/reuses a DomService for a Chrome tab.
   * Only used in extension builds (DOMTool, PageVisionTool).
   */
  static async forTab(tabId: number, config?: Partial<ServiceConfig>): Promise<DomService> {
    const key = `tab:${tabId}`;
    if (!this.instances.has(key)) {
      const client = new ChromeDebuggerClient();
      try {
        await client.attach({ tabId });
      } catch (error: any) {
        if (error.message?.toLowerCase().includes('already attached')) {
          throw new Error('ALREADY_ATTACHED: DevTools is open on this tab. Please close DevTools.');
        }
        throw new Error(`ATTACH_FAILED: ${error.message}`);
      }
      const service = new DomService(client, key, config);
      service.tabId = tabId;
      await service.enableDomains();
      service.setupEventListeners();
      this.instances.set(key, service);
    }
    return this.instances.get(key)!;
  }

  /**
   * Desktop factory: creates/reuses a DomService for a pre-attached DebuggerClient.
   * The client must already be attached before calling this method.
   */
  static async forClient(client: DebuggerClient, key: string, config?: Partial<ServiceConfig>): Promise<DomService> {
    if (!this.instances.has(key)) {
      if (!client.isAttached()) {
        throw new Error('DebuggerClient must be attached before creating DomService');
      }
      const service = new DomService(client, key, config);
      service.tabId = -1;
      await service.enableDomains();
      service.setupEventListeners();
      this.instances.set(key, service);
    }
    return this.instances.get(key)!;
  }

  /**
   * Enable required CDP domains.
   * Called by factory methods after client is attached.
   */
  private async enableDomains(): Promise<void> {
    this.isAttached = true;
    await this.client.enableDomain('DOM');
    await this.client.enableDomain('Accessibility');
    await this.client.enableDomain('Page');
  }

  /**
   * Set up event listeners for CDP events and debugger detach.
   * Called by factory methods after domains are enabled.
   */
  private setupEventListeners(): void {
    // Listen for CDP events (e.g. DOM.documentUpdated) via the client
    this.boundHandleCdpEvent = this.handleCdpEvent.bind(this);
    this.client.onEvent(this.boundHandleCdpEvent);

    // Listen for debugger detach (extension-only, chrome.debugger.onDetach)
    if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
      this.boundHandleDebuggerDetach = this.handleDebuggerDetach.bind(this);
      chrome.debugger.onDetach.addListener(this.boundHandleDebuggerDetach);
    }
  }

  // Bound event handler references for cleanup
  private boundHandleCdpEvent: CDPEventCallback | null = null;
  private boundHandleDebuggerDetach: ((source: chrome.debugger.Debuggee, reason: string) => void) | null = null;

  async detach(): Promise<void> {
    if (!this.isAttached) return;

    try {
      // Remove event listeners
      if (this.boundHandleCdpEvent) {
        this.client.offEvent(this.boundHandleCdpEvent);
        this.boundHandleCdpEvent = null;
      }
      if (this.boundHandleDebuggerDetach && typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
        chrome.debugger.onDetach.removeListener(this.boundHandleDebuggerDetach);
        this.boundHandleDebuggerDetach = null;
      }

      await this.client.detach();
      this.isAttached = false;
      this.currentSnapshot = null;
      DomService.instances.delete(this.instanceKey);
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

        // Wait for load event via DebuggerClient
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.client.offEvent(eventListener);
            reject(new Error('PAGE_LOAD_TIMEOUT: Page did not finish loading within 30 seconds'));
          }, 30000); // 30 second timeout

          const eventListener: CDPEventCallback = (method: string) => {
            if (method === 'Page.loadEventFired') {
              clearTimeout(timeout);
              this.client.offEvent(eventListener);
              console.log('[DomService] Page load event fired');
              resolve();
            }
          };

          this.client.onEvent(eventListener);
        });
      }

      // Step 2: Check for SPA loading indicators and wait for meaningful content
      console.log('[DomService] Checking for SPA content rendering...');

      const maxWaitForContent = 15000; // 15 seconds max wait for SPA content
      const checkInterval = 1000; // Check every 1s
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

    // Wait for page to finish loading before accessing DOM
    await this.waitForPageLoad();

    const start = Date.now();

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

    // Build per-frame accessibility maps: frameId (CDP string) → Map<backendNodeId, AXNode>
    // Main frame uses empty string '' as key (main frame nodes have no frameId property)
    // Iframes use their CDP frameId (e.g., "FC1382D98FABCC3C7AE375DF3174A884")
    const axMapByFrame = new Map<string, Map<number, any>>();

    // Initialize main frame accessibility map
    const mainFrameAxMap = new Map<number, any>();
    if (axTree?.nodes) {
      for (const axNode of axTree.nodes) {
        if (axNode.backendDOMNodeId) {
          mainFrameAxMap.set(axNode.backendDOMNodeId, axNode);
        }
      }
    }
    axMapByFrame.set('', mainFrameAxMap); // Main frame: empty string (nodes have undefined frameId)

    // Collect iframe frameIds from DOM tree for per-frame accessibility fetching
    const iframeFrameIds: string[] = [];
    const collectIframeFrameIds = (node: any) => {
      if (node.contentDocument && node.contentDocument.children) {
        // The HTML element inside contentDocument has the frameId
        for (const child of node.contentDocument.children) {
          if (child.frameId && !iframeFrameIds.includes(child.frameId)) {
            iframeFrameIds.push(child.frameId);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectIframeFrameIds(child);
        }
      }
    };
    collectIframeFrameIds(domTree.root);

    // Fetch accessibility trees for each iframe (up to MAX_IFRAMES)
    const MAX_IFRAMES = 5;
    for (let i = 0; i < Math.min(iframeFrameIds.length, MAX_IFRAMES); i++) {
      const frameId = iframeFrameIds[i];
      try {
        const iframeAxTree = await this.sendCommand<any>('Accessibility.getFullAXTree', {
          depth: -1,
          frameId: frameId
        });

        if (iframeAxTree?.nodes) {
          const frameAxMap = new Map<number, any>();
          for (const axNode of iframeAxTree.nodes) {
            if (axNode.backendDOMNodeId) {
              frameAxMap.set(axNode.backendDOMNodeId, axNode);
            }
          }
          axMapByFrame.set(frameId, frameAxMap);
          console.log(`[DomService] Fetched accessibility tree for iframe ${frameId}: ${frameAxMap.size} nodes`);
        }
      } catch (error: any) {
        console.warn(`[DomService] Could not fetch accessibility tree for iframe ${frameId}: ${error.message}`);
        // Continue without accessibility data for this iframe - classifyNode will use fallback
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

    // Build virtual DOM tree with per-frame accessibility support
    // currentCdpFrameId: CDP frame ID string ('' for main frame, e.g., "FC1382D98FABCC3C7AE375DF3174A884" for iframes)
    const buildVirtualTree = (cdpNode: any, depth: number = 0, iframeDepth: number = 0, currentFrameIndex: number = 0, currentCdpFrameId: string = ''): VirtualNode | null => {
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

      // Get accessibility map for the current frame
      // If node has its own frameId, use that; otherwise use the current frame's CDP frameId
      // Main frame nodes have undefined frameId, which becomes '' (empty string)
      const nodeFrameId = cdpNode.frameId || currentCdpFrameId;
      const axMap = axMapByFrame.get(nodeFrameId) || axMapByFrame.get('') || new Map();
      const axNode = axMap.get(backendNodeId);

      const heuristics = computeHeuristics(cdpNode.attributes);
      const layoutData = layoutMap.get(backendNodeId); // Get layout data

      // Pass cdpNode to classifyNode for HTML tag fallback when axNode is unavailable
      const tier = classifyNode(axNode, heuristics, cdpNode);

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
          .map((c: any) => buildVirtualTree(c, depth + 1, iframeDepth, currentFrameIndex, currentCdpFrameId))
          .filter((n: VirtualNode | null) => n !== null) as VirtualNode[];
      }

      // Recurse to shadow roots
      if (cdpNode.shadowRoots) {
        vNode.shadowRoots = cdpNode.shadowRoots
          .map((c: any) => buildVirtualTree(c, depth + 1, iframeDepth, currentFrameIndex, currentCdpFrameId))
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

          // Get the CDP frameId from the iframe's content document
          // The HTML element inside contentDocument typically has the frameId
          let iframeCdpFrameId = '';
          if (cdpNode.contentDocument.children) {
            for (const child of cdpNode.contentDocument.children) {
              if (child.frameId) {
                iframeCdpFrameId = child.frameId;
                break;
              }
            }
          }

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

          const contentDoc = buildVirtualTree(cdpNode.contentDocument, depth + 1, nextIframeDepth, newFrameIndex, iframeCdpFrameId);
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

    // Get page info via CDP (platform-agnostic, no chrome.tabs dependency)
    const pageMetadata = await this.getPageMetadata();
    const pageUrl = pageMetadata.url;
    const pageTitle = pageMetadata.title;

    // Run DOM plugins to augment the tree with special content (e.g., Google Docs)
    await this.runPlugins(virtualDom, pageUrl, pageTitle);

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

    // Fetch viewport dimensions, scroll position, and page dimensions from the page
    // Fallback values assume viewport = page (no overflow) if Runtime.evaluate fails
    let viewportData = {
      width: pageMetadata.width || 0,
      height: pageMetadata.height || 0,
      scrollX: 0,
      scrollY: 0,
      pageWidth: pageMetadata.width || 0,  // Fallback: assume page width = viewport width (no horizontal overflow)
      pageHeight: pageMetadata.height || 0, // Fallback: assume page height = viewport height (no vertical overflow)
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
      url: pageUrl,
      title: pageTitle,
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

  /**
   * Run all registered DOM plugins to augment the tree
   * Plugins can add special content that isn't accessible via standard DOM APIs
   * (e.g., Google Docs canvas content)
   */
  private async runPlugins(tree: VirtualNode, url: string, title: string): Promise<void> {
    const context: DomPluginContext = {
      tabId: this.tabId,
      url,
      title,
      sendCommand: this.sendCommand.bind(this)
    };

    for (const plugin of this.plugins) {
      await plugin.read(tree, context);
    }
  }

  private async sendCommand<T>(method: string, params: any): Promise<T> {
    return this.client.sendCommand<T>(method, params);
  }

  /**
   * Get page metadata via CDP Runtime.evaluate (platform-agnostic).
   * Replaces chrome.tabs.get() which is only available in extension mode.
   */
  private async getPageMetadata(): Promise<{ url: string; title: string; width?: number; height?: number }> {
    try {
      const result = await this.client.sendCommand<any>('Runtime.evaluate', {
        expression: '({ url: window.location.href, title: document.title, width: window.innerWidth, height: window.innerHeight })',
        returnByValue: true
      });
      return result.result.value;
    } catch {
      return { url: '', title: '' };
    }
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

  private handleCdpEvent(method: string, params?: unknown): void {
    if (method === 'DOM.documentUpdated') {
      // Proactively rebuild snapshot for faster next access
      this.buildSnapshot().catch((error) => {
        console.debug('[DomService] Background snapshot rebuild failed:', error.message);
        this.invalidateSnapshot(); // Fallback to invalidation on error
      });
    }
  }

  // Handle CDP connection loss (extension-only, chrome.debugger.onDetach)
  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId !== this.tabId) return;

    console.error(`[DomService] CDP_CONNECTION_LOST: Debugger detached from tab ${this.tabId}. Reason: ${reason}`);
    this.isAttached = false;
    this.currentSnapshot = null;
    DomService.instances.delete(this.instanceKey);

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
    //     expression: '!!window.__pi_visual_effects_initialized__',
    //     returnByValue: true
    //   });

    //   const isInitialized = checkResult?.result?.value === true;

    //   if (!isInitialized) {
    //     console.log(`[DomService] Initializing visual effects on tab ${this.tabId}...`);

    //     // Dispatch init event to trigger lazy initialization
    //     await this.sendCommand('Runtime.evaluate', {
    //       expression: `
    //         (function() {
    //           const event = new CustomEvent('pi:init-visual-effects', {
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

      // Resolve node with frame-aware disambiguation
      // This handles the case where backendNodeId is not globally unique across iframes
      const node = this.currentSnapshot.resolveNodeByBackendIdAndFrame(backendNodeId, parsedId.frameId);
      if (!node) {
        throw new Error(`NODE_NOT_FOUND: Node ${nodeId} not found in snapshot`);
      }

      // Use the resolved node's backendNodeId for CDP commands
      // (in case we found the node in a different frame than specified)
      const resolvedBackendNodeId = node.backendNodeId;

      // Get box model for coordinates
      let boxModel;
      try {
        boxModel = await this.sendCommand<any>('DOM.getBoxModel', { backendNodeId: resolvedBackendNodeId });
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
          await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: resolvedBackendNodeId });

          // Wait for scroll animation to complete
          await new Promise(resolve => setTimeout(resolve, 100));

          // Get box model AGAIN after scrolling (element position has changed)
          const updatedBoxModel = await this.sendCommand<any>('DOM.getBoxModel', { backendNodeId: resolvedBackendNodeId });
          content = updatedBoxModel.model.content;

          // Recalculate center coordinates with new position
          centerX = (content[0] + content[2]) / 2;
          centerY = (content[1] + content[5]) / 2;
        }
      } else {
        // Visual effects disabled - still scroll into view if needed, but don't wait
        await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: resolvedBackendNodeId }).catch(() => { });
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

      // Invalidate snapshot - let getSerializedDom() rebuild when needed
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

      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
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
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
    }
  }

  /**
   * Set cursor position or select a range in input/textarea elements.
   * Uses selectionStart/selectionEnd properties.
   * @param backendNodeId - The backend node ID of the input/textarea
   * @param start - Start position (cursor position if end equals start)
   * @param end - End position (same as start for cursor positioning)
   */
  private async setSelectionForInput(
    backendNodeId: number,
    start: number,
    end: number
  ): Promise<void> {
    const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
    if (!resolveResult?.object?.objectId) {
      throw new Error('Could not resolve node for selection');
    }

    try {
      await this.sendCommand('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function(start, end) {
          // Ensure element is focused
          this.focus();

          // Clamp values to valid range
          const len = this.value ? this.value.length : 0;
          const clampedStart = Math.max(0, Math.min(start, len));
          const clampedEnd = Math.max(0, Math.min(end, len));

          // Set selection range
          this.setSelectionRange(clampedStart, clampedEnd);

          return { start: clampedStart, end: clampedEnd, length: len };
        }`,
        arguments: [
          { value: start },
          { value: end }
        ],
        returnByValue: true
      });

      // Wait for selection to settle
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
    }
  }

  /**
   * Set cursor position or select a range in contenteditable elements.
   * Uses the Selection API with text node traversal.
   * @param backendNodeId - The backend node ID of the contenteditable element
   * @param start - Start character position (cursor position if end equals start)
   * @param end - End character position (same as start for cursor positioning)
   */
  private async setSelectionForContentEditable(
    backendNodeId: number,
    start: number,
    end: number
  ): Promise<void> {
    const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
    if (!resolveResult?.object?.objectId) {
      throw new Error('Could not resolve node for selection');
    }

    try {
      await this.sendCommand('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function(start, end) {
          // Focus the element
          this.focus();

          // Helper to find text node and offset for a character position
          function findPositionInNode(root, targetOffset) {
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_TEXT,
              null,
              false
            );

            let currentOffset = 0;
            let node = walker.nextNode();

            while (node) {
              const nodeLength = node.textContent.length;
              if (currentOffset + nodeLength >= targetOffset) {
                return {
                  node: node,
                  offset: targetOffset - currentOffset
                };
              }
              currentOffset += nodeLength;
              node = walker.nextNode();
            }

            // If position exceeds content, return last position
            // Find last text node
            const allTextNodes = [];
            const walker2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
            let n;
            while (n = walker2.nextNode()) allTextNodes.push(n);

            if (allTextNodes.length > 0) {
              const lastNode = allTextNodes[allTextNodes.length - 1];
              return { node: lastNode, offset: lastNode.textContent.length };
            }

            // No text nodes, return the element itself
            return { node: root, offset: 0 };
          }

          // Get total text length for clamping
          const totalLength = this.textContent ? this.textContent.length : 0;
          const clampedStart = Math.max(0, Math.min(start, totalLength));
          const clampedEnd = Math.max(0, Math.min(end, totalLength));

          const startPos = findPositionInNode(this, clampedStart);
          const endPos = findPositionInNode(this, clampedEnd);

          // Create range and set selection
          const range = document.createRange();
          range.setStart(startPos.node, startPos.offset);
          range.setEnd(endPos.node, endPos.offset);

          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);

          return { start: clampedStart, end: clampedEnd, totalLength };
        }`,
        arguments: [
          { value: start },
          { value: end }
        ],
        returnByValue: true
      });

      // Wait for selection to settle
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
    }
  }

  // ==========================================================================
  // Text-based editing helper methods
  // These methods work with visual text content, ignoring invisible HTML structure
  // ==========================================================================

  /**
   * Find text in an element and return the visual character offsets.
   * Works for both input/textarea and contenteditable elements.
   * Uses the visible text content (ignoring HTML tags/structure).
   *
   * @param backendNodeId - The backend node ID of the element
   * @param searchText - The text to find
   * @param occurrence - Which occurrence to find (0-indexed)
   * @param elementType - The type of element ('input', 'textarea', 'contenteditable')
   * @returns Object with found status and start/end offsets
   */
  private async findTextInElement(
    backendNodeId: number,
    searchText: string,
    occurrence: number,
    elementType: string
  ): Promise<{ found: boolean; startOffset: number; endOffset: number }> {
    const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
    if (!resolveResult?.object?.objectId) {
      throw new Error('Could not resolve node for text search');
    }

    try {
      const result = await this.sendCommand<any>('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function(searchText, occurrence) {
          // Get the visible text content
          let visibleText;
          if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
            visibleText = this.value || '';
          } else {
            // For contenteditable, use textContent which gives us visible text
            visibleText = this.textContent || '';
          }

          // Find all occurrences
          let index = -1;
          let currentOccurrence = -1;

          while (currentOccurrence < occurrence) {
            index = visibleText.indexOf(searchText, index + 1);
            if (index === -1) {
              break;
            }
            currentOccurrence++;
          }

          if (index === -1) {
            return { found: false, startOffset: -1, endOffset: -1 };
          }

          return {
            found: true,
            startOffset: index,
            endOffset: index + searchText.length
          };
        }`,
        arguments: [
          { value: searchText },
          { value: occurrence }
        ],
        returnByValue: true
      });

      return result?.result?.value || { found: false, startOffset: -1, endOffset: -1 };
    } finally {
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
    }
  }

  /**
   * Set selection in an element by visual text offsets.
   * Routes to the appropriate method based on element type.
   *
   * @param backendNodeId - The backend node ID of the element
   * @param start - Start offset in visible text
   * @param end - End offset in visible text
   * @param elementType - The type of element ('input', 'textarea', 'contenteditable')
   */
  private async setSelectionByTextMatch(
    backendNodeId: number,
    start: number,
    end: number,
    elementType: string
  ): Promise<void> {
    if (elementType === 'contenteditable') {
      await this.setSelectionForContentEditable(backendNodeId, start, end);
    } else {
      await this.setSelectionForInput(backendNodeId, start, end);
    }
  }

  /**
   * Find and replace all occurrences of text in an element.
   * Uses visual text matching and handles both input/textarea and contenteditable.
   *
   * @param backendNodeId - The backend node ID of the element
   * @param searchText - The text to find and replace
   * @param replaceText - The replacement text
   * @param elementType - The type of element ('input', 'textarea', 'contenteditable')
   * @returns Object with success status and replacement count
   */
  private async findAndReplaceAllText(
    backendNodeId: number,
    searchText: string,
    replaceText: string,
    elementType: string
  ): Promise<{ success: boolean; replacementCount: number }> {
    const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId });
    if (!resolveResult?.object?.objectId) {
      throw new Error('Could not resolve node for text replacement');
    }

    try {
      const result = await this.sendCommand<any>('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: `function(searchText, replaceText, isContentEditable) {
          // Get the current text
          let originalText;
          if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
            originalText = this.value || '';
          } else {
            originalText = this.textContent || '';
          }

          // Count occurrences
          let count = 0;
          let idx = 0;
          while ((idx = originalText.indexOf(searchText, idx)) !== -1) {
            count++;
            idx += searchText.length;
          }

          if (count === 0) {
            return { success: false, replacementCount: 0 };
          }

          // Perform replacement
          const newText = originalText.split(searchText).join(replaceText);

          if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
            // For input/textarea, set value directly
            this.value = newText;

            // Fire input and change events for React/framework compatibility
            const inputEvent = new Event('input', { bubbles: true, cancelable: true });
            this.dispatchEvent(inputEvent);
            const changeEvent = new Event('change', { bubbles: true, cancelable: true });
            this.dispatchEvent(changeEvent);
          } else {
            // For contenteditable, we need to preserve structure as much as possible
            // Use execCommand for better rich text support
            this.focus();

            // Select all content
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(this);
            selection.removeAllRanges();
            selection.addRange(range);

            // Use insertText which preserves some formatting
            document.execCommand('insertText', false, newText);

            // Fire input event
            const inputEvent = new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: newText
            });
            this.dispatchEvent(inputEvent);
          }

          return { success: true, replacementCount: count };
        }`,
        arguments: [
          { value: searchText },
          { value: replaceText },
          { value: elementType === 'contenteditable' }
        ],
        returnByValue: true
      });

      return result?.result?.value || { success: false, replacementCount: 0 };
    } finally {
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
    }
  }

  /**
   * Apply a formatting keyboard shortcut (e.g., Ctrl+B for bold).
   * Uses CDP modifiers: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
   *
   * @param key - The key to press (e.g., 'b', 'i', 'u')
   * @param modifiers - CDP modifier bits (default 2 for Ctrl)
   */
  private async applyFormattingShortcut(key: string, modifiers: number = 2): Promise<void> {
    const code = `Key${key.toUpperCase()}`;

    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: key,
      code: code,
      modifiers: modifiers
    });
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: key,
      code: code,
      modifiers: modifiers
    });

    // Small delay to let the editor process the formatting
    await new Promise(resolve => setTimeout(resolve, 30));
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
      await this.sendCommand('Runtime.releaseObject', { objectId: resolveResult.object.objectId }).catch(() => { });
    }
  }

  /**
   * Get key code for a character
   */
  private getKeyCode(char: string): string {
    if (char === ' ') return 'Space';
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
      // Validate mutual exclusivity of text-based editing options
      const hasInsertAfter = options?.insertAfter !== undefined;
      const hasInsertBefore = options?.insertBefore !== undefined;
      const hasReplace = options?.replace !== undefined;
      const hasReplaceAll = options?.replaceAll !== undefined;
      const hasClearFirst = options?.clearFirst === true;

      const textBasedOptions = [hasInsertAfter, hasInsertBefore, hasReplace, hasReplaceAll].filter(Boolean);

      if (textBasedOptions.length > 1) {
        throw new Error('VALIDATION_ERROR: Options "insertAfter", "insertBefore", "replace", and "replaceAll" are mutually exclusive');
      }

      if (textBasedOptions.length > 0 && hasClearFirst) {
        throw new Error('VALIDATION_ERROR: Text-based editing options cannot be used with "clearFirst"');
      }

      // Validate string values for text-based options
      if (hasInsertAfter && typeof options!.insertAfter !== 'string') {
        throw new Error('VALIDATION_ERROR: "insertAfter" must be a string');
      }
      if (hasInsertBefore && typeof options!.insertBefore !== 'string') {
        throw new Error('VALIDATION_ERROR: "insertBefore" must be a string');
      }
      if (hasReplace && typeof options!.replace !== 'string') {
        throw new Error('VALIDATION_ERROR: "replace" must be a string');
      }
      if (hasReplaceAll && typeof options!.replaceAll !== 'string') {
        throw new Error('VALIDATION_ERROR: "replaceAll" must be a string');
      }

      // Validate occurrence if provided
      if (options?.occurrence !== undefined) {
        if (typeof options.occurrence !== 'number' || options.occurrence < 0 || !Number.isInteger(options.occurrence)) {
          throw new Error('VALIDATION_ERROR: "occurrence" must be a non-negative integer');
        }
        if (hasReplaceAll) {
          console.warn('[DomService] "occurrence" is ignored when using "replaceAll"');
        }
      }

      if (!this.currentSnapshot) {
        throw new Error('NODE_NOT_FOUND: No snapshot available');
      }

      // Validate frame exists
      if (!this.currentSnapshot.frameRegistry.hasFrame(parsedId.frameId)) {
        throw new Error(`FRAME_NOT_FOUND: Frame ${parsedId.frameId} not found in snapshot`);
      }

      const backendNodeId = parsedId.backendNodeId;

      // Resolve node with frame-aware disambiguation
      // This handles the case where backendNodeId is not globally unique across iframes
      const node = this.currentSnapshot.resolveNodeByBackendIdAndFrame(backendNodeId, parsedId.frameId);
      if (!node) {
        throw new Error(`NODE_NOT_FOUND: Node ${nodeId} not found`);
      }

      // Use the resolved node's backendNodeId for CDP commands
      // (in case we found the node in a different frame than specified)
      const resolvedBackendNodeId = node.backendNodeId;

      // Detect element type
      const elementType = await this.detectElementType(resolvedBackendNodeId);
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
      await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: resolvedBackendNodeId });

      // Get box model for coordinates to click (ensures focus works on complex frameworks)
      let boxModel;
      try {
        boxModel = await this.sendCommand<any>('DOM.getBoxModel', { backendNodeId: resolvedBackendNodeId });
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
        await this.sendCommand('DOM.focus', { backendNodeId: resolvedBackendNodeId });
      }

      // Wait a bit for focus to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // 2. Handle text-based editing options (insertAfter, insertBefore, replace, replaceAll)
      const hasTextBasedEdit = hasInsertAfter || hasInsertBefore || hasReplace || hasReplaceAll;

      if (hasTextBasedEdit) {
        const searchText = options!.insertAfter || options!.insertBefore || options!.replace || options!.replaceAll;
        const occurrence = options?.occurrence ?? 0;

        console.log(`[DomService] Text-based editing: searching for "${searchText}", occurrence=${occurrence}`);

        if (hasReplaceAll) {
          // Replace all occurrences - handled specially
          const replaceResult = await this.findAndReplaceAllText(resolvedBackendNodeId, searchText!, text, elementType);

          if (!replaceResult.success) {
            throw new Error(`TEXT_NOT_FOUND: Could not find "${searchText}" in element`);
          }

          // Invalidate snapshot and return
          this.invalidateSnapshot();

          const duration = Date.now() - start;
          this.trackActionMetrics('type', duration, true);

          return {
            success: true,
            duration,
            changes: {
              navigationOccurred: false,
              domMutations: replaceResult.replacementCount,
              scrollChanged: false,
              valueChanged: true,
              replacedText: searchText,
              replacementCount: replaceResult.replacementCount
            },
            nodeId: nodeId,
            actionType: 'type',
            timestamp: new Date().toISOString()
          };
        } else {
          // Find and position cursor for insertAfter/insertBefore/replace
          const findResult = await this.findTextInElement(resolvedBackendNodeId, searchText!, occurrence, elementType);

          if (!findResult.found) {
            throw new Error(`TEXT_NOT_FOUND: Could not find "${searchText}" (occurrence ${occurrence}) in element`);
          }

          if (hasInsertAfter) {
            // Position cursor after the found text
            await this.setSelectionByTextMatch(resolvedBackendNodeId, findResult.endOffset, findResult.endOffset, elementType);
          } else if (hasInsertBefore) {
            // Position cursor before the found text
            await this.setSelectionByTextMatch(resolvedBackendNodeId, findResult.startOffset, findResult.startOffset, elementType);
          } else if (hasReplace) {
            // Select the found text (typing will replace it)
            await this.setSelectionByTextMatch(resolvedBackendNodeId, findResult.startOffset, findResult.endOffset, elementType);

            // If text is empty (deletion case), delete and return early
            if (text === '') {
              console.log('[DomService] Empty text with replace - deleting selection');
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
                  deletedText: searchText
                },
                nodeId: nodeId,
                actionType: 'type',
                timestamp: new Date().toISOString()
              };
            }
          }
        }
      }

      // 3. Clear if requested
      if (options?.clearFirst) {
        if (elementType === 'contenteditable') {
          // Use special clearing for contenteditable elements
          await this.clearContentEditable(resolvedBackendNodeId);
        } else {
          // For input/textarea elements
          const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId: resolvedBackendNodeId });

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

      // 3a. Insert line break before typing if requested
      if (options?.lineBreak === 'before' || options?.lineBreak === 'both') {
        console.log('[DomService] Inserting line break before text');
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r'
        });
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 3b. Type text using the appropriate method
      const textLength = text.length;
      if (method === 'char-by-char') {
        // Character-by-character typing (best for rich text editors)
        const speed = options?.speed !== undefined ? options.speed : 50; // Default 50ms between chars
        await this.typeCharByChar(text, speed);
      } else if (method === 'paste') {
        // Paste simulation (fast, works for rich text editors)
        await this.typePaste(text, resolvedBackendNodeId);
      } else {
        // Instant typing (CDP Input.insertText, works for simple inputs)
        await this.sendCommand('Input.insertText', { text });

        // For React controlled components, additionally fire events
        if (elementType === 'input' || elementType === 'textarea') {
          try {
            const resolveResult = await this.sendCommand<any>('DOM.resolveNode', { backendNodeId: resolvedBackendNodeId });
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

      // 3c. Apply formatting if requested (only for rich text editors)
      if (options?.format && textLength > 0 && elementType === 'contenteditable') {
        console.log('[DomService] Applying formatting to typed text', options.format);

        // Select the just-typed text by pressing Shift+Left Arrow for each character
        // This is more reliable than trying to calculate positions
        for (let i = 0; i < textLength; i++) {
          await this.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            modifiers: 8 // Shift
          });
          await this.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            modifiers: 8
          });
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        // Apply each formatting option
        if (options.format.bold) {
          await this.applyFormattingShortcut('b', 2); // Ctrl+B
        }
        if (options.format.italic) {
          await this.applyFormattingShortcut('i', 2); // Ctrl+I
        }
        if (options.format.underline) {
          await this.applyFormattingShortcut('u', 2); // Ctrl+U
        }
        if (options.format.strikethrough) {
          // Most editors use Ctrl+Shift+S or Alt+Shift+5
          await this.applyFormattingShortcut('s', 10); // Ctrl+Shift+S (2+8)
        }
        if (options.format.code) {
          // Most editors use Ctrl+` or Ctrl+E for inline code
          await this.applyFormattingShortcut('e', 2); // Ctrl+E
        }

        // Move cursor to end of selection (right arrow)
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'ArrowRight',
          code: 'ArrowRight'
        });
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'ArrowRight',
          code: 'ArrowRight'
        });
      }

      // 3d. Insert line break after typing if requested
      if (options?.lineBreak === 'after' || options?.lineBreak === 'both') {
        console.log('[DomService] Inserting line break after text');
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r'
        });
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
      }

      // 4. Commit (Enter) if explicitly requested
      if (options?.commit === 'enter') {
        // Dispatch Enter key with all necessary properties for cross-site compatibility
        // Some sites (like Google) require windowsVirtualKeyCode and text properties
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r'
        });
        await this.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
      }

      // Invalidate snapshot - let getSerializedDom() rebuild when needed
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
   * Helper method to scroll the main frame window
   * Used as fallback when target node/frame is not found
   */
  private async scrollMainFrame(
    scrollX: number,
    scrollY: number | undefined,
    start: number,
    originalNodeId: number | string
  ): Promise<ActionResult> {
    try {
      // Capture before position and viewport info
      const beforeResult = await this.sendCommand<any>('Runtime.evaluate', {
        expression: '({ x: window.scrollX, y: window.scrollY, maxX: document.documentElement.scrollWidth - window.innerWidth, maxY: document.documentElement.scrollHeight - window.innerHeight, viewportHeight: window.innerHeight })',
        returnByValue: true
      });
      const beforeScrollPos = { x: beforeResult.result.value.x, y: beforeResult.result.value.y };
      const maxScroll = { x: beforeResult.result.value.maxX, y: beforeResult.result.value.maxY };

      // Get default scrollY if not provided or 0: 80% of window height
      let actualScrollY = scrollY;
      if (!actualScrollY) {
        const windowHeight = beforeResult.result.value.viewportHeight || 600;
        actualScrollY = Math.floor(windowHeight * 0.8);
      }

      // Execute scroll — pass values as JSON-RPC arguments, never interpolate
      // into the expression string. Coerce to safe finite integers so an LLM
      // tool param of NaN/Infinity or a wrapped string can't sneak through.
      const safeScrollX = Number.isFinite(scrollX) ? Math.trunc(scrollX) : 0;
      const safeScrollY = Number.isFinite(actualScrollY) ? Math.trunc(actualScrollY as number) : 0;
      await this.sendCommand('Runtime.evaluate', {
        expression: `((dx, dy) => window.scrollTo({ left: window.scrollX + dx, top: window.scrollY + dy, behavior: 'smooth' }))(${safeScrollX}, ${safeScrollY})`,
        returnByValue: false,
      });

      // Wait for smooth scroll animation to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Capture after position
      const afterResult = await this.sendCommand<any>('Runtime.evaluate', {
        expression: '({ x: window.scrollX, y: window.scrollY })',
        returnByValue: true
      });
      const afterScrollPos = { x: afterResult.result.value.x, y: afterResult.result.value.y };

      // Check if we hit scroll limits
      const scrollLimitReached = (
        (actualScrollY > 0 && afterScrollPos.y >= maxScroll.y) ||
        (actualScrollY < 0 && afterScrollPos.y <= 0) ||
        (scrollX > 0 && afterScrollPos.x >= maxScroll.x) ||
        (scrollX < 0 && afterScrollPos.x <= 0)
      );

      // Invalidate snapshot - let getSerializedDom() rebuild when needed
      this.invalidateSnapshot();

      const duration = Date.now() - start;
      const actualDelta = {
        x: afterScrollPos.x - beforeScrollPos.x,
        y: afterScrollPos.y - beforeScrollPos.y
      };
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
        nodeId: originalNodeId,
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
        nodeId: originalNodeId,
        actionType: 'scroll',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Scroll by relative offset (delta)
   * @param nodeId - Target node ID in format "frameId:backendNodeId" (e.g., "0:123" for main frame html element)
   * @param scrollX - Horizontal scroll offset in pixels (positive = right, negative = left), defaults to 0
   * @param scrollY - Vertical scroll offset in pixels (positive = down, negative = up), defaults to 80% of element height
   */
  async scroll(nodeId: number | string, scrollX: number = 0, scrollY?: number): Promise<ActionResult> {
    const start = Date.now();

    // Parse frame-scoped node ID, fall back to main frame on parse error
    let parsedId;
    try {
      parsedId = parseNodeId(nodeId);
    } catch (error: any) {
      console.error(`[DomService] scroll: Failed to parse node ID "${nodeId}", falling back to main frame scroll: ${error.message}`);
      return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
    }

    try {
      // Capture scroll position BEFORE scroll
      let beforeScrollPos: { x: number; y: number } = { x: 0, y: 0 };
      let afterScrollPos: { x: number; y: number } = { x: 0, y: 0 };
      let scrollLimitReached = false;

      // actualScrollY will be computed based on scroll context if not provided or 0
      let actualScrollY = scrollY;

      // Fall back to main frame scroll if no snapshot available
      if (!this.currentSnapshot) {
        console.error(`[DomService] scroll: No snapshot available for node "${nodeId}", falling back to main frame scroll`);
        return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
      }

      // Fall back to main frame scroll if frame not found
      if (!this.currentSnapshot.frameRegistry.hasFrame(parsedId.frameId)) {
        console.error(`[DomService] scroll: Frame ${parsedId.frameId} not found in snapshot, falling back to main frame scroll`);
        return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
      }

      const backendNodeId = parsedId.backendNodeId;

      // Resolve node with frame-aware disambiguation and fall back to main frame if not found
      const node = this.currentSnapshot.resolveNodeByBackendIdAndFrame(backendNodeId, parsedId.frameId);
      if (!node) {
        console.error(`[DomService] scroll: Node ${nodeId} not found in snapshot, falling back to main frame scroll`);
        return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
      }

      // Use the resolved node's backendNodeId for CDP commands
      const resolvedBackendNodeId = node.backendNodeId;

      // Check if the target is an html element - use window.scrollTo for page-level scroll
      const tagName = (node.localName || node.nodeName || '').toLowerCase();
      const isHtmlElement = tagName === 'html';

      if (isHtmlElement) {
        // For html element, use window.scrollTo for proper page scrolling
        // This handles both main frame and iframe html elements
        if (parsedId.frameId === 0) {
          // Main frame - use window directly
          return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
        } else {
          // Iframe html element - need to get the iframe and scroll its contentWindow
          const frameMetadata = this.currentSnapshot.frameRegistry.getFrame(parsedId.frameId);
          if (!frameMetadata) {
            console.error(`[DomService] scroll: Frame ${parsedId.frameId} metadata not found, falling back to main frame scroll`);
            return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
          }

          // Resolve the iframe element
          const resolveResult = await this.sendCommand<any>('DOM.resolveNode', {
            backendNodeId: frameMetadata.backendNodeId
          });

          if (!resolveResult?.object?.objectId) {
            console.error(`[DomService] scroll: Could not resolve iframe element for frame ${parsedId.frameId}, falling back to main frame scroll`);
            return this.scrollMainFrame(scrollX, scrollY, start, nodeId);
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

          // Scroll the iframe's content window — pass scroll deltas as
          // call arguments rather than interpolating into the function body.
          {
            const safeScrollX = Number.isFinite(scrollX) ? Math.trunc(scrollX) : 0;
            const safeScrollY = Number.isFinite(actualScrollY) ? Math.trunc(actualScrollY as number) : 0;
            await this.sendCommand('Runtime.callFunctionOn', {
              objectId: resolveResult.object.objectId,
              functionDeclaration: `function(dx, dy) {
                if (this.contentWindow) {
                  this.contentWindow.scrollTo({
                    left: this.contentWindow.scrollX + dx,
                    top: this.contentWindow.scrollY + dy,
                    behavior: 'smooth'
                  });
                }
              }`,
              arguments: [{ value: safeScrollX }, { value: safeScrollY }],
              returnByValue: false,
            });
          }

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
        // Non-html element - use element's scrollTo method
        // Use CDP DOM.resolveNode to get a RemoteObject reference to the element
        const resolveResult = await this.sendCommand<any>('DOM.resolveNode', {
          backendNodeId: resolvedBackendNodeId
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

        // Execute scroll with smooth animation — pass deltas as arguments,
        // not as interpolated values in the function body.
        {
          const safeScrollX = Number.isFinite(scrollX) ? Math.trunc(scrollX) : 0;
          const safeScrollY = Number.isFinite(actualScrollY) ? Math.trunc(actualScrollY as number) : 0;
          await this.sendCommand('Runtime.callFunctionOn', {
            objectId: resolveResult.object.objectId,
            functionDeclaration: `function(dx, dy) { this.scrollTo({ left: this.scrollLeft + dx, top: this.scrollTop + dy, behavior: 'smooth' }); }`,
            arguments: [{ value: safeScrollX }, { value: safeScrollY }],
            returnByValue: false,
          });
        }

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

      // Invalidate snapshot - let getSerializedDom() rebuild when needed
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

      // Invalidate snapshot - let getSerializedDom() rebuild when needed
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

      // Resolve node with frame-aware disambiguation if snapshot is available
      let resolvedBackendNodeId = backendNodeId;
      if (this.currentSnapshot) {
        const node = this.currentSnapshot.resolveNodeByBackendIdAndFrame(backendNodeId, parsedId.frameId);
        if (node) {
          resolvedBackendNodeId = node.backendNodeId;
        }
      }

      // Use CDP's scrollIntoViewIfNeeded for basic scrolling
      await this.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: resolvedBackendNodeId });

      // If specific alignment options provided, use JavaScript scrollIntoView
      // on the resolved node object — never interpolate caller-supplied values
      // (including nodeId) into a Runtime.evaluate expression string.
      if (options?.block || options?.inline) {
        const resolveResult = await this.sendCommand<{ object: { objectId?: string } }>(
          'DOM.resolveNode',
          { backendNodeId: resolvedBackendNodeId },
        );
        if (resolveResult?.object?.objectId) {
          // Coerce alignment to known literal values to defend against
          // unexpected runtime values (the JSON schema enforces this for
          // LLM input, but the inner narrowing is cheap insurance).
          const allowedBlock = new Set(['start', 'center', 'end', 'nearest']);
          const allowedInline = new Set(['start', 'center', 'end', 'nearest']);
          const safeBlock = allowedBlock.has(options.block as string)
            ? (options.block as string)
            : 'center';
          const safeInline = allowedInline.has(options.inline as string)
            ? (options.inline as string)
            : 'nearest';
          await this.sendCommand('Runtime.callFunctionOn', {
            objectId: resolveResult.object.objectId,
            functionDeclaration: `function(opts) { this.scrollIntoView(opts); }`,
            arguments: [{ value: { behavior: 'smooth', block: safeBlock, inline: safeInline } }],
            returnByValue: false,
          });
        }
      }

      // Wait for scroll animation to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Invalidate snapshot - let getSerializedDom() rebuild when needed
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
