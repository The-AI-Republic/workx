/**
 * DOM Tool API Types - Version 3.0.0
 *
 * This file defines the types for the refactored DOMTool v3.0.
 * This is a BREAKING CHANGE from v2.0 - no backward compatibility.
 *
 * @version 3.0.0
 * @date 2025-10-24
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Special nodeId for window-level scroll actions
 * Use this when calling scroll() on the entire window
 */
export const NODE_ID_WINDOW = -1;

/**
 * Special nodeId for document-level keyboard actions
 * Use this when calling keypress() without a specific target element
 */
export const NODE_ID_DOCUMENT = -2;

/**
 * DOM Node Type Constants (from W3C DOM specification)
 * https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
 *
 * These constants represent the type of DOM node in the VirtualNode tree.
 * Most commonly used are:
 * - NODE_TYPE_ELEMENT (1): HTML elements like <div>, <button>, etc.
 * - NODE_TYPE_TEXT (3): Text content within elements
 * - NODE_TYPE_DOCUMENT_FRAGMENT (11): Shadow DOM roots
 */
export const NODE_TYPE_ELEMENT = 1;
export const NODE_TYPE_ATTRIBUTE = 2;
export const NODE_TYPE_TEXT = 3;
export const NODE_TYPE_CDATA_SECTION = 4;
export const NODE_TYPE_ENTITY_REFERENCE = 5; // Deprecated
export const NODE_TYPE_ENTITY = 6; // Deprecated
export const NODE_TYPE_PROCESSING_INSTRUCTION = 7;
export const NODE_TYPE_COMMENT = 8;
export const NODE_TYPE_DOCUMENT = 9;
export const NODE_TYPE_DOCUMENT_TYPE = 10;
export const NODE_TYPE_DOCUMENT_FRAGMENT = 11;
export const NODE_TYPE_NOTATION = 12; // Deprecated

// ============================================================================
// Data Structures
// ============================================================================


/**
 * Page context metadata
 */
export interface PageContext {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
}

/**
 * Snapshot statistics
 */
export interface SnapshotStats {
  totalNodes: number;
  visibleNodes: number;
  interactiveNodes: number;
  iframeCount: number;
  shadowDomCount: number;
  captureTimeMs: number;
}

/**
 * Flattened, token-optimized DOM representation for LLM
 *
 * @version 3.0.0 - T030: Normalized field names with snake_case convention
 */
export interface SerializedDom {
  page: {
    context: {
      url: string;
      title: string;
    };
    body: SerializedNode;
    iframes?: Array<{
      url: string;
      title: string;
      body: SerializedNode;
    }>;
    shadowDoms?: Array<{
      hostId: string;
      body: SerializedNode;
    }>;
    /** Compaction metrics for debugging (optional) */
    metrics?: {
      total_nodes: number;
      serialized_nodes: number;
      token_reduction_rate: number;
      compaction_score: number;
    };
    /** Collection-level state arrays (P3.5 MetadataBucketer) */
    states?: {
      disabled?: number[];
      checked?: number[];
      required?: number[];
      readonly?: number[];
      expanded?: number[];
      selected?: number[];
    };
  };
}

/**
 * Serialized node (flattened, defaults omitted)
 *
 * @version 3.0.0 - T030: Normalized field names
 * Field name mappings:
 * - aria-label → aria_label (snake_case for token efficiency)
 * - children → kids (shorter alias)
 * - placeholder → hint (shorter alias)
 * - inputType → input_type (snake_case)
 * - boundingBox → bbox (compact array [x, y, w, h])
 */
export interface SerializedNode {
  /** Sequential node ID (1, 2, 3...) mapped from backendNodeId */
  node_id: number;

  /** HTML tag name */
  tag: string;

  /** ARIA role */
  role?: string;

  /** ARIA label (normalized from aria-label) */
  aria_label?: string;

  /** Visible text content */
  text?: string;

  /** Current value for form inputs */
  value?: string;

  /** Child nodes (normalized from children) */
  kids?: SerializedNode[];

  /** Link href */
  href?: string;

  /** Input type (normalized from inputType) */
  input_type?: string;

  /** Placeholder text (normalized from placeholder) */
  hint?: string;

  /** Bounding box as compact array [x, y, width, height] */
  bbox?: number[];

