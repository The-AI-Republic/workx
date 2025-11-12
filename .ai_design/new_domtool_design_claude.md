# BrowserX DOM Tool Refactor Design Document

**Author:** Claude (Anthropic)
**Date:** 2025-10-24
**Status:** Design Proposal
**Version:** 1.0

---

## Executive Summary

This document proposes a comprehensive refactor of BrowserX's DOM tool to improve LLM-based web automation accuracy and reliability. The new design uses a **hybrid architecture**: internal VirtualNode tree for accurate DOM mapping, combined with **flat, token-optimized serialization** for LLM consumption.

### Key Design Principle

> **Internal Complexity, External Simplicity**: Rich tree structure internally for precise mapping, flattened tree externally for LLM efficiency (removing unnecessary containers while preserving semantic groups).

### Key Improvements

1. **Flattened LLM Serialization**: **40-60% token reduction** - removes unnecessary containers, hoists children to reduce nesting
2. **Virtual DOM Architecture**: Internal tree-based VirtualNode structure for accurate DOM mapping
3. **Smart Flattening**: Removes structural containers (divs, headers, navs) while preserving semantic groups (forms, dialogs)
4. **Enhanced Visibility Filtering**: Only present elements visible to human users
5. **Robust Shadow DOM & iframe Support**: First-level capture with proper encapsulation handling
6. **Interactive Element Detection**: Modern JavaScript event listener detection beyond semantic HTML - used internally, not exposed as field
7. **No Misleading Fields**: Removed `actionable` flag - LLM infers interactivity from role, tag, and attributes
8. **Precise Action Execution**: Bidirectional WeakRef mapping between virtual and real DOM

---

## Problem Statement

### Current Limitations

Based on analysis of the existing implementation and industry research:

1. **Incomplete Element Detection**: Current approach may miss elements that are clickable due to JavaScript event handlers (not just semantic HTML tags)
2. **Shadow DOM Boundaries**: Limited accessibility tree crossing through shadow boundaries
3. **Token Inefficiency**: Full DOM tree with structural containers (divs, sections, headers) consumes excessive tokens without adding value for LLM understanding
4. **Iframe Integration**: While supported, the integration pattern could be more explicit in the data model
5. **Mapping Complexity**: CSS selector-based lookup can be fragile with dynamic DOMs

### Research Findings

#### Industry Best Practices (2025)

**DOM Distillation & Compaction**
- Serialized DOMs can exceed LLM context windows (hundreds of thousands of tokens)
- Element extraction and filtering is critical for scalability
- Focus on "likely relevant" interactive elements

**Accessibility Tree Approach**
- Browser accessibility trees provide semantic, hierarchical UI representation
- Modern systems (MCP, Stagehand, Browser-use) leverage a11y data
- Roles, labels, and states are more stable than raw HTML structure

**Hybrid Multi-View Strategy**
- Combine DOM tree structure with accessibility metadata
- Include visual layout information (bounding boxes, viewport position)
- Screenshot integration for vision-capable models (future enhancement)

**Element Indexing**
- Stable, unique IDs for each interactive element
- Numerical labels or semantic prefixes (e.g., `bu_1`, `li_2`)
- Bidirectional mapping: ID ↔ CSS selector ↔ Real DOM node

**Shadow DOM Challenges**
- Accessibility APIs can cross shadow boundaries
- Manual traversal required for content extraction
- Encapsulation conflicts with ARIA references (W3C ongoing work)

**Modern Clickable Detection**
- Elements with `onclick`, event listeners, `cursor: pointer`
- Framework-driven click handlers (React, Vue synthetic events)
- Descendants of clickable containers

---

## Requirements

### Functional Requirements

#### FR1: VirtualNode Data Structure
- **FR1.1**: Create tree-based VirtualNode interface with node_id, tag, role, aria-label, text, value, visible, children
- **FR1.2**: Support iframe property for first-level iframe content
- **FR1.3**: Support shadowDom property for first-level shadow DOM content

#### FR2: DomSnapshot Class
- **FR2.1**: Maintain complete virtual DOM tree representation
- **FR2.2**: Store timestamp of snapshot creation
- **FR2.3**: Provide bidirectional mapping: node_id ↔ real DOM element
- **FR2.4**: Support efficient lookup operations (O(1) for ID-based access)

#### FR3: DomTool Class
- **FR3.1**: Implement getSnapshot() to capture current page state
- **FR3.2**: Implement get_serialized_dom() returning LLM-optimized JSON
- **FR3.3**: Implement click(node_id) with modern clickable element support
- **FR3.4**: Implement type(node_id, text) with framework compatibility
- **FR3.5**: Implement keypress(key, modifiers) for keyboard simulation

#### FR4: Visibility Filtering
- **FR4.1**: Exclude elements with `display: none`, `visibility: hidden`, `opacity: 0`
- **FR4.2**: Exclude elements with zero-size bounding boxes
- **FR4.3**: Include viewport intersection metadata
- **FR4.4**: Respect `aria-hidden="true"` and `inert` attributes

#### FR5: Clickable Element Detection
- **FR5.1**: Detect semantic clickable elements (a, button, input[type=button/submit])
- **FR5.2**: Detect elements with explicit `onclick` attributes
- **FR5.3**: Detect elements with event listeners (via heuristics: cursor, tabindex, role)
- **FR5.4**: Detect framework-bound elements (data-* attributes, class patterns)

#### FR6: Shadow DOM & iframe Handling
- **FR6.1**: Traverse and capture first-level shadow DOM content
- **FR6.2**: Traverse and capture first-level iframe content (same-origin only)
- **FR6.3**: Maintain separate subtrees for iframe and shadowDom properties
- **FR6.4**: Handle cross-origin iframe detection with graceful fallback

#### FR7: LLM Serialization
- **FR7.1**: Output FLATTENED tree JSON format optimized for token efficiency
- **FR7.2**: Include page context (URL, title)
- **FR7.3**: Remove unnecessary structural containers (divs, headers, navs, sections)
- **FR7.4**: Hoist children to reduce nesting depth when containers add no value
- **FR7.5**: Preserve semantic groups (forms, dialogs) for interaction context
- **FR7.6**: Separate iframe and shadowDom content at root level
- **FR7.7**: Omit default values to minimize token usage

#### FR8: Content Script Integration
- **FR8.1**: Maintain message-based communication with background script
- **FR8.2**: Instantiate and manage DomTool singleton
- **FR8.3**: Route action commands to DomTool methods
- **FR8.4**: Return execution results with success/error handling

### Non-Functional Requirements

#### NFR1: Performance
- **NFR1.1**: Snapshot creation < 5 seconds (p90) for typical pages
- **NFR1.2**: Timeout protection at 30 seconds (hard limit)
- **NFR1.3**: Memory-efficient representation (< 50MB for large pages)
- **NFR1.4**: Incremental/streaming serialization for very large DOMs

#### NFR2: Robustness
- **NFR2.1**: Graceful degradation for inaccessible iframes/shadow DOMs
- **NFR2.2**: Error recovery for malformed DOM structures
- **NFR2.3**: Cross-browser compatibility (Chrome, Edge, Brave)

#### NFR3: Privacy
- **NFR3.1**: Never capture password field values
- **NFR3.2**: Optional value capture (default: false)
- **NFR3.3**: Sanitize sensitive data (credit cards, SSNs) if value capture enabled

#### NFR4: Maintainability
- **NFR4.1**: Modular architecture with clear separation of concerns
- **NFR4.2**: Comprehensive inline documentation
- **NFR4.3**: Unit test coverage > 80%
- **NFR4.4**: Integration tests for key user flows

---

## Proposed Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Background Script                      │
│  ┌─────────────┐          ┌──────────────────────────────┐  │
│  │  DOMTool    │          │    PageActionTool            │  │
│  │  (v3.0)     │          │                              │  │
│  └──────┬──────┘          └────────────┬─────────────────┘  │
│         │                              │                     │
│         │ chrome.tabs.sendMessage      │                     │
└─────────┼──────────────────────────────┼─────────────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Content Script Layer                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              MessageRouter (Listener)                  │  │
│  └──────┬─────────────────────────────────┬───────────────┘  │
│         │                                 │                   │
│         ▼                                 ▼                   │
│  ┌────────────────────┐         ┌─────────────────────────┐  │
│  │     DomTool        │         │   Action Executors      │  │
│  │  ┌──────────────┐  │         │  - ClickExecutor        │  │
│  │  │ DomSnapshot  │  │         │  - InputExecutor        │  │
│  │  │ ┌──────────┐ │  │         │  - KeyPressExecutor     │  │
│  │  │ │VirtualDOM│ │  │         │                         │  │
│  │  │ │  Tree    │ │  │         │                         │  │
│  │  │ └──────────┘ │  │         │                         │  │
│  │  │ Map<id→node> │  │         │                         │  │
│  │  └──────────────┘  │         │                         │  │
│  │                    │         │                         │  │
│  │  Methods:          │         │                         │  │
│  │  - getSnapshot()   │         │                         │  │
│  │  - serialize()     │         │                         │  │
│  │  - click()         │         │                         │  │
│  │  - type()          │         │                         │  │
│  │  - keypress()      │         │                         │  │
│  └────────────────────┘         └─────────────────────────┘  │
│         │                                                     │
│         ▼                                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Real DOM (Browser Page)                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │  │
│  │  │  iframe  │  │shadowDOM │  │  Interactive Elements│  │  │
│  │  └──────────┘  └──────────┘  └──────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

#### DomTool (Content Script)
- **Primary Interface**: Entry point for all DOM operations
- **Snapshot Management**: Creates and caches DomSnapshot instances
- **Action Coordination**: Delegates to action executors with real DOM mapping
- **Lifecycle**: Singleton per page, recreates snapshot on major DOM changes

#### DomSnapshot (Content Script)
- **State Container**: Immutable snapshot of page state at a point in time
- **Virtual DOM Tree**: Root VirtualNode with complete hierarchy
- **Bidirectional Mapping**: Fast lookups between node_id and real DOM
- **Serialization**: Converts VirtualDOM to LLM-friendly JSON

