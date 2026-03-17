import { DomPlugin, type DomPluginContext, type DomPluginResult } from './DomPlugin';
import type { VirtualNode } from '../types';

/**
 * Google Doc URL patterns
 * Matches:
 * - https://docs.google.com/document/d/{docId}/...
 * - https://docs.google.com/document/u/{userIndex}/d/{docId}/...
 */
const GOOGLE_DOC_PATTERN = /^https:\/\/docs\.google\.com\/document\/(u\/\d+\/)?d\/([a-zA-Z0-9-_]+)/;

/**
 * Plugin to fetch and inject Google Doc content into the DOM tree
 *
 * Google Docs renders content in canvas elements, making the actual text
 * inaccessible to standard DOM capture. This plugin:
 * 1. Detects when the page is a Google Doc
 * 2. Fetches the document content via the /export endpoint
 * 3. Injects the text as children of canvas elements
 */
export class GoogleDocPlugin extends DomPlugin {
  readonly name = 'GoogleDocPlugin';

  /**
   * Read Google Doc content and inject it into the DOM tree
   */
  async read(tree: VirtualNode, context: DomPluginContext): Promise<DomPluginResult> {
    // Check if this is a Google Doc
    if (!GOOGLE_DOC_PATTERN.test(context.url)) {
      return {
        executed: false,
        success: false,
        nodesAugmented: 0
      };
    }

    const docId = this.extractDocId(context.url);
    if (!docId) {
      return {
        executed: true,
        success: false,
        nodesAugmented: 0,
        error: 'Could not extract document ID from URL'
      };
    }

    try {
      const docContent = await this.fetchDocContent(docId, context);

      if (!docContent || docContent.trim().length === 0) {
        return {
          executed: true,
          success: true,
          nodesAugmented: 0,
          metadata: { docId, contentLength: 0, reason: 'Empty document' }
        };
      }

      // Find canvas elements in the tree
      const canvasNodes = this.findNodes(tree, (node) =>
        node.nodeName?.toLowerCase() === 'canvas'
      );

      if (canvasNodes.length === 0) {
        // No canvas found - might be in editing mode with contenteditable
        // Look for the main document editor container
        const editorContainers = this.findNodes(tree, (node) => {
          const attributes = this.getAttributeMap(node.attributes);
          return (
            attributes.get('class')?.includes('kix-page') ||
            attributes.get('class')?.includes('docs-texteventtarget') ||
            attributes.get('role') === 'textbox' ||
            attributes.get('contenteditable') === 'true'
          );
        });

        if (editorContainers.length > 0) {
          const container = editorContainers[0];
          this.injectContentAsChild(container, docContent);
          return {
            executed: true,
            success: true,
            nodesAugmented: 1,
            metadata: {
              docId,
              contentLength: docContent.length,
              injectionTarget: 'editor-container'
            }
          };
        }

        // Fallback: inject at body level
        const bodyNodes = this.findNodes(tree, (node) =>
          node.nodeName?.toLowerCase() === 'body'
        );

        if (bodyNodes.length > 0) {
          this.injectContentAsChild(bodyNodes[0], docContent, 'google-doc-content');
          return {
            executed: true,
            success: true,
            nodesAugmented: 1,
            metadata: {
              docId,
              contentLength: docContent.length,
              injectionTarget: 'body'
            }
          };
        }

        return {
          executed: true,
          success: false,
          nodesAugmented: 0,
          error: 'No suitable injection target found'
        };
      }

      // Inject content as text child of the main canvas
      const mainCanvas = this.findMainCanvas(canvasNodes);
      this.injectContentAsChild(mainCanvas, docContent);

      return {
        executed: true,
        success: true,
        nodesAugmented: 1,
        metadata: {
          docId,
          contentLength: docContent.length,
          canvasCount: canvasNodes.length,
          injectionTarget: 'canvas'
        }
      };

    } catch (error: any) {
      return {
        executed: true,
        success: false,
        nodesAugmented: 0,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Extract document ID from Google Doc URL
   */
  private extractDocId(url: string): string | null {
    const match = url.match(GOOGLE_DOC_PATTERN);
    return match ? match[2] : null;
  }

  /**
   * Fetch Google Doc content as plain text using user's session cookies
   * Uses CDP Network.loadNetworkResource to bypass CORS restrictions
   */
  private async fetchDocContent(docId: string, context: DomPluginContext): Promise<string> {
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

    // Get the main frame ID - required for Network.loadNetworkResource
    const frameTreeResult = await context.sendCommand<any>('Page.getFrameTree', {});
    const frameId = frameTreeResult.frameTree.frame.id;

    // Use Network.loadNetworkResource to fetch with the page's cookies
    // This bypasses CORS as it's a debugger-level request
    const resourceResult = await context.sendCommand<any>('Network.loadNetworkResource', {
      frameId: frameId,
      url: exportUrl,
      options: {
        disableCache: false,
        includeCredentials: true
      }
    });

    if (resourceResult.resource.success) {
      // The content is in a stream, we need to read it
      const streamHandle = resourceResult.resource.stream;

      if (streamHandle) {
        // Read the stream content
        let content = '';
        let eof = false;

        while (!eof) {
          const readResult = await context.sendCommand<any>('IO.read', {
            handle: streamHandle,
            size: 1024 * 1024 // Read up to 1MB at a time
          });

          if (readResult.data) {
            // Data might be base64 encoded
            if (readResult.base64Encoded) {
              content += atob(readResult.data);
            } else {
              content += readResult.data;
            }
          }

          eof = readResult.eof;
        }

        // Close the stream
        await context.sendCommand<any>('IO.close', { handle: streamHandle });

        return content;
      } else {
        throw new Error('No stream handle returned from Network.loadNetworkResource');
      }
    } else {
      const httpStatus = resourceResult.resource.httpStatusCode;
      const netError = resourceResult.resource.netError;
      const netErrorName = resourceResult.resource.netErrorName;

      throw new Error(`Failed to load resource: HTTP ${httpStatus}, netError: ${netError} (${netErrorName})`);
    }
  }

  /**
   * Find the main editor canvas from multiple canvas elements
   */
  private findMainCanvas(canvasNodes: VirtualNode[]): VirtualNode {
    // Prefer canvas with 'kix-canvas-tile-content' class
    for (const canvas of canvasNodes) {
      const attributes = this.getAttributeMap(canvas.attributes);
      const className = attributes.get('class') || '';
      if (className.includes('kix-canvas-tile-content')) {
        return canvas;
      }
    }

    // Prefer canvas with largest dimensions
    let mainCanvas = canvasNodes[0];
    let maxArea = 0;

    for (const canvas of canvasNodes) {
      if (canvas.boundingBox) {
        const area = canvas.boundingBox.width * canvas.boundingBox.height;
        if (area > maxArea) {
          maxArea = area;
          mainCanvas = canvas;
        }
      }
    }

    return mainCanvas;
  }

  /**
   * Inject content as a text child node
   */
  private injectContentAsChild(
    parent: VirtualNode,
    content: string,
    wrapperClass?: string
  ): void {
    // Create a synthetic text node with the document content
    const textNode = this.createTextNode(content, parent.backendNodeId);

    // Add metadata to indicate this is injected content
    textNode.accessibility = {
      role: 'document',
      name: 'Google Doc Content',
      description: 'Document text content fetched from Google Docs export API'
    };

    // If wrapper class specified, wrap in a div
    if (wrapperClass) {
      const wrapperNode: VirtualNode = {
        nodeId: -1,
        backendNodeId: parent.backendNodeId + 0.2, // Synthetic ID
        nodeType: 1, // ELEMENT_NODE
        nodeName: 'DIV',
        localName: 'div',
        attributes: ['class', wrapperClass, 'data-applepi-injected', 'true'],
        tier: 'semantic',
        children: [textNode]
      };

      if (!parent.children) {
        parent.children = [];
      }
      parent.children.push(wrapperNode);
    } else {
      if (!parent.children) {
        parent.children = [];
      }
      parent.children.push(textNode);
    }
  }

  /**
   * Convert attributes array to Map for easier access
   */
  private getAttributeMap(attributes?: string[]): Map<string, string> {
    const map = new Map<string, string>();
    if (!attributes) return map;

    for (let i = 0; i < attributes.length; i += 2) {
      map.set(attributes[i], attributes[i + 1]);
    }
    return map;
  }
}

// Export a singleton instance
export const googleDocPlugin = new GoogleDocPlugin();