  /** Element states (disabled, checked, etc.) - may be moved to collection-level */
  states?: Record<string, boolean | string>;

  /** Whether element is currently visible in viewport (>50% intersection) */
  inViewport?: boolean;
}


// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration options for DomTool behavior
 */
export interface DomToolConfig {
  /** Max time to wait for snapshot creation (ms) */
  snapshotTimeout?: number; // default: 30000

  /** Max interactive elements to capture */
  maxInteractiveElements?: number; // default: 400

  /** Max tree depth to traverse */
  maxTreeDepth?: number; // default: 50

  /** Auto invalidate snapshot on mutations */
  autoInvalidate?: boolean; // default: true

  /** Mutation observer throttle (ms) */
  mutationThrottle?: number; // default: 500

  /** Include iframe content */
  captureIframes?: boolean; // default: true

  /** Include shadow DOM content */
  captureShadowDom?: boolean; // default: true

  /** iframe traversal depth */
  iframeDepth?: number; // default: 1

  /** Shadow DOM traversal depth */
  shadowDomDepth?: number; // default: 1
}

/**
 * Options for serialization
 */
export interface SerializationOptions {
  /** Include form input values */
  includeValues?: boolean; // default: false

  /** Fine-grained metadata control */
  metadata?: {
    /** Include aria-label/accessibility name */
    includeAriaLabel?: boolean; // default: false

    /** Include text content */
    includeText?: boolean; // default: false

    /** Include form input values (overrides top-level includeValues) */
    includeValue?: boolean; // default: false

    /** Include input type attribute */
    includeInputType?: boolean; // default: false

    /** Include placeholder/hint text */
    includeHint?: boolean; // default: false

    /** Include bounding box coordinates */
    includeBbox?: boolean; // default: false

    /** Include element states (disabled, checked, etc.) */
    includeStates?: boolean; // default: false

    /** Include href for links */
    includeHref?: boolean; // default: false
  };

  /** Include invisible elements */
  includeHiddenElements?: boolean; // default: false

  /** Max text content length */
  maxTextLength?: number; // default: 500

  /** Max aria-label length */
  maxLabelLength?: number; // default: 250

  /** Omit fields with default values */
  omitDefaults?: boolean; // default: true
}

// ============================================================================
// Action Options & Results
// ============================================================================

/**
 * Options for click action
 */
export interface ClickOptions {
  /** Click button */
  button?: "left" | "right" | "middle"; // default: "left"

  /** Click type */
  clickType?: "single" | "double"; // default: "single"

  /** Modifier keys */
  modifiers?: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  };

  /** Wait for navigation after click */
  waitForNavigation?: boolean; // default: false

  /** Scroll into view before clicking */
  scrollIntoView?: boolean; // default: true
}

/**
 * Options for type action
 */
export interface TypeOptions {
  /** Clear existing value before typing */
  clearFirst?: boolean; // default: false

  /** Typing speed (ms per character, 0 for instant) */
  speed?: number; // default: 0

  /**
   * How to finalize the input after typing
   * - "change": Fire change event (default, appropriate for most text boxes)
   * - "enter": Append Enter keystroke (useful for search boxes or chat inputs)
   */
  commit?: "change" | "enter"; // default: "change"

  /** Blur element after typing */
  blur?: boolean; // default: false
}

/**
 * Options for keypress action
 */
export interface KeyPressOptions {
  /** Target element by node_id (document if omitted) */
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

/**
 * Result of action execution
 */
export interface ActionResult {
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

    /** Form value changed */
    valueChanged: boolean;

    /** New value if changed */
    newValue?: string;
  };

  /** Node ID that was acted upon */
  nodeId: number;

  /** Action type */
  actionType: "click" | "type" | "keypress" | "scroll";

  /** ISO 8601 timestamp */
  timestamp: string;
}


// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: Required<DomToolConfig> = {
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

/**
 * Default serialization options
 */
export const DEFAULT_SERIALIZATION_OPTIONS: Required<SerializationOptions> = {
  includeValues: true,
  metadata: {
    includeAriaLabel: true,
    includeText: true,
    includeValue: true,
    includeInputType: true,
    includeHint: true,
    includeBbox: false,
    includeStates: true,
    includeHref: true,
  },
  includeHiddenElements: false,
  maxTextLength: 500,
  maxLabelLength: 250,
  omitDefaults: true,
};