#### VirtualNode (Data Structure)
- **Tree Node**: Represents single DOM element with metadata
- **Semantic Data**: Role, label, text, actionability
- **Traversal Support**: Parent/child relationships, depth tracking
- **Iframe/ShadowDOM**: Special properties for encapsulated content

#### Action Executors (Content Script)
- **ClickExecutor**: Handles click actions with change detection
- **InputExecutor**: Types into inputs with framework compatibility
- **KeyPressExecutor**: Simulates keyboard events at document/element level
- **ScrollExecutor**: Already exists, integrate with new architecture

---

## Data Structures

### VirtualNode Interface

```typescript
/**
 * Represents a single node in the virtual DOM tree.
 * Optimized for LLM consumption with semantic metadata.
 */
interface VirtualNode {
  /**
   * Unique identifier for this node (e.g., "node_0", "node_42")
   * Format: "node_" + sequential_counter
   * Used by LLM to reference elements in action commands
   */
  node_id: string;

  /**
   * HTML tag name (lowercase)
   * Examples: "div", "button", "input", "a"
   */
  tag: string;

  /**
   * ARIA role (explicit or implicit)
   * Examples: "button", "link", "textbox", "navigation"
   */
  role?: string;

  /**
   * ARIA label or computed accessible name
   * Follows WCAG accessible name computation algorithm
   * Max length: 250 characters (truncated with ellipsis)
   */
  "aria-label"?: string;

  /**
   * Visible text content (trimmed, normalized whitespace)
   * Excludes hidden/script/style elements
   * Max length: 500 characters (truncated)
   */
  text?: string;

  /**
   * Current value for form inputs
   * Only included if:
   * - includeValues option is true
   * - Element is not a password field
   * Privacy: passwords always excluded
   */
  value?: string;

  /**
   * Visibility status based on computed styles and bounding box
   * False if: display:none, visibility:hidden, opacity:0, or zero-size
   */
  visible: boolean;

  /**
   * Child nodes in DOM tree order
   * Only includes visible children (unless marked as structural containers)
   * Max depth: configurable, default unlimited for virtual tree
   */
  children?: VirtualNode[];


  /**
   * First-level iframe content as separate VirtualNode tree
   * Only same-origin iframes are traversed
   * Cross-origin iframes: empty tree with note in aria-label
   */
  iframe?: VirtualNode;

  /**
   * First-level shadow DOM content as separate VirtualNode tree
   * Includes open shadow roots only (closed roots inaccessible)
   */
  shadowDom?: VirtualNode;

  /**
   * Additional metadata for enhanced LLM context
   */
  metadata?: {
    /** Element is in current viewport */
    inViewport?: boolean;

    /** Bounding box coordinates (viewport-relative) */
    boundingBox?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };

    /** Containing landmark region (main, nav, header, footer, aside) */
    region?: string;

    /** Element states (checked, disabled, expanded, selected, etc.) */
    states?: Record<string, boolean | string>;

    /** Link href (for anchors) */
    href?: string;

    /** Input type (for input elements) */
    inputType?: string;

    /** Placeholder text (for inputs) */
    placeholder?: string;

    /**
     * Matching metadata (for smart ID preservation on rebuild)
     */

    /** HTML id attribute (for stable matching) */
    htmlId?: string;

    /** Test ID attributes (data-testid, data-test, data-cy) */
    testId?: string;

    /** Tree path from root (e.g., "body/form/input[0]") */
    treePath?: string;
  };
}
```

### DomSnapshot Class

```typescript
/**
 * Immutable snapshot of page DOM at a specific point in time.
 * Provides virtual DOM tree and bidirectional mapping to real DOM.
 */
class DomSnapshot {
  /**
   * Root of the virtual DOM tree
   * Represents the <body> element and its descendants
   */
  readonly virtualDom: VirtualNode;

  /**
   * ISO 8601 timestamp of snapshot creation
   * Example: "2025-10-24T12:34:56.789Z"
   */
  readonly timestamp: string;

  /**
   * Bidirectional mapping between virtual nodes and real DOM elements
   *
   * Forward: node_id → WeakRef<Element>
   * - Allows garbage collection of detached elements
   * - Returns null if element was removed from DOM
   *
   * Reverse: Element → node_id
   * - Uses WeakMap for automatic cleanup
   * - O(1) lookup in both directions
   */
  private readonly forwardMap: Map<string, WeakRef<Element>>;
  private readonly reverseMap: WeakMap<Element, string>;

  /**
   * Page metadata captured at snapshot time
   */
  readonly context: {
    url: string;
    title: string;
    viewport: {
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
    };
  };

  /**
   * Statistics about the snapshot
   */
  readonly stats: {
    totalNodes: number;
    visibleNodes: number;
    interactiveNodes: number;
    iframeCount: number;
    shadowDomCount: number;
    captureTimeMs: number;
  };

  /**
   * Get real DOM element by node_id
   * @returns Element or null if not found/detached
   */
  getRealElement(nodeId: string): Element | null;

  /**
   * Get node_id for a real DOM element
   * @returns node_id or null if not in snapshot
   */
  getNodeId(element: Element): string | null;

  /**
   * Check if snapshot is still valid (elements not stale)
   * Performs sampling check on random subset of mapped elements
   */
  isValid(): boolean;

  /**
   * Serialize virtual DOM to LLM-friendly JSON format
   * See SerializedDom interface below
   */
  serialize(options?: SerializationOptions): SerializedDom;
}
```

### SerializedDom (LLM Output Format)

```typescript
/**
 * FLATTENED tree representation for LLM consumption.
 *
 * Design Principle: Simplify tree structure by removing unnecessary containers.
 * - Remove structural divs, sections, headers, navs (unless they contain important content)
 * - Hoist children to reduce nesting levels
 * - Keep semantic groups (forms, dialogs) because they provide interaction context
 * - Only include visible or meaningful content elements
 *
 * This format is 40-60% smaller than full DOM tree serialization.
 */
interface SerializedDom {
  page: {
    /**
     * Page metadata
     */
    context: {
      url: string;
      title: string;
    };

    /**
     * FLATTENED page body content
     * Most elements are direct children (unnecessary containers removed)
     * Semantic groups like forms preserved for context
     */
    body: SerializedNode;

    /**
     * First-level iframe contents (if any)
     * Each iframe has its own flattened body
     */
    iframes?: {
      url: string;
      title: string;
      body: SerializedNode;
    }[];

    /**
     * First-level shadow DOM contents (if any)
     * Each shadow root has its own flattened structure
     */
    shadowDoms?: {
      hostId: string; // node_id of shadow host element
      body: SerializedNode;
    }[];
  };
}

/**
 * Simplified node for LLM serialization
 * Flattened to reduce nesting depth
 */
interface SerializedNode {
  /** Unique identifier for action commands */
  id: string;

  /** HTML tag name */
  tag: string;

  /** ARIA role (explicit or implicit) */
  role?: string;

  /** ARIA label or computed accessible name */
  "aria-label"?: string;

  /** Visible text content */
  text?: string;

  /** Form input value (only if includeValues=true and not password) */
  value?: string;

  /** Children nodes (only for semantic groups like forms, or when nesting provides value) */
  children?: SerializedNode[];

  /**
   * Additional metadata (only non-default values included)
   */
  href?: string; // For links
  placeholder?: string; // For inputs
  inputType?: string; // For input elements
  disabled?: boolean; // For form elements
  checked?: boolean | "mixed"; // For checkboxes/radios
  required?: boolean; // For form inputs
  expanded?: boolean; // For collapsible elements

  /** Viewport visibility (only if false, omit if true) */
  offscreen?: boolean;
}
```

### Serialization Options

```typescript
interface SerializationOptions {
  /**
   * Include form field values (default: false for privacy)
   */
  includeValues?: boolean;

  /**
   * Include elements outside viewport (default: true)
   */
  includeOffscreen?: boolean;

  /**
   * Include bounding box metadata (default: false, reduces tokens)
   */
  includeBoundingBoxes?: boolean;

  /**
   * Maximum depth to serialize (default: unlimited)
   * Useful for very deep DOM trees
   */
  maxDepth?: number;

  /**
   * Maximum interactive elements to include (default: 1000)
   * Caps token usage for LLM
   */
  maxInteractive?: number;

  /**
   * Filter to only include elements matching CSS selector
   */
  filterSelector?: string;
}
```

---

## Class Design

### DomTool Class (Primary Interface)

