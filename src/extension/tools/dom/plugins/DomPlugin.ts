import type { VirtualNode } from '../types';

/**
 * Plugin context provided to DOM plugins during execution
 */
export interface DomPluginContext {
  /** Tab ID for CDP commands */
  tabId: number;
  /** Current page URL */
  url: string;
  /** Current page title */
  title: string;
  /** Send CDP command function */
  sendCommand: <T>(method: string, params: any) => Promise<T>;
}

/**
 * Result returned by a DOM plugin after execution
 */
export interface DomPluginResult {
  /** Whether the plugin ran (false if not applicable to this page) */
  executed: boolean;
  /** Whether the plugin successfully augmented the tree (only valid if executed=true) */
  success: boolean;
  /** Number of nodes augmented/added */
  nodesAugmented: number;
  /** Error message if failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Base class for DOM plugins that augment the VirtualNode tree
 *
 * Plugins are used to handle special cases where the standard DOM capture
 * doesn't provide sufficient information (e.g., canvas-based content like Google Docs).
 *
 * To create a new plugin:
 * 1. Extend this class
 * 2. Implement `read()` to check activation and augment the tree with content
 * 3. Optionally implement `write()` for editing capabilities
 */
export abstract class DomPlugin {
  /** Plugin name for logging and debugging */
  abstract readonly name: string;

  /**
   * Read content and augment the tree - checks activation and injects content if applicable
   * Called by DomService during snapshot building
   * @param tree The root VirtualNode tree
   * @param context Plugin context with CDP access
   * @returns Result of the read operation
   */
  abstract read(tree: VirtualNode, context: DomPluginContext): Promise<DomPluginResult>;

  /**
   * Helper to find nodes matching a predicate
   * @param tree Root node to search from
   * @param predicate Function to test each node
   * @returns Array of matching nodes
   */
  protected findNodes(tree: VirtualNode, predicate: (node: VirtualNode) => boolean): VirtualNode[] {
    const results: VirtualNode[] = [];
    this.traverseTree(tree, (node) => {
      if (predicate(node)) {
        results.push(node);
      }
    });
    return results;
  }

  /**
   * Helper to traverse the tree and call a callback for each node
   * @param node Current node
   * @param callback Function to call for each node
   */
  protected traverseTree(node: VirtualNode, callback: (node: VirtualNode) => void): void {
    callback(node);
    if (node.children) {
      for (const child of node.children) {
        this.traverseTree(child, callback);
      }
    }
    if (node.shadowRoots) {
      for (const shadowRoot of node.shadowRoots) {
        this.traverseTree(shadowRoot, callback);
      }
    }
    if (node.contentDocument) {
      this.traverseTree(node.contentDocument, callback);
    }
  }

  /**
   * Create a text VirtualNode
   * @param text Text content
   * @param parentBackendNodeId Parent's backendNodeId for generating unique ID
   * @returns VirtualNode representing the text
   */
  protected createTextNode(text: string, parentBackendNodeId: number): VirtualNode {
    return {
      nodeId: -1, // Synthetic node
      backendNodeId: parentBackendNodeId + 0.1, // Synthetic ID derived from parent
      nodeType: 3, // TEXT_NODE
      nodeName: '#text',
      nodeValue: text,
      tier: 'semantic',
    };
  }
}