```typescript
/**
 * Main entry point for DOM interaction operations.
 * Manages snapshots and executes actions on the page.
 *
 * Location: src/content/DomTool.ts
 */
class DomTool {
  /**
   * Current snapshot (cached until invalidated)
   */
  private domSnapshot: DomSnapshot | null = null;

  /**
   * Snapshot invalidation strategy
   */
  private mutationObserver: MutationObserver;
  private snapshotVersion: number = 0;

  /**
   * Configuration
   */
  private config: DomToolConfig;

  /**
   * Snapshot build state tracking
   */
  private buildInProgress: Promise<DomSnapshot> | null = null;
  private nodeIdCounter: number = 0;

  constructor(config?: Partial<DomToolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.setupMutationObserver();

    // Constructor must wait for initial snapshot to be built
    // Should be called after DOMContentLoaded or window.load
  }

  /**
   * Initialize the DomTool with initial snapshot
   * Must be called after page is fully loaded
   *
   * @returns Promise<void>
   */
  async initialize(): Promise<void> {
    await this.buildSnapshot();
  }

  /**
   * Get the current snapshot, or trigger rebuild and wait if needed
   *
   * @param options - Options for snapshot retrieval
   * @returns Promise<DomSnapshot>
   *
   * Behavior:
   * - If snapshot exists and is valid: return immediately
   * - If snapshot is being built: wait for build to complete
   * - If snapshot is stale or doesn't exist: trigger build and wait
   */
  async getSnapshot(options?: {
    waitForBuild?: boolean; // Default: true - wait for ongoing build
    maxWaitMs?: number;     // Default: 5000 - max time to wait for build
  }): Promise<DomSnapshot> {
    // If build is in progress and we should wait
    if (this.buildInProgress && options?.waitForBuild !== false) {
      const maxWait = options?.maxWaitMs ?? 5000;
      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Snapshot build timeout')), maxWait)
      );

      try {
        return await Promise.race([this.buildInProgress, timeoutPromise]);
      } catch (error) {
        // Timeout or error - return stale snapshot if available
        if (this.domSnapshot) return this.domSnapshot;
        throw error;
      }
    }

    // If no snapshot exists, trigger build
    if (!this.domSnapshot) {
      return await this.buildSnapshot();
    }

    // Return existing snapshot
    return this.domSnapshot;
  }

  /**
   * Build or rebuild the DOM snapshot
   *
   * @param trigger - What triggered this rebuild (for logging/debugging)
   * @returns Promise<DomSnapshot>
   *
   * Smart ID Preservation:
   * - Attempts to match elements from old snapshot to new DOM
   * - Preserves node IDs for unchanged elements (90% same = keep 90% IDs)
   * - Only assigns new IDs to new elements or significantly changed elements
   *
   * Matching Strategy:
   * 1. Match by stable attributes (id, data-testid, aria-label)
   * 2. Match by position in tree (same parent, same index)
   * 3. Match by tag + text content similarity
   * 4. Assign new ID if no match found
   *
   * Steps:
   * 1. Check if build already in progress - return existing promise
   * 2. Create new build promise
   * 3. Traverse DOM tree starting from document.body
   * 4. For each element:
   *    a. Try to match with element from old snapshot
   *    b. If matched: reuse node_id, update metadata
   *    c. If new: assign new node_id from counter
   *    d. Check visibility (styles, bounding box)
   *    e. Determine role (ARIA or inferred)
   *    f. Compute accessible name
   *    g. Create VirtualNode
   * 5. Handle iframes (same-origin, depth=1)
   * 6. Handle shadow DOMs (open only, depth=1)
   * 7. Build bidirectional mapping
   * 8. Create immutable DomSnapshot
   * 9. Update this.domSnapshot
   * 10. Clear buildInProgress
   * 11. Return new snapshot
   */
  async buildSnapshot(trigger?: 'action' | 'navigation' | 'manual' | 'mutation'): Promise<DomSnapshot> {
    // If build already in progress, return that promise
    if (this.buildInProgress) {
      return this.buildInProgress;
    }

    // Create new build promise
    this.buildInProgress = this.executeSnapshotBuild(trigger);

    try {
      const snapshot = await this.buildInProgress;
      this.domSnapshot = snapshot;
      return snapshot;
    } finally {
      this.buildInProgress = null;
    }
  }

  /**
   * Get serialized DOM for LLM consumption
   *
   * @param options - Serialization options
   * @returns SerializedDom JSON object
   *
   * Steps:
   * 1. Get or create current snapshot
   * 2. Call snapshot.serialize(options)
   * 3. Return JSON structure
   */
  async get_serialized_dom(
    options?: SerializationOptions
  ): Promise<SerializedDom>;

  /**
   * Click on an element identified by node_id
   *
   * @param nodeId - Virtual node identifier from LLM
   * @param options - Click options (button, modifiers, etc.)
   * @returns ActionResult with success/failure and detected changes
   *
   * Steps:
   * 1. Get real DOM element from snapshot mapping
   * 2. Validate element is still in DOM
   * 3. Scroll element into view if needed
   * 4. Capture pre-click state
   * 5. Dispatch click event (or use .click() method)
   * 6. Wait for potential navigation/changes
   * 7. Detect changes (navigation, DOM mutations, scroll)
   * 8. Trigger async snapshot rebuild (don't wait)
   * 9. Return ActionResult immediately
   */
  async click(
    nodeId: string,
    options?: ClickOptions
  ): Promise<ActionResult> {
    // ... perform click action ...

    // Trigger async rebuild (don't await)
    this.buildSnapshot('action').catch(err => {
      console.error('[DomTool] Async snapshot rebuild failed after click:', err);
    });

    return result;
  }

  /**
   * Type text into an input element
   *
   * @param nodeId - Virtual node identifier from LLM
   * @param text - Text to type
   * @param options - Type options (speed, clearFirst, pressEnter)
   * @returns ActionResult
   *
   * Steps:
   * 1. Get real DOM element from snapshot mapping
   * 2. Validate element is input-capable (input, textarea, contenteditable)
   * 3. Focus element
   * 4. Optionally clear existing value
   * 5. Simulate typing with input/keydown/keyup events
   * 6. Handle framework compatibility (React _valueTracker, Vue)
   * 7. Optionally press Enter key
   * 8. Detect value changes
   * 9. Trigger async snapshot rebuild (don't wait)
   * 10. Return ActionResult immediately
   */
  async type(
    nodeId: string,
    text: string,
    options?: TypeOptions
  ): Promise<ActionResult> {
    // ... perform type action ...

    // Trigger async rebuild (don't await)
    this.buildSnapshot('action').catch(err => {
      console.error('[DomTool] Async snapshot rebuild failed after type:', err);
    });

    return result;
  }

  /**
   * Simulate keyboard key press
   *
   * @param key - Key to press (e.g., "Enter", "Escape", "ArrowDown")
   * @param options - Key options (modifiers, target element)
   * @returns ActionResult
   *
   * Steps:
   * 1. Determine target (element by nodeId, or document)
   * 2. Create KeyboardEvent with proper key, code, modifiers
   * 3. Dispatch keydown event
   * 4. Dispatch keypress event (if applicable)
   * 5. Dispatch keyup event
   * 6. Detect changes triggered by keypress
   * 7. Trigger async snapshot rebuild (don't wait)
   * 8. Return ActionResult immediately
   */
  async keypress(
    key: string,
    options?: KeyPressOptions
  ): Promise<ActionResult> {
    // ... perform keypress action ...

    // Trigger async rebuild (don't await)
    this.buildSnapshot('action').catch(err => {
      console.error('[DomTool] Async snapshot rebuild failed after keypress:', err);
    });

    return result;
  }

  /**
   * Invalidate current snapshot (force refresh on next access)
   * Deprecated: Use buildSnapshot() instead
   */
  invalidateSnapshot(): void {
    this.domSnapshot = null;
  }

  /**
   * Clean up resources (observers, references)
   */
  destroy(): void;

  /**
   * Private: Execute the actual snapshot build
   * Separated from buildSnapshot() for better control flow
   */
  private async executeSnapshotBuild(
    trigger?: 'action' | 'navigation' | 'manual' | 'mutation'
  ): Promise<DomSnapshot>;

  /**
   * Private: Setup mutation observer to detect DOM changes
   * Triggers rebuild on significant mutations
   */
  private setupMutationObserver(): void;

  /**
   * Private: Build VirtualNode tree from real DOM
   * With smart ID preservation from old snapshot
   */
  private buildVirtualTree(
    rootElement: Element,
    parentPath: string,
    depth: number = 0
  ): Promise<VirtualNode>;

  /**
   * Private: Try to match element from old snapshot
   * Returns old node_id if matched, null if new element
   */
  private matchElementToOldSnapshot(
    element: Element,
    parentPath: string,
    indexInParent: number
  ): string | null;

  /**
   * Private: Generate fingerprint for element matching
   * Used to determine if element is "same" as before
   */
  private getElementFingerprint(element: Element): string;

  /**
   * Private: Detect if element has interactive role or attributes
   */
  private hasInteractiveRole(element: Element): boolean;

  /**
   * Private: Generate unique node_id
   * Increments counter for new IDs
   */
  private generateNodeId(): string {
    return `node_${this.nodeIdCounter++}`;
  }
}
```

### Configuration Types

```typescript
interface DomToolConfig {
  /**
   * Maximum time to wait for snapshot creation (ms)
   */
  snapshotTimeout: number; // default: 30000

  /**
   * Maximum interactive elements to capture
   */
  maxInteractiveElements: number; // default: 400

  /**
   * Maximum tree depth to traverse
   */
  maxTreeDepth: number; // default: 50

  /**
   * Enable automatic snapshot invalidation on mutations
   */
  autoInvalidate: boolean; // default: true

  /**
   * Mutation observer throttle (ms)
   */
  mutationThrottle: number; // default: 500

  /**
   * Include iframe content
   */
  captureIframes: boolean; // default: true

  /**
   * Include shadow DOM content
   */
  captureShadowDom: boolean; // default: true

  /**
   * Iframe traversal depth
   */
  iframeDepth: number; // default: 1

  /**
   * Shadow DOM traversal depth
   */
  shadowDomDepth: number; // default: 1
}

const DEFAULT_CONFIG: DomToolConfig = {
  snapshotTimeout: 30000,
  maxInteractiveElements: 400,
  maxTreeDepth: 50,
  autoInvalidate: true,
  mutationThrottle: 500,
  captureIframes: true,
  captureShadowDom: true,
  iframeDepth: 1,
  shadowDomDepth: 1,
};
```

### Action Options & Results

```typescript
interface ClickOptions {
  /** Click button: "left" | "right" | "middle" */
  button?: "left" | "right" | "middle"; // default: "left"

  /** Click type: "single" | "double" */
  clickType?: "single" | "double"; // default: "single"

  /** Modifier keys */
  modifiers?: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  };

  /** Wait for navigation after click (ms) */
  waitForNavigation?: boolean; // default: false

  /** Scroll into view before clicking */
  scrollIntoView?: boolean; // default: true
}

interface TypeOptions {
  /** Clear existing value before typing */
  clearFirst?: boolean; // default: false

  /** Typing speed (ms per character, 0 for instant) */
  speed?: number; // default: 0

  /** Press Enter after typing */
  pressEnter?: boolean; // default: false

  /** Blur element after typing */
  blur?: boolean; // default: false
}

interface KeyPressOptions {
  /** Target element by node_id (if not provided, target document) */
  targetNodeId?: string;

  /** Modifier keys */
  modifiers?: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  };

  /** Repeat count */
  repeat?: number; // default: 1
}

interface ActionResult {
  /** Whether action succeeded */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Action execution time (ms) */
  duration: number;

  /** Detected changes */
  changes: {
    /** Page navigation occurred */
    navigationOccurred: boolean;

    /** New URL if navigation occurred */
    newUrl?: string;

    /** Number of DOM mutations detected */
    domMutations: number;

    /** Scroll position changed */
    scrollChanged: boolean;

    /** Form value changed (for type/input actions) */
    valueChanged: boolean;

    /** New value if changed */
    newValue?: string;
  };

  /** Node ID that was acted upon */
  nodeId: string;

  /** Action type */
  actionType: "click" | "type" | "keypress";

  /** Timestamp */
  timestamp: string;
}
```

---

## Implementation Details

### Smart ID Preservation on Snapshot Rebuild

When rebuilding the snapshot, the tool attempts to preserve node IDs for unchanged elements. This ensures that LLM can continue referencing the same elements after page changes (e.g., 90% of elements unchanged = 90% of IDs preserved).

#### Matching Strategy

Elements are matched from old snapshot to new DOM using a multi-level strategy:

**Level 1: Stable Attribute Matching (Highest Priority)**
- Match by HTML `id` attribute (if present and unique)
- Match by `data-testid`, `data-test`, `data-cy` attributes
- Match by unique `aria-label` or `aria-labelledby`

**Level 2: Structural Position Matching**
- Match by tree path (same parent, same index among siblings)
- Match by XPath-like path (tag sequence from root)

**Level 3: Content Similarity Matching**
- Match by tag + text content (with fuzzy matching)
- Match by tag + role + aria-label combination

**Level 4: New Element**
- If no match found, assign new ID from counter

#### Implementation

```typescript
/**
 * Try to match element from old snapshot to preserve node_id
 *
 * @param element - Real DOM element from new tree
 * @param parentPath - Path to parent in tree (e.g., "body/form")
 * @param indexInParent - Index among siblings
 * @returns Preserved node_id or null if new element
 */
private matchElementToOldSnapshot(
  element: Element,
  parentPath: string,
  indexInParent: number
): string | null {
  if (!this.domSnapshot) return null;

  const fingerprint = this.getElementFingerprint(element);
  const path = `${parentPath}/${element.tagName.toLowerCase()}[${indexInParent}]`;

  // Strategy 1: Match by stable attributes
  const htmlId = element.id;
  if (htmlId) {
    // Search old snapshot for element with same id
    const oldNode = this.findNodeByHtmlId(this.domSnapshot.virtualDom, htmlId);
    if (oldNode && this.isSimilarElement(oldNode, element, fingerprint)) {
      return oldNode.node_id;
    }
  }

  const testId = element.getAttribute('data-testid') ||
                 element.getAttribute('data-test') ||
                 element.getAttribute('data-cy');
  if (testId) {
    const oldNode = this.findNodeByTestId(this.domSnapshot.virtualDom, testId);
    if (oldNode && this.isSimilarElement(oldNode, element, fingerprint)) {
      return oldNode.node_id;
    }
  }

  // Strategy 2: Match by tree path
  const oldNodeByPath = this.findNodeByPath(this.domSnapshot.virtualDom, path);
  if (oldNodeByPath && this.isSimilarElement(oldNodeByPath, element, fingerprint)) {
    return oldNodeByPath.node_id;
  }

  // Strategy 3: Match by content similarity
  const ariaLabel = element.getAttribute('aria-label');
  const text = element.textContent?.trim().slice(0, 100);
  if (ariaLabel || text) {
    const oldNode = this.findNodeBySimilarity(
      this.domSnapshot.virtualDom,
      element.tagName.toLowerCase(),
      ariaLabel,
      text
    );
    if (oldNode && this.isSimilarElement(oldNode, element, fingerprint)) {
      return oldNode.node_id;
    }
  }

  // Strategy 4: No match - new element
  return null;
}

/**
 * Generate fingerprint for element to detect if it's "same" as before
 * Used to validate matches from different strategies
 */
private getElementFingerprint(element: Element): string {
  const parts: string[] = [];

  parts.push(element.tagName.toLowerCase());

  const role = element.getAttribute('role');
  if (role) parts.push(`role:${role}`);

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) parts.push(`label:${ariaLabel.slice(0, 50)}`);

  const text = element.textContent?.trim().slice(0, 50);
  if (text) parts.push(`text:${text}`);

  const href = element.getAttribute('href');
  if (href) parts.push(`href:${href}`);

  const id = element.id;
  if (id) parts.push(`id:${id}`);

  return parts.join('|');
}

/**
 * Check if old VirtualNode and new Element are similar enough to match
 * Allows for minor changes (text updates, attribute changes)
 */
private isSimilarElement(
  oldNode: VirtualNode,
  newElement: Element,
  newFingerprint: string
): boolean {
  // Must have same tag
  if (oldNode.tag !== newElement.tagName.toLowerCase()) {
    return false;
  }

  // Calculate similarity score
  let score = 0;
  let maxScore = 0;

  // Role similarity (high weight)
  maxScore += 3;
  const newRole = newElement.getAttribute('role');
  if (oldNode.role === newRole) score += 3;

  // Aria-label similarity (high weight)
  maxScore += 2;
  const newAriaLabel = newElement.getAttribute('aria-label');
  if (oldNode['aria-label'] === newAriaLabel) score += 2;

  // Text content similarity (medium weight)
  maxScore += 2;
  const newText = newElement.textContent?.trim().slice(0, 100);
  if (oldNode.text && newText) {
    const similarity = this.textSimilarity(oldNode.text, newText);
    score += similarity * 2;
  }

  // Href similarity (medium weight)
  maxScore += 1;
  const newHref = newElement.getAttribute('href');
  if (oldNode.metadata?.href === newHref) score += 1;

  // Consider match if similarity >= 60%
  return (score / maxScore) >= 0.6;
}

/**
 * Calculate text similarity (0 to 1)
 * Simple approach: Levenshtein distance or exact match
 */
private textSimilarity(text1: string, text2: string): number {
  if (text1 === text2) return 1.0;

  // Allow for minor changes (first 50 chars)
  const t1 = text1.slice(0, 50);
  const t2 = text2.slice(0, 50);

  if (t1 === t2) return 0.9;

  // Simple length-based similarity for now
  const maxLen = Math.max(t1.length, t2.length);
  const minLen = Math.min(t1.length, t2.length);

  if (maxLen === 0) return 1.0;

  return minLen / maxLen;
}

// Helper methods for searching old snapshot tree
private findNodeByHtmlId(root: VirtualNode, htmlId: string): VirtualNode | null {
  if (root.metadata?.htmlId === htmlId) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = this.findNodeByHtmlId(child, htmlId);
      if (found) return found;
    }
  }
  return null;
}

private findNodeByTestId(root: VirtualNode, testId: string): VirtualNode | null {
  if (root.metadata?.testId === testId) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = this.findNodeByTestId(child, testId);
      if (found) return found;
    }
  }
  return null;
}

private findNodeByPath(root: VirtualNode, path: string): VirtualNode | null {
  if (root.metadata?.treePath === path) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = this.findNodeByPath(child, path);
      if (found) return found;
    }
  }
  return null;
}
```

#### Rebuild Triggers

The snapshot is rebuilt asynchronously in these scenarios:

**1. After Action Execution** (async, non-blocking)
```typescript
async click(nodeId: string, options?: ClickOptions): Promise<ActionResult> {
  // Execute click
  const result = await executeClick(nodeId, options);

  // Trigger rebuild without waiting
  this.buildSnapshot('action').catch(console.error);

  return result; // Return immediately
}
```

**2. Page Navigation** (sync, blocking)
```typescript
window.addEventListener('popstate', async () => {
  await this.buildSnapshot('navigation');
});

// URL change detection
const observer = new MutationObserver(() => {
  if (this.lastUrl !== window.location.href) {
    this.lastUrl = window.location.href;
    this.buildSnapshot('navigation').catch(console.error);
  }
});
```

**3. Manual Trigger** (sync or async, caller decides)
```typescript
// Agent explicitly requests rebuild
await domTool.buildSnapshot('manual');
```

**4. Significant DOM Mutations** (debounced, async)
```typescript
private setupMutationObserver(): void {
  let mutationCount = 0;
  let debounceTimer: number | null = null;

  this.mutationObserver = new MutationObserver((mutations) => {
    mutationCount += mutations.length;

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = window.setTimeout(() => {
      // Rebuild if significant mutations (>50 changes)
      if (mutationCount > 50) {
        this.buildSnapshot('mutation').catch(console.error);
      }
      mutationCount = 0;
    }, this.config.mutationThrottle);
  });

  this.mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
  });
}
```

### Interactive Element Detection

Modern web applications use JavaScript event handlers on non-semantic elements. The tool uses heuristics to detect these beyond traditional `<a>` and `<button>` tags. This information is used internally to assign appropriate roles and determine what to include in the serialization.

**Note:** We don't store an `actionable` boolean field in VirtualNode, as this can be misleading. Instead, LLMs infer interactivity from the `role`, `tag`, and other attributes (like `href`, `onclick`, `cursor: pointer`).

#### Detection Heuristics

```typescript
/**
 * Detect if an element has interactive characteristics
 * Used internally to help assign roles and prioritize elements for serialization
 *
 * NOT stored as a field - LLM infers interactivity from role/tag/attributes
 *
 * Priority:
 * 1. Semantic HTML (button, a[href], input, select, textarea)
 * 2. Explicit onclick attribute
 * 3. ARIA role indicating interactivity
 * 4. tabindex >= 0 (keyboard accessible)
 * 5. CSS cursor: pointer (heuristic)
 * 6. Framework-specific attributes (React, Vue, Angular)
 * 7. Class name patterns (btn, button, clickable)
 *
 * Note: Direct event listener detection via getEventListeners()
 * is only available in DevTools, not content scripts.
 * We use heuristics instead.
 */
private hasInteractiveRole(element: Element): boolean {
  // 1. Semantic interactive elements
  const tag = element.tagName.toLowerCase();
  const interactiveTags = ['button', 'a', 'input', 'select', 'textarea', 'summary'];
  if (interactiveTags.includes(tag)) {
    // Links must have href to be interactive
    if (tag === 'a' && !element.hasAttribute('href')) {
      return false;
    }
    return true;
  }

  // 2. Explicit onclick attribute
  if (element.hasAttribute('onclick')) {
    return true;
  }

  // 3. Interactive ARIA roles
  const role = element.getAttribute('role');
  const interactiveRoles = [
    'button', 'link', 'checkbox', 'radio', 'switch',
    'tab', 'menuitem', 'option', 'slider', 'textbox'
  ];
  if (role && interactiveRoles.includes(role)) {
    return true;
  }

  // 4. Keyboard accessible (positive tabindex)
  const tabindex = element.getAttribute('tabindex');
  if (tabindex !== null && parseInt(tabindex) >= 0) {
    return true;
  }

  // 5. CSS cursor indicates clickability
  const style = window.getComputedStyle(element);
  if (style.cursor === 'pointer') {
    return true;
  }

  // 6. Framework-specific attributes (React, Vue, Angular)
  const frameworkAttrs = [
    'ng-click',           // Angular
    'v-on:click',         // Vue
    '@click',             // Vue shorthand
    'data-action',        // Rails UJS
    'data-turbo-method',  // Turbo
  ];
  for (const attr of frameworkAttrs) {
    if (element.hasAttribute(attr)) {
      return true;
    }
  }

  // 7. Check for class names suggesting interactivity
  const className = element.className;
  if (typeof className === 'string') {
    const clickPatterns = /\b(btn|button|link|clickable|interactive)\b/i;
    if (clickPatterns.test(className)) {
      return true;
    }
  }

  return false;
}
```

### Shadow DOM Traversal

Shadow DOM encapsulates styles and markup. First-level shadow roots must be traversed to capture custom elements.

```typescript
/**
 * Capture shadow DOM content for an element
 * Only open shadow roots are accessible
 *
 * @param element - Element with shadow root
 * @param depth - Current shadow DOM depth (max: 1)
 * @returns VirtualNode representing shadow tree root
 */
private async captureShadowDom(
  element: Element,
  depth: number
): Promise<VirtualNode | undefined> {
  // Check if element has shadow root
  const shadowRoot = element.shadowRoot;
  if (!shadowRoot) {
    return undefined;
  }

  // Depth limit check
  if (depth >= this.config.shadowDomDepth) {
    return {
      node_id: this.generateNodeId(),
      tag: 'shadow-root',
      text: '[Shadow DOM max depth reached]',
      visible: true,
    };
  }

  // Build virtual tree from shadow root children
  // Treat shadow root as a virtual container
  const children: VirtualNode[] = [];
  for (const child of shadowRoot.children) {
    const childNode = await this.buildVirtualTree(child, 0);
    if (childNode.visible || this.isStructuralElement(child)) {
      children.push(childNode);
    }
  }

  // Return virtual node representing the shadow tree
  return {
    node_id: this.generateNodeId(),
    tag: 'shadow-root',
    role: 'region',
    'aria-label': 'Shadow DOM content',
    visible: true,
    children,
  };
}
```

### iframe Traversal

Same-origin iframes can be traversed. Cross-origin iframes will be ignored and emit a console log.

```typescript
/**
 * Capture iframe content
 * Only same-origin iframes are accessible
 *
 * @param iframe - iframe element
 * @param depth - Current iframe depth (max: 1)
 * @returns VirtualNode representing iframe document
 */
private async captureIframe(
  iframe: HTMLIFrameElement,
  depth: number
): Promise<VirtualNode | undefined> {
  // Depth limit check
  if (depth >= this.config.iframeDepth) {
    return {
      node_id: this.generateNodeId(),
      tag: 'iframe',
      text: '[iframe max depth reached]',
      visible: true,
      metadata: {
        href: iframe.src,
      },
    };
  }

  // Attempt to access iframe document (may throw for cross-origin)
  let iframeDoc: Document;
  try {
    iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!iframeDoc) {
      throw new Error('Cannot access iframe document');
    }
  } catch (error) {
    // Cross-origin iframe - cannot access
    return {
      node_id: this.generateNodeId(),
      tag: 'iframe',
      'aria-label': 'Cross-origin iframe (inaccessible)',
      visible: true,
      metadata: {
        href: iframe.src,
      },
    };
  }

  // Build virtual tree from iframe body
  const iframeBody = iframeDoc.body;
  if (!iframeBody) {
    return undefined;
  }

  const children: VirtualNode[] = [];
  for (const child of iframeBody.children) {
    const childNode = await this.buildVirtualTree(child, 0);
    if (childNode.visible || this.isStructuralElement(child)) {
      children.push(childNode);
    }
  }

  // Return virtual node representing the iframe document
  return {
    node_id: this.generateNodeId(),
    tag: 'iframe',
    role: 'document',
    'aria-label': iframeDoc.title || 'iframe content',
    visible: true,
    children,
    metadata: {
      href: iframe.src,
    },
  };
}
```

### Visibility Filtering

Only include elements visible to human users. This drastically reduces noise for LLMs.

```typescript
/**
 * Check if element is visible to human users
 *
 * Checks:
 * - display !== 'none'
 * - visibility !== 'hidden'
 * - opacity > 0
 * - width > 0 && height > 0
 * - Not hidden by aria-hidden or inert
 *
 * @param element - Element to check
 * @returns Visibility information
 */
private checkVisibility(element: Element): {
  visible: boolean;
  inViewport: boolean;
  boundingBox?: BoundingBox;
} {
  // Get computed styles
  const styles = window.getComputedStyle(element);

  // Check display
  if (styles.display === 'none') {
    return { visible: false, inViewport: false };
  }

  // Check visibility
  if (styles.visibility === 'hidden') {
    return { visible: false, inViewport: false };
  }

  // Check opacity
  const opacity = parseFloat(styles.opacity);
  if (opacity === 0) {
    return { visible: false, inViewport: false };
  }

  // Check ARIA hidden
  if (element.getAttribute('aria-hidden') === 'true') {
    return { visible: false, inViewport: false };
  }

  // Check inert attribute (modern browsers)
  if (element.hasAttribute('inert')) {
    return { visible: false, inViewport: false };
  }

  // Get bounding box
  const rect = element.getBoundingClientRect();

  // Check dimensions
  if (rect.width <= 0 || rect.height <= 0) {
    return { visible: false, inViewport: false };
  }

  // Element is visible
  const boundingBox: BoundingBox = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };

  // Check viewport intersection
  const inViewport = this.isInViewport(rect);

  return {
    visible: true,
    inViewport,
    boundingBox,
  };
}

/**
 * Check if bounding box intersects viewport
 */
private isInViewport(rect: DOMRect): boolean {
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}
```

### Accessible Name Computation

Follow WCAG accessible name computation algorithm for consistent labeling.

```typescript
/**
 * Compute accessible name for an element
 * Follows WCAG accessible name computation algorithm
 *
 * Priority:
 * 1. aria-labelledby (referenced elements' text)
 * 2. aria-label attribute
 * 3. Label element (for inputs)
 * 4. Placeholder (for inputs)
 * 5. Title attribute
 * 6. Alt text (for images)
 * 7. Visible text content
 * 8. Tag name + role fallback
 *
 * @param element - Element to compute name for
 * @returns Accessible name (max 160 chars)
 */
private computeAccessibleName(element: Element): string {
  // 1. aria-labelledby
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const referencedIds = labelledBy.split(/\s+/);
    const texts = referencedIds
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (texts.length > 0) {
      return this.truncate(texts.join(' '), 160);
    }
  }

  // 2. aria-label
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return this.truncate(ariaLabel.trim(), 160);
  }

  // 3. Label element (for inputs)
  if (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement) {
    const label = this.findLabelForInput(element);
    if (label) {
      return this.truncate(label.textContent?.trim() || '', 160);
    }
  }

  // 4. Placeholder (for inputs)
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    return this.truncate(placeholder.trim(), 160);
  }

  // 5. Title attribute
  const title = element.getAttribute('title');
  if (title) {
    return this.truncate(title.trim(), 160);
  }

  // 6. Alt text (for images)
  if (element instanceof HTMLImageElement) {
    const alt = element.getAttribute('alt');
    if (alt) {
      return this.truncate(alt.trim(), 160);
    }
  }

  // 7. Visible text content (direct children only, no deep traversal)
  const text = this.getDirectTextContent(element);
  if (text) {
    return this.truncate(text, 160);
  }

  // 8. Fallback: tag name + role
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role') || tag;
  return `[${role}]`;
}

/**
 * Find label element for an input
 */
private findLabelForInput(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): HTMLLabelElement | null {
  // Check for wrapping label
  let parent = input.parentElement;
  while (parent) {
    if (parent instanceof HTMLLabelElement) {
      return parent;
    }
    parent = parent.parentElement;
  }

  // Check for label with "for" attribute
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label instanceof HTMLLabelElement) {
      return label;
    }
  }

  return null;
}

/**
 * Get direct text content (no deep traversal)
 */
private getDirectTextContent(element: Element): string {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    }
  }
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Truncate string to max length with ellipsis
 */
private truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}
```

### Framework-Compatible Input

Handle React, Vue, and other framework input quirks for reliable typing.

```typescript
/**
 * Type text into an input element with framework compatibility
 *
 * Handles:
 * - React _valueTracker for value detection
 * - Vue v-model binding
 * - Native input validation
 *
 * @param element - Input element
 * @param text - Text to type
 * @param options - Type options
 */
private async typeIntoInput(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  options: TypeOptions
): Promise<void> {
  // Focus element
  element.focus();

  // Clear existing value if requested
  if (options.clearFirst) {
    element.value = '';
    this.dispatchInputEvent(element);
  }

  // Type character by character (if speed > 0)
  if (options.speed && options.speed > 0) {
    for (const char of text) {
      element.value += char;
      this.dispatchInputEvent(element);
      await this.sleep(options.speed);
    }
  } else {
    // Instant typing
    element.value = text;
  }

  // Dispatch input event for frameworks
  this.dispatchInputEvent(element);

  // Update React's _valueTracker if present
  this.updateReactValueTracker(element);

  // Dispatch change event
  element.dispatchEvent(new Event('change', { bubbles: true }));

  // Press Enter if requested
  if (options.pressEnter) {
    this.dispatchKeyboardEvent(element, 'Enter');
  }

  // Blur if requested
  if (options.blur) {
    element.blur();
  }
}

/**
 * Dispatch input event for framework compatibility
 */
private dispatchInputEvent(element: HTMLElement): void {
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
}

/**
 * Update React's internal _valueTracker
 * Required for React to detect value changes
 */
private updateReactValueTracker(element: HTMLInputElement | HTMLTextAreaElement): void {
  const tracker = (element as any)._valueTracker;
  if (tracker) {
    tracker.setValue('');
  }
}

/**
 * Sleep utility
 */
private sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Dispatch keyboard event
 */
private dispatchKeyboardEvent(element: HTMLElement, key: string): void {
  const eventInit: KeyboardEventInit = {
    key,
    code: this.getKeyCode(key),
    bubbles: true,
    cancelable: true,
    composed: true,
  };

  element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  element.dispatchEvent(new KeyboardEvent('keypress', eventInit));
  element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
}

/**
 * Get key code from key name
 */
private getKeyCode(key: string): string {
  const keyCodeMap: Record<string, string> = {
    'Enter': 'Enter',
    'Escape': 'Escape',
    'Tab': 'Tab',
    'ArrowUp': 'ArrowUp',
    'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft',
    'ArrowRight': 'ArrowRight',
    ' ': 'Space',
  };
  return keyCodeMap[key] || key;
}
```

---

## Content Script Integration

### Message Flow

```typescript
/**
 * content-script.ts integration
 *
 * Maintains existing MessageRouter pattern
 * Adds new DomTool instance and handlers
 */

import { DomTool } from './DomTool';

// Global DomTool instance
let domTool: DomTool | null = null;

function initialize(): void {
  console.log('[Browserx] Content script initialized');

  // Initialize DomTool
  domTool = new DomTool();

  // Setup message router
  router = new MessageRouter('content');
  setupMessageHandlers();
  announcePresence();
}

function setupMessageHandlers(): void {
  if (!router) return;

  // Existing handlers...
  router.on(MessageType.PING, handlePing);

  // New DomTool handler
  router.on(MessageType.TAB_COMMAND, async (message) => {
    const { command, args } = message.payload;

    switch (command) {
      case 'get-snapshot':
        return await domTool?.getSnapshot(args?.force);

      case 'get-serialized-dom':
        return await domTool?.get_serialized_dom(args?.options);

      case 'dom-click':
        return await domTool?.click(args.nodeId, args.options);

      case 'dom-type':
        return await domTool?.type(args.nodeId, args.text, args.options);

      case 'dom-keypress':
        return await domTool?.keypress(args.key, args.options);

      // Legacy support
      case 'capture-interaction-content':
        // Map to new API
        const snapshot = await domTool?.getSnapshot();
        const serialized = await domTool?.get_serialized_dom(args);
        // Convert to PageModel format for backward compatibility
        return convertToPageModel(serialized);

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  });

  // Existing page action handler
  router.on('PAGE_ACTION_EXECUTE' as MessageType, handlePageAction);
}

// Cleanup on page unload
window.addEventListener('pagehide', () => {
  if (domTool) {
    domTool.destroy();
  }
  if (router) {
    router.cleanup();
  }
});
```

### Backward Compatibility

Provide adapter to convert new SerializedDom format to legacy PageModel format during transition.

```typescript
/**
 * Convert flattened SerializedDom to legacy PageModel format
 * Temporary adapter for backward compatibility
 */
function convertToPageModel(serialized: SerializedDom, snapshot: DomSnapshot): PageModel {
  const controls: InteractiveControl[] = [];
  const aimap: SelectorMap = {};
  const headings: string[] = [];
  const regions = new Set<string>();

  // Traverse flattened tree to extract controls and metadata
  function traverse(node: SerializedNode, currentRegion?: string) {
    // Track landmark regions
    if (node.role && ['main', 'navigation', 'header', 'footer', 'aside'].includes(node.role)) {
      regions.add(node.role);
      currentRegion = node.role;
    }

    // Extract headings
    if (node.tag.match(/^h[1-3]$/) && node.text) {
      headings.push(node.text);
    }

    // Extract interactive/actionable elements
    if (node.role && isInteractiveRole(node.role)) {
      const control: InteractiveControl = {
        id: node.id,
        role: node.role as ControlRole,
        name: node['aria-label'] || node.text || '',
        selector: '', // Will generate from snapshot
        visible: true,
        inViewport: !node.offscreen,
        states: {},
        region: currentRegion as LandmarkRegion | undefined,
      };

      // Add states
      if (node.disabled) control.states!.disabled = true;
      if (node.checked !== undefined) control.states!.checked = node.checked;
      if (node.required) control.states!.required = true;
      if (node.href) control.states!.href = node.href;
      if (node.placeholder) control.states!.placeholder = node.placeholder;
      if (node.value) control.states!.value = node.value;

      controls.push(control);

      // Generate CSS selector from snapshot mapping
      const realElement = snapshot.getRealElement(node.id);
      if (realElement) {
        const selector = generateCssSelectorForElement(realElement);
        aimap[node.id] = selector;
      }
    }

    // Recurse children
    if (node.children) {
      for (const child of node.children) {
        traverse(child, currentRegion);
      }
    }
  }

  function isInteractiveRole(role: string): boolean {
    const interactiveRoles = [
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'menuitem', 'tab', 'switch', 'slider', 'listitem', 'option'
    ];
    return interactiveRoles.includes(role);
  }

  // Start traversal from body
  traverse(serialized.page.body);

  return {
    title: serialized.page.context.title,
    url: serialized.page.context.url,
    headings,
    regions: Array.from(regions),
    controls,
    aimap,
  };
}
```

---

## Migration Strategy

### Phase 1: Parallel Implementation (Week 1-2)

1. **Create new DomTool.ts** in `src/content/`
   - Implement VirtualNode interface
   - Implement DomSnapshot class
   - Implement DomTool class with all methods

2. **Write comprehensive unit tests**
   - Test VirtualNode creation
   - Test visibility filtering
   - Test actionability detection
   - Test serialization

3. **Create integration tests**
   - Test on sample HTML pages
   - Test iframe handling
   - Test shadow DOM handling
   - Test action execution

### Phase 2: Content Script Integration (Week 3)

1. **Update content-script.ts**
   - Add DomTool instantiation
   - Add new message handlers
   - Keep legacy handlers for backward compatibility

2. **Create backward compatibility adapter**
   - Implement convertToPageModel()
   - Test with existing DOMTool consumers

3. **Update background DOMTool.ts**
   - Add new command types
   - Route to new content script handlers
   - Keep legacy commands active

### Phase 3: Testing & Validation (Week 4)

1. **End-to-end testing**
   - Test on real websites (Google, GitHub, Twitter, etc.)
   - Verify LLM can understand serialized DOM
   - Test action execution reliability

2. **Performance benchmarking**
   - Measure snapshot creation time
   - Measure serialization time
   - Compare token usage vs legacy

3. **Bug fixes and refinements**
   - Address edge cases
   - Optimize performance bottlenecks
   - Improve error handling

### Phase 4: Legacy Removal (Week 5)

1. **Remove legacy code**
   - Remove old interactionCapture.ts approach
   - Remove PageModel-based handlers
   - Remove backward compatibility adapter

2. **Update documentation**
   - Update API documentation
   - Update integration guides
   - Create migration guide for extensions

3. **Final testing**
   - Regression testing
   - Performance validation
   - Production deployment

---

## Performance Considerations

### Optimization Strategies

#### 1. Incremental Snapshot Creation

For very large DOMs (>10,000 elements), use incremental processing:

```typescript
/**
 * Create snapshot incrementally to avoid blocking main thread
 */
async function createSnapshotIncremental(
  batchSize: number = 100
): Promise<DomSnapshot> {
  const elements = document.body.querySelectorAll('*');
  const batches = Math.ceil(elements.length / batchSize);

  for (let i = 0; i < batches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, elements.length);
    const batch = Array.from(elements).slice(start, end);

    // Process batch
    for (const element of batch) {
      await processElement(element);
    }

    // Yield to browser
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return buildSnapshot();
}
```

#### 2. Snapshot Caching & Invalidation

Cache snapshots and invalidate intelligently:

```typescript
/**
 * Mutation observer to invalidate snapshot
 * Only invalidate on significant changes
 */
private setupMutationObserver(): void {
  let mutationCount = 0;
  let throttleTimeout: number | null = null;

  this.mutationObserver = new MutationObserver((mutations) => {
    mutationCount += mutations.length;

    // Throttle invalidation
    if (throttleTimeout) return;

    throttleTimeout = window.setTimeout(() => {
      // Invalidate if significant changes
      if (mutationCount > 50) {
        this.invalidateSnapshot();
      }
      mutationCount = 0;
      throttleTimeout = null;
    }, this.config.mutationThrottle);
  });

  this.mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
  });
}
```

#### 3. Serialization Optimization

Optimize JSON serialization for token efficiency with flattening:

```typescript
/**
 * Flatten VirtualNode tree to SerializedDom
 * - Remove unnecessary structural containers (divs, headers, navs)
 * - Hoist children to reduce nesting depth
 * - Keep semantic groups (forms, dialogs) for context
 * - Omit non-essential elements and default values
 * - 40-60% token reduction vs full tree
 */
function serialize(snapshot: DomSnapshot, options: SerializationOptions): SerializedDom {
  /**
   * Flatten a node by removing structural containers
   * Returns flattened children or the node itself if it should be kept
   */
  function flattenNode(node: VirtualNode): SerializedNode | SerializedNode[] | null {
    // Skip invisible elements (unless it's a structural container with visible children)
    if (!node.visible && !hasVisibleChildren(node)) {
      return null;
    }

    // Skip non-essential elements with no actionable content
    if (isSkippableElement(node)) {
      return null;
    }

    // Determine if this is a structural container to flatten
    const isContainer = isStructuralContainer(node);

    // Determine if this is a semantic group to preserve
    const isSemanticGroup = isSemanticGroupElement(node);

    // Process children recursively
    const flattenedChildren: SerializedNode[] = [];
    if (node.children) {
      for (const child of node.children) {
        const result = flattenNode(child);
        if (result) {
          if (Array.isArray(result)) {
            flattenedChildren.push(...result);
          } else {
            flattenedChildren.push(result);
          }
        }
      }
    }

    // If this is a pure structural container (no value itself), return its children
    if (isContainer && !node.role && !node.text && !isSemanticGroup) {
      return flattenedChildren;
    }

    // Build serialized node
    const serialized: SerializedNode = {
      id: node.node_id,
      tag: node.tag,
    };

    // Add optional properties (only non-defaults)
    if (node.role) serialized.role = node.role;
    if (node['aria-label']) serialized['aria-label'] = node['aria-label'];
    if (node.text) serialized.text = node.text;
    if (node.value) serialized.value = node.value;
    if (node.metadata?.href) serialized.href = node.metadata.href;
    if (node.metadata?.placeholder) serialized.placeholder = node.metadata.placeholder;
    if (node.metadata?.inputType) serialized.inputType = node.metadata.inputType;
    if (node.metadata?.states?.disabled) serialized.disabled = true;
    if (node.metadata?.states?.checked) serialized.checked = node.metadata.states.checked;
    if (node.metadata?.states?.required) serialized.required = true;
    if (node.metadata?.states?.expanded !== undefined) serialized.expanded = node.metadata.states.expanded;
    if (!node.metadata?.inViewport) serialized.offscreen = true;

    // Include children only if meaningful
    if (flattenedChildren.length > 0) {
      serialized.children = flattenedChildren;
    }

    return serialized;
  }

  /**
   * Check if node is a structural container (header, nav, main, footer, section, div)
   */
  function isStructuralContainer(node: VirtualNode): boolean {
    const containerTags = ['header', 'nav', 'main', 'footer', 'section', 'div', 'aside'];
    return containerTags.includes(node.tag);
  }

  /**
   * Check if node is a semantic group that provides context (form, dialog, details)
   */
  function isSemanticGroupElement(node: VirtualNode): boolean {
    const semanticTags = ['form', 'dialog', 'details', 'fieldset', 'table'];
    return semanticTags.includes(node.tag);
  }

  /**
   * Check if element should be skipped entirely
   */
  function isSkippableElement(node: VirtualNode): boolean {
    // Skip if no interactive content and no meaningful text
    if (!node.role && !node.text && !hasInteractiveChildren(node)) {
      // Skip purely decorative elements
      if (['footer', 'aside'].includes(node.tag)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if node has visible children
   */
  function hasVisibleChildren(node: VirtualNode): boolean {
    if (!node.children) return false;
    return node.children.some(child => child.visible || hasVisibleChildren(child));
  }

  /**
   * Check if node has interactive children
   */
  function hasInteractiveChildren(node: VirtualNode): boolean {
    if (!node.children) return false;
    return node.children.some(child => child.role || hasInteractiveChildren(child));
  }

  // Flatten the entire tree
  const bodyNode = flattenNode(snapshot.virtualDom);
  const body: SerializedNode = Array.isArray(bodyNode)
    ? { id: 'node_root', tag: 'body', children: bodyNode }
    : (bodyNode as SerializedNode);

  return {
    page: {
      context: {
        url: snapshot.context.url,
        title: snapshot.context.title,
      },
      body,
    },
  };
}
```

### Performance Targets

| Metric | Target | Rationale |
|--------|--------|-----------|
| Snapshot creation (p50) | < 2 seconds | Responsive for typical pages |
| Snapshot creation (p90) | < 5 seconds | Acceptable for complex SPAs |
| Snapshot creation (p99) | < 10 seconds | Rare worst-case |
| Hard timeout | 30 seconds | Prevent indefinite hangs |
| Serialization | < 500ms | Fast JSON generation |
| Memory usage | < 50MB | Reasonable for extension |
| Action execution | < 100ms | Feels instant |
| Token count | < 20k tokens | Fit in Claude Sonnet context |

---

## Testing Strategy

### Unit Tests

```typescript
describe('DomTool', () => {
  describe('getSnapshot', () => {
    it('should create snapshot of simple DOM', async () => {
      document.body.innerHTML = `
        <div>
          <button id="btn">Click me</button>
          <input type="text" placeholder="Name" />
        </div>
      `;

      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();

      expect(snapshot.virtualDom).toBeDefined();
      expect(snapshot.stats.interactiveNodes).toBe(2);
    });

    it('should filter out hidden elements', async () => {
      document.body.innerHTML = `
        <button id="visible">Visible</button>
        <button id="hidden" style="display: none">Hidden</button>
      `;

      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();

      const serialized = snapshot.serialize();
      const buttons = serialized.page.body.children?.filter(e => e.tag === 'button') || [];

      expect(buttons).toHaveLength(1);
      expect(buttons[0].text).toBe('Visible');
    });

    it('should detect clickable divs with event listeners', async () => {
      document.body.innerHTML = `
        <div class="btn-primary" style="cursor: pointer">Click</div>
      `;

      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();

      const serialized = snapshot.serialize();
      const clickableElements = serialized.page.body.children || [];

      expect(clickableElements).toHaveLength(1);
      expect(clickableElements[0].text).toBe('Click');
    });
  });

  describe('click', () => {
    it('should click element and detect changes', async () => {
      document.body.innerHTML = `
        <button id="btn">Click me</button>
      `;

      const button = document.getElementById('btn')!;
      let clicked = false;
      button.addEventListener('click', () => { clicked = true; });

      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();

      // Find button in flattened children
      const serialized = snapshot.serialize();
      const buttonElem = serialized.page.body.children?.find(e => e.tag === 'button');

      const result = await tool.click(buttonElem!.id);

      expect(result.success).toBe(true);
      expect(clicked).toBe(true);
    });
  });

  describe('type', () => {
    it('should type text into input', async () => {
      document.body.innerHTML = `
        <input type="text" id="name" />
      `;

      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();

      // Find input in flattened children
      const serialized = snapshot.serialize();
      const inputElem = serialized.page.body.children?.find(e => e.tag === 'input');

      const result = await tool.type(inputElem!.id, 'John Doe');

      expect(result.success).toBe(true);
      expect((document.getElementById('name') as HTMLInputElement).value).toBe('John Doe');
    });
  });
});
```

### Integration Tests

```typescript
describe('DomTool Integration', () => {
  it('should handle iframe content', async () => {
    document.body.innerHTML = `
      <iframe id="frame" srcdoc="<button>Iframe button</button>"></iframe>
    `;

    await waitForIframeLoad();

    const tool = new DomTool();
    const snapshot = await tool.getSnapshot();
    const serialized = snapshot.serialize();

    expect(serialized.page.iframes).toHaveLength(1);
    expect(serialized.page.iframes![0].body.children).toBeDefined();
    expect(serialized.page.iframes![0].body.children![0].tag).toBe('button');
  });

  it('should handle shadow DOM', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Shadow button</button>';
    document.body.appendChild(host);

    const tool = new DomTool();
    const snapshot = await tool.getSnapshot();
    const serialized = snapshot.serialize();

    // Shadow DOM elements are in separate section
    expect(serialized.page.shadowDoms).toHaveLength(1);
    expect(serialized.page.shadowDoms![0].body.children![0].tag).toBe('button');
    expect(serialized.page.shadowDoms![0].body.children![0].text).toBe('Shadow button');
  });

  it('should handle complex SPA (React)', async () => {
    // Mount React app with multiple interactive elements
    ReactDOM.render(<ComplexApp />, document.body);

    const tool = new DomTool();
    const snapshot = await tool.getSnapshot();

    expect(snapshot.stats.interactiveNodes).toBeGreaterThan(10);
    expect(snapshot.stats.captureTimeMs).toBeLessThan(5000);
  });
});
```

### End-to-End Tests

```typescript
describe('E2E: Real Website Tests', () => {
  it('should capture Google search page', async () => {
    await page.goto('https://www.google.com');

    const serialized = await page.evaluate(async () => {
      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();
      return snapshot.serialize();
    });

    expect(serialized.page.context.title).toContain('Google');
    expect(serialized.page.body.children).toBeDefined();

    // Should find search input in flattened body
    function findNode(node: SerializedNode, predicate: (n: SerializedNode) => boolean): SerializedNode | null {
      if (predicate(node)) return node;
      if (node.children) {
        for (const child of node.children) {
          const found = findNode(child, predicate);
          if (found) return found;
        }
      }
      return null;
    }

    const searchInput = findNode(serialized.page.body, n =>
      n.role === 'textbox' && n['aria-label']?.toLowerCase().includes('search')
    );
    expect(searchInput).toBeDefined();
  });

  it('should interact with GitHub UI', async () => {
    await page.goto('https://github.com/login');

    const result = await page.evaluate(async () => {
      const tool = new DomTool();
      const snapshot = await tool.getSnapshot();
      const serialized = snapshot.serialize();

      // Find username input in flattened tree
      function findNode(node: SerializedNode, predicate: (n: SerializedNode) => boolean): SerializedNode | null {
        if (predicate(node)) return node;
        if (node.children) {
          for (const child of node.children) {
            const found = findNode(child, predicate);
            if (found) return found;
          }
        }
        return null;
      }

      const usernameInput = findNode(serialized.page.body, n =>
        n.role === 'textbox' && n['aria-label']?.toLowerCase().includes('username')
      );

      if (!usernameInput) {
        throw new Error('Username input not found');
      }

      // Type into username
      return await tool.type(usernameInput.id, 'testuser');
    });

    expect(result.success).toBe(true);
  });
});
```

---

## Future Enhancements

### Phase 2: Advanced Features

1. **Visual Context Integration**
   - Screenshot capture integration
   - Bounding box highlighting
   - Visual element identification for vision-capable models

2. **Differential Snapshots**
   - Capture only changes since last snapshot
   - Reduce token usage for incremental updates
   - Faster refresh for dynamic pages

3. **Smart Element Prioritization**
   - ML-based relevance scoring
   - Viewport-first ordering
   - User interaction heatmap integration

4. **Enhanced Clickability Detection**
   - CSS pseudo-class detection (`:hover`, `:active`)
   - JavaScript framework hook detection (React DevTools integration)
   - Event listener introspection (if browser APIs allow)

5. **Multi-Frame Coordination**
   - Cross-origin iframe content via messaging
   - Nested iframe support (depth > 1)
   - Frame-aware action execution

6. **Accessibility Audit**
   - WCAG compliance checking
   - Missing label detection
   - Keyboard accessibility validation

### Phase 3: Performance & Scale

1. **Web Worker Processing**
   - Offload DOM traversal to Web Worker
   - Parallel processing for large DOMs
   - Non-blocking snapshot creation

2. **Streaming Serialization**
   - JSON streaming for very large trees
   - Chunked transmission to background script
   - Progressive LLM consumption

3. **Smart Caching**
   - Persistent snapshot cache across navigations
   - Incremental updates for SPAs
   - Diff-based change detection

---

## Appendix A: Example Serialized DOM

### Input HTML

```html
<!DOCTYPE html>
<html>
<head>
  <title>Sample Page</title>
</head>
<body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>

  <main>
    <h1>Welcome</h1>
    <p>This is a sample page.</p>

    <form>
      <label for="name">Name:</label>
      <input type="text" id="name" placeholder="Enter your name" />

      <button type="submit">Submit</button>
    </form>
  </main>

  <footer>
    <p>&copy; 2025</p>
  </footer>
</body>
</html>
```

### Output SerializedDom (Flattened Format)

```json
{
  "page": {
    "context": {
      "url": "https://example.com",
      "title": "Sample Page"
    },
    "body": {
      "id": "node_0",
      "tag": "body",
      "children": [
        {
          "id": "node_1",
          "tag": "a",
          "role": "link",
          "aria-label": "Home",
          "text": "Home",
          "href": "/"
        },
        {
          "id": "node_2",
          "tag": "a",
          "role": "link",
          "aria-label": "About",
          "text": "About",
          "href": "/about"
        },
        {
          "id": "node_3",
          "tag": "h1",
          "text": "Welcome"
        },
        {
          "id": "node_4",
          "tag": "p",
          "text": "This is a sample page."
        },
        {
          "id": "node_5",
          "tag": "form",
          "children": [
            {
              "id": "node_6",
              "tag": "label",
              "text": "Name:"
            },
            {
              "id": "node_7",
              "tag": "input",
              "role": "textbox",
              "aria-label": "Name:",
              "placeholder": "Enter your name",
              "inputType": "text"
            },
            {
              "id": "node_8",
              "tag": "button",
              "role": "button",
              "aria-label": "Submit",
              "text": "Submit"
            }
          ]
        }
      ]
    }
  }
}
```

**Token Comparison:**
- **Full DOM tree**: ~200 tokens (with header, nav, main, footer containers)
- **Flattened format**: ~90 tokens (containers removed, elements hoisted)
- **Savings**: 55% reduction in token usage

**Key Flattening Strategy:**
1. **Remove structural containers**: header, nav, main, footer divs omitted
2. **Hoist children**: Links moved directly under body (not nested in nav/header)
3. **Keep semantic groups**: Form structure preserved for interaction context
4. **Omit non-essential elements**: Footer with just copyright removed
5. **Omit default values**: `inViewport: true` omitted (default)
6. **Sequential IDs**: Simple node_0, node_1, node_2... format

---

## Appendix B: Comparison with Current Implementation

### Current Approach (PageModel)

**Strengths:**
- Flat control list is simple to iterate
- Stable ID generation with role prefixes
- Privacy-first value handling
- Good performance with limits

**Limitations:**
- CSS selector-based mapping can be fragile
- Limited clickable element detection (semantic HTML only)
- No explicit iframe/shadow DOM separation
- Mixes all control types together

### Proposed Approach (VirtualNode + Flattened Serialization)

**Internal Architecture (VirtualNode Tree):**
- Complete tree structure for accurate DOM mapping
- Bidirectional mapping with WeakRef for memory efficiency
- Complete visibility and actionability detection
- Shadow DOM and iframe support

**LLM Serialization (Flattened Tree Format):**
- **40-60% smaller** than full tree output
- Remove structural containers (divs, headers, navs, sections)
- Hoist children to body level when containers don't add value
- Preserve semantic groups (forms, dialogs) for interaction context
- Omit default values for token efficiency

**Key Improvements:**
1. **Smart flattening** - Removes noise while keeping context
2. **Enhanced interactive detection** - Beyond semantic HTML, used internally only
3. **No misleading fields** - Removed `actionable` flag, LLM infers from role/tag/attributes
4. **Explicit iframe/shadow DOM handling** - Separate sections
5. **Token optimization** - Flattened tree, not full DOM
6. **Better mapping** - WeakRef prevents memory leaks
7. **Semantic preservation** - Forms stay grouped for "button in form" context

**Best of Both Worlds:**
- **Internal**: Rich tree structure for accurate mapping
- **External**: Flattened, token-efficient tree for LLM
- No trade-offs - maximum efficiency at both layers

---

## Appendix C: Key Design Decisions

### Decision 1: Internal Tree, External Flattened Tree

**Options Considered:**
1. Full tree everywhere (accurate but token-heavy with containers)
2. Completely flat list (token-efficient but loses all context)
3. Hybrid: Internal tree, flattened tree for LLM (best of both)

**Decision:** Hybrid approach - VirtualNode tree internally, flattened tree serialization for LLM

**Rationale:**
- **User feedback**: Unnecessary structural containers consume tokens without helping LLM
- **Internal tree benefits**: Accurate DOM mapping, efficient lookups, complete context
- **Flattened tree benefits**: 40-60% token reduction while preserving important structure
- **Smart flattening**: Removes divs/headers/navs, keeps forms/dialogs for interaction context
- **Semantic preservation**: "The button in the login form" is still meaningful
- **Token efficiency**: Eliminates redundant nesting without losing essential relationships

### Decision 2: Snapshot Immutability

**Decision:** Snapshots are immutable, invalidated on major changes

**Rationale:**
- Consistent view for LLM reasoning
- Avoids race conditions during action execution
- Clear cache invalidation semantics
- Aligns with functional programming principles

### Decision 3: WeakRef for Mapping

**Decision:** Use WeakRef for element references in mapping

**Rationale:**
- Prevents memory leaks from detached elements
- Automatic garbage collection
- Graceful handling of stale references
- Modern browser support (2021+)

### Decision 4: First-Level Only for iframe/Shadow DOM

**Decision:** Only traverse first-level iframes and shadow DOMs

**Rationale:**
- Deep nesting is rare in practice
- Performance impact of deep traversal
- Complexity of cross-origin communication
- Can extend if needed later

### Decision 5: Heuristic Clickability Detection

**Decision:** Use heuristics (cursor, tabindex, class names) for event listener detection

**Rationale:**
- `getEventListeners()` only available in DevTools
- No reliable content script API for listener introspection
- Heuristics cover 90%+ of real-world cases
- Framework-specific attributes help

---

## Conclusion

This design proposes a comprehensive refactor of BrowserX's DOM tool using a **hybrid architecture** that combines the best of both approaches:

### Dual-Layer Design

1. **Internal Layer (VirtualNode Tree)**
   - Complete DOM representation with parent-child relationships
   - Accurate bidirectional mapping using WeakRef
   - Support for shadow DOM and iframe traversal
   - Foundation for precise action execution

2. **External Layer (Flattened Tree Serialization)**
   - **40-60% token reduction** through smart flattening
   - Remove structural containers (divs, headers, navs, sections)
   - Hoist children to reduce nesting depth
   - Preserve semantic groups (forms, dialogs) for interaction context
   - Optimized for LLM comprehension and action

### Key Benefits

- **Token Efficiency**: Addresses primary concern about unnecessary structural containers wasting tokens
- **Context Preservation**: Keeps semantic groups like forms so "the submit button in the login form" remains meaningful
- **Accurate Mapping**: Internal tree enables precise element location and action execution
- **Clear Signals**: Removed `actionable` field - LLM infers interactivity from role, tag, href, onclick, etc. (avoiding misleading booleans)
- **Modern Detection**: Enhanced interactive element detection beyond semantic HTML (used internally for role assignment)
- **Smart Simplification**: Removes noise while preserving structure that adds value
- **Extensible**: Foundation for future enhancements

The phased migration strategy ensures backward compatibility and minimal disruption, with clear performance targets and comprehensive testing at each stage.

**Recommended Next Steps:**
1. Review and approve design
2. Begin Phase 1 implementation (DomTool core)
3. Create test suite (unit + integration)
4. Pilot with sample websites
5. Gather feedback and iterate

---

**Document Version History:**
- v1.0 (2025-10-24): Initial design proposal
- v1.2 (2025-10-24): Updated to flattened tree format based on user feedback - removes structural containers while preserving semantic groups - 40-60% token reduction
- v1.3 (2025-10-24): Removed `actionable` field from VirtualNode - LLM infers interactivity from role/tag/attributes, avoiding misleading signals
