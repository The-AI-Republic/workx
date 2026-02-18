import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDocPlugin, googleDocPlugin } from '../GoogleDocPlugin';
import type { DomPluginContext, DomPluginResult } from '../DomPlugin';
import type { VirtualNode } from '../../types';

/** Helper: minimal VirtualNode */
function makeNode(overrides: Partial<VirtualNode> = {}): VirtualNode {
  return {
    nodeId: 1,
    backendNodeId: 100,
    nodeType: 1,
    nodeName: 'DIV',
    tier: 'semantic',
    ...overrides,
  };
}

/** Helper: build a body node wrapping children */
function makeBody(children: VirtualNode[] = []): VirtualNode {
  return makeNode({ nodeName: 'BODY', localName: 'body', children });
}

/** Helper: build a canvas node */
function makeCanvas(overrides: Partial<VirtualNode> = {}): VirtualNode {
  return makeNode({
    nodeId: 10,
    backendNodeId: 200,
    nodeName: 'CANVAS',
    localName: 'canvas',
    ...overrides,
  });
}

/** Helper: build a full tree with body > canvas structure */
function makeTreeWithCanvas(canvasNodes: VirtualNode[]): VirtualNode {
  const body = makeBody(canvasNodes);
  return makeNode({ nodeName: 'HTML', children: [body] });
}

/** Helper: standard Google Doc URL */
const GOOGLE_DOC_URL = 'https://docs.google.com/document/d/1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ/edit';
const GOOGLE_DOC_URL_WITH_USER = 'https://docs.google.com/document/u/0/d/1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ/edit';

/** Helper: create a mock DomPluginContext */
function createMockContext(
  url: string = GOOGLE_DOC_URL,
  sendCommandImpl?: (method: string, params: any) => Promise<any>
): DomPluginContext {
  return {
    tabId: 1,
    url,
    title: 'Test Document - Google Docs',
    sendCommand: vi.fn(sendCommandImpl ?? (async () => ({}))),
  };
}

/**
 * Helper: create sendCommand mock that simulates successful doc content fetch.
 * The stream reading supports a single chunk (eof: true after first read).
 */
function createSuccessfulFetchMock(content: string, base64?: boolean) {
  const data = base64 ? btoa(content) : content;
  return async (method: string, _params: any) => {
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'main-frame-id' } } };
      case 'Network.loadNetworkResource':
        return {
          resource: {
            success: true,
            stream: 'stream-handle-123',
          },
        };
      case 'IO.read':
        return {
          data,
          base64Encoded: !!base64,
          eof: true,
        };
      case 'IO.close':
        return {};
      default:
        return {};
    }
  };
}

/**
 * Helper: create sendCommand mock for multi-chunk stream reading.
 */
function createMultiChunkFetchMock(chunks: string[]) {
  let chunkIndex = 0;
  return async (method: string, _params: any) => {
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'frame-1' } } };
      case 'Network.loadNetworkResource':
        return {
          resource: {
            success: true,
            stream: 'stream-multi',
          },
        };
      case 'IO.read': {
        const i = chunkIndex++;
        if (i < chunks.length) {
          return {
            data: chunks[i],
            base64Encoded: false,
            eof: i === chunks.length - 1,
          };
        }
        return { data: '', eof: true };
      }
      case 'IO.close':
        return {};
      default:
        return {};
    }
  };
}

describe('GoogleDocPlugin', () => {
  let plugin: GoogleDocPlugin;

  beforeEach(() => {
    plugin = new GoogleDocPlugin();
  });

  // -------------------------------------------------------------------------
  // Plugin identity
  // -------------------------------------------------------------------------
  describe('plugin identity', () => {
    it('should have name "GoogleDocPlugin"', () => {
      expect(plugin.name).toBe('GoogleDocPlugin');
    });

    it('should export a singleton instance', () => {
      expect(googleDocPlugin).toBeInstanceOf(GoogleDocPlugin);
    });
  });

  // -------------------------------------------------------------------------
  // URL pattern matching (non-Google-Doc URLs)
  // -------------------------------------------------------------------------
  describe('URL pattern matching - non-Google-Doc URLs', () => {
    const nonDocUrls = [
      'https://www.google.com',
      'https://example.com/document/d/123/edit',
      'https://docs.google.com/spreadsheets/d/abc/edit',
      'https://docs.google.com/presentation/d/abc/edit',
      'https://docs.google.com/forms/d/abc/edit',
      'http://docs.google.com/document/d/abc/edit', // http instead of https
      'https://docs.google.com/document/', // no doc ID
      '',
    ];

    for (const url of nonDocUrls) {
      it(`should return executed=false for: ${url || '(empty)'}`, async () => {
        const ctx = createMockContext(url);
        const tree = makeNode();
        const result = await plugin.read(tree, ctx);
        expect(result.executed).toBe(false);
        expect(result.success).toBe(false);
        expect(result.nodesAugmented).toBe(0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // URL pattern matching (valid Google Doc URLs)
  // -------------------------------------------------------------------------
  describe('URL pattern matching - valid Google Doc URLs', () => {
    it('should match standard Google Doc URL', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('Hello'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.executed).toBe(true);
    });

    it('should match Google Doc URL with user index', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL_WITH_USER, createSuccessfulFetchMock('Hello'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.executed).toBe(true);
    });

    it('should match URL with /edit suffix', async () => {
      const url = 'https://docs.google.com/document/d/abcDEF123/edit';
      const ctx = createMockContext(url, createSuccessfulFetchMock('content'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.executed).toBe(true);
    });

    it('should match URL with /preview suffix', async () => {
      const url = 'https://docs.google.com/document/d/abcDEF123/preview';
      const ctx = createMockContext(url, createSuccessfulFetchMock('content'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.executed).toBe(true);
    });

    it('should match URL with u/1 user index', async () => {
      const url = 'https://docs.google.com/document/u/1/d/abcDEF123/edit';
      const ctx = createMockContext(url, createSuccessfulFetchMock('content'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.executed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // fetchDocContent via CDP
  // -------------------------------------------------------------------------
  describe('fetchDocContent (CDP interactions)', () => {
    it('should call Page.getFrameTree to get frame ID', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('Doc text'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      await plugin.read(tree, ctx);
      expect(ctx.sendCommand).toHaveBeenCalledWith('Page.getFrameTree', {});
    });

    it('should call Network.loadNetworkResource with correct export URL', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('text'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      await plugin.read(tree, ctx);

      expect(ctx.sendCommand).toHaveBeenCalledWith(
        'Network.loadNetworkResource',
        expect.objectContaining({
          frameId: 'main-frame-id',
          url: expect.stringContaining('/export?format=txt'),
          options: expect.objectContaining({
            includeCredentials: true,
          }),
        })
      );
    });

    it('should read stream content via IO.read', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('content'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      await plugin.read(tree, ctx);

      expect(ctx.sendCommand).toHaveBeenCalledWith('IO.read', {
        handle: 'stream-handle-123',
        size: 1024 * 1024,
      });
    });

    it('should close the stream after reading', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('content'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      await plugin.read(tree, ctx);

      expect(ctx.sendCommand).toHaveBeenCalledWith('IO.close', {
        handle: 'stream-handle-123',
      });
    });

    it('should handle base64-encoded stream data', async () => {
      const originalText = 'Hello from Google Docs!';
      const ctx = createMockContext(
        GOOGLE_DOC_URL,
        createSuccessfulFetchMock(originalText, true)
      );
      const canvas = makeCanvas();
      const tree = makeTreeWithCanvas([canvas]);
      const result = await plugin.read(tree, ctx);

      expect(result.success).toBe(true);
      expect(result.metadata?.contentLength).toBe(originalText.length);
    });

    it('should handle non-base64 stream data', async () => {
      const text = 'Plain text content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(text));
      const canvas = makeCanvas();
      const tree = makeTreeWithCanvas([canvas]);
      const result = await plugin.read(tree, ctx);

      expect(result.success).toBe(true);
      expect(result.metadata?.contentLength).toBe(text.length);
    });

    it('should read multiple chunks until eof', async () => {
      const chunks = ['chunk1', 'chunk2', 'chunk3'];
      const ctx = createMockContext(GOOGLE_DOC_URL, createMultiChunkFetchMock(chunks));
      const canvas = makeCanvas();
      const tree = makeTreeWithCanvas([canvas]);
      const result = await plugin.read(tree, ctx);

      expect(result.success).toBe(true);
      expect(result.metadata?.contentLength).toBe('chunk1chunk2chunk3'.length);
    });

    it('should handle IO.read with empty data but not eof yet', async () => {
      let readCount = 0;
      const ctx = createMockContext(GOOGLE_DOC_URL, async (method: string) => {
        switch (method) {
          case 'Page.getFrameTree':
            return { frameTree: { frame: { id: 'f1' } } };
          case 'Network.loadNetworkResource':
            return { resource: { success: true, stream: 's1' } };
          case 'IO.read': {
            readCount++;
            if (readCount === 1) {
              return { data: '', base64Encoded: false, eof: false };
            }
            return { data: 'final data', base64Encoded: false, eof: true };
          }
          case 'IO.close':
            return {};
          default:
            return {};
        }
      });
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
      expect(result.metadata?.contentLength).toBe('final data'.length);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('should return error when Network.loadNetworkResource fails', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, async (method: string) => {
        switch (method) {
          case 'Page.getFrameTree':
            return { frameTree: { frame: { id: 'f1' } } };
          case 'Network.loadNetworkResource':
            return {
              resource: {
                success: false,
                httpStatusCode: 403,
                netError: -301,
                netErrorName: 'ERR_SSL_CLIENT_AUTH_CERT_NEEDED',
              },
            };
          default:
            return {};
        }
      });
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 403');
    });

    it('should return error when no stream handle is returned', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, async (method: string) => {
        switch (method) {
          case 'Page.getFrameTree':
            return { frameTree: { frame: { id: 'f1' } } };
          case 'Network.loadNetworkResource':
            return {
              resource: { success: true, stream: undefined },
            };
          default:
            return {};
        }
      });
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No stream handle');
    });

    it('should return error when sendCommand throws', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, async () => {
        throw new Error('CDP connection lost');
      });
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('CDP connection lost');
    });

    it('should return "Unknown error" when error has no message', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, async () => {
        throw {};
      });
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should include HTTP status and net error in error message', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, async (method: string) => {
        switch (method) {
          case 'Page.getFrameTree':
            return { frameTree: { frame: { id: 'f1' } } };
          case 'Network.loadNetworkResource':
            return {
              resource: {
                success: false,
                httpStatusCode: 404,
                netError: -200,
                netErrorName: 'ERR_NOT_FOUND',
              },
            };
          default:
            return {};
        }
      });
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.error).toContain('404');
      expect(result.error).toContain('-200');
      expect(result.error).toContain('ERR_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // Empty content handling
  // -------------------------------------------------------------------------
  describe('empty document content', () => {
    it('should return success with 0 nodesAugmented for empty content', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(''));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.nodesAugmented).toBe(0);
      expect(result.metadata?.reason).toBe('Empty document');
    });

    it('should return success with 0 nodesAugmented for whitespace-only content', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('   \n\t  '));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.nodesAugmented).toBe(0);
      expect(result.metadata?.contentLength).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Canvas injection
  // -------------------------------------------------------------------------
  describe('canvas injection', () => {
    it('should inject content as child of canvas node', async () => {
      const content = 'Document content here';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const canvas = makeCanvas();
      const tree = makeTreeWithCanvas([canvas]);

      const result = await plugin.read(tree, ctx);

      expect(result.executed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.nodesAugmented).toBe(1);
      expect(result.metadata?.injectionTarget).toBe('canvas');
      expect(canvas.children).toHaveLength(1);
      expect(canvas.children![0].nodeValue).toBe(content);
      expect(canvas.children![0].nodeType).toBe(3); // TEXT_NODE
    });

    it('should report canvas count in metadata', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('text'));
      const canvas1 = makeCanvas({ backendNodeId: 200 });
      const canvas2 = makeCanvas({ backendNodeId: 201 });
      const tree = makeTreeWithCanvas([canvas1, canvas2]);

      const result = await plugin.read(tree, ctx);
      expect(result.metadata?.canvasCount).toBe(2);
    });

    it('should prefer canvas with kix-canvas-tile-content class', async () => {
      const content = 'Kix content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const regularCanvas = makeCanvas({ backendNodeId: 200 });
      const kixCanvas = makeCanvas({
        backendNodeId: 201,
        attributes: ['class', 'kix-canvas-tile-content'],
      });
      const tree = makeTreeWithCanvas([regularCanvas, kixCanvas]);

      await plugin.read(tree, ctx);

      // kixCanvas should get the content
      expect(kixCanvas.children).toHaveLength(1);
      expect(kixCanvas.children![0].nodeValue).toBe(content);
      // regularCanvas should not
      expect(regularCanvas.children).toBeUndefined();
    });

    it('should prefer largest canvas when no kix class found', async () => {
      const content = 'Largest canvas content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const smallCanvas = makeCanvas({
        backendNodeId: 200,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });
      const largeCanvas = makeCanvas({
        backendNodeId: 201,
        boundingBox: { x: 0, y: 0, width: 800, height: 600 },
      });
      const tree = makeTreeWithCanvas([smallCanvas, largeCanvas]);

      await plugin.read(tree, ctx);

      expect(largeCanvas.children).toHaveLength(1);
      expect(largeCanvas.children![0].nodeValue).toBe(content);
      expect(smallCanvas.children).toBeUndefined();
    });

    it('should fall back to first canvas when no bounding boxes', async () => {
      const content = 'First canvas fallback';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const canvas1 = makeCanvas({ backendNodeId: 200 });
      const canvas2 = makeCanvas({ backendNodeId: 201 });
      const tree = makeTreeWithCanvas([canvas1, canvas2]);

      await plugin.read(tree, ctx);

      expect(canvas1.children).toHaveLength(1);
      expect(canvas1.children![0].nodeValue).toBe(content);
    });

    it('should add accessibility metadata to injected text node', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('text'));
      const canvas = makeCanvas();
      const tree = makeTreeWithCanvas([canvas]);
      await plugin.read(tree, ctx);

      const textNode = canvas.children![0];
      expect(textNode.accessibility).toBeDefined();
      expect(textNode.accessibility!.role).toBe('document');
      expect(textNode.accessibility!.name).toBe('Google Doc Content');
    });
  });

  // -------------------------------------------------------------------------
  // Editor container injection (no canvas)
  // -------------------------------------------------------------------------
  describe('editor container injection (no canvas)', () => {
    it('should inject into kix-page container when no canvas', async () => {
      const content = 'Editor content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const kixPage = makeNode({
        nodeId: 5,
        backendNodeId: 105,
        attributes: ['class', 'kix-page'],
      });
      const body = makeBody([kixPage]);
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
      expect(result.nodesAugmented).toBe(1);
      expect(result.metadata?.injectionTarget).toBe('editor-container');
      expect(kixPage.children).toHaveLength(1);
      expect(kixPage.children![0].nodeValue).toBe(content);
    });

    it('should inject into contenteditable=true container', async () => {
      const content = 'Editable content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const editable = makeNode({
        nodeId: 5,
        backendNodeId: 105,
        attributes: ['contenteditable', 'true'],
      });
      const body = makeBody([editable]);
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
      expect(result.metadata?.injectionTarget).toBe('editor-container');
    });

    it('should inject into role=textbox container', async () => {
      const content = 'Textbox content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const textbox = makeNode({
        nodeId: 5,
        backendNodeId: 105,
        attributes: ['role', 'textbox'],
      });
      const body = makeBody([textbox]);
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
      expect(result.metadata?.injectionTarget).toBe('editor-container');
    });

    it('should inject into docs-texteventtarget container', async () => {
      const content = 'Event target content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const target = makeNode({
        nodeId: 5,
        backendNodeId: 105,
        attributes: ['class', 'docs-texteventtarget-iframe'],
      });
      const body = makeBody([target]);
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
      expect(result.metadata?.injectionTarget).toBe('editor-container');
    });
  });

  // -------------------------------------------------------------------------
  // Body fallback injection
  // -------------------------------------------------------------------------
  describe('body fallback injection', () => {
    it('should inject into body when no canvas or editor container found', async () => {
      const content = 'Fallback body content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const span = makeNode({ nodeId: 5, backendNodeId: 105, nodeName: 'SPAN' });
      const body = makeBody([span]);
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
      expect(result.nodesAugmented).toBe(1);
      expect(result.metadata?.injectionTarget).toBe('body');
    });

    it('should wrap body injection in a div with google-doc-content class', async () => {
      const content = 'Wrapped content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const body = makeBody();
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      await plugin.read(tree, ctx);

      // Should have a wrapper div child
      expect(body.children).toHaveLength(1);
      const wrapper = body.children![0];
      expect(wrapper.nodeName).toBe('DIV');
      expect(wrapper.attributes).toContain('google-doc-content');
      expect(wrapper.attributes).toContain('data-pi-injected');
      expect(wrapper.attributes).toContain('true');
      // The wrapper should contain the text node
      expect(wrapper.children).toHaveLength(1);
      expect(wrapper.children![0].nodeValue).toBe(content);
    });
  });

  // -------------------------------------------------------------------------
  // No injection target
  // -------------------------------------------------------------------------
  describe('no injection target', () => {
    it('should return error when no canvas, editor, or body found', async () => {
      const content = 'Orphan content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      // Tree with no body, canvas, or editor containers
      const tree = makeNode({ nodeName: 'HTML', children: [] });

      const result = await plugin.read(tree, ctx);
      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.nodesAugmented).toBe(0);
      expect(result.error).toContain('No suitable injection target found');
    });
  });

  // -------------------------------------------------------------------------
  // injectContentAsChild - with and without wrapper
  // -------------------------------------------------------------------------
  describe('injectContentAsChild', () => {
    it('should create children array if parent has none (no wrapper)', async () => {
      const content = 'Content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const canvas = makeCanvas();
      delete canvas.children;
      const tree = makeTreeWithCanvas([canvas]);

      await plugin.read(tree, ctx);
      expect(canvas.children).toBeDefined();
      expect(canvas.children).toHaveLength(1);
    });

    it('should append to existing children (no wrapper)', async () => {
      const content = 'Content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const existingChild = makeNode({ nodeId: 50, backendNodeId: 500, nodeName: 'SPAN' });
      const canvas = makeCanvas({ children: [existingChild] });
      const tree = makeTreeWithCanvas([canvas]);

      await plugin.read(tree, ctx);
      expect(canvas.children).toHaveLength(2);
      expect(canvas.children![0]).toBe(existingChild);
      expect(canvas.children![1].nodeValue).toBe(content);
    });

    it('should create children array if parent has none (with wrapper)', async () => {
      const content = 'Wrapped';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const body = makeBody();
      delete body.children;
      // No canvas, no editor -> body fallback with wrapper
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      await plugin.read(tree, ctx);
      expect(body.children).toBeDefined();
      expect(body.children).toHaveLength(1);
      expect(body.children![0].nodeName).toBe('DIV');
    });

    it('wrapper div should have correct nodeType and attributes', async () => {
      const content = 'Check wrapper';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const body = makeBody();
      const tree = makeNode({ nodeName: 'HTML', children: [body] });

      await plugin.read(tree, ctx);
      const wrapper = body.children![0];
      expect(wrapper.nodeType).toBe(1); // ELEMENT_NODE
      expect(wrapper.localName).toBe('div');
      expect(wrapper.tier).toBe('semantic');
    });
  });

  // -------------------------------------------------------------------------
  // docId extraction
  // -------------------------------------------------------------------------
  describe('extractDocId', () => {
    it('should include docId in metadata', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('text'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.metadata?.docId).toBe('1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ');
    });

    it('should extract docId from URL with user index', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL_WITH_USER, createSuccessfulFetchMock('text'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      const result = await plugin.read(tree, ctx);
      expect(result.metadata?.docId).toBe('1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ');
    });

    it('should use docId to construct export URL', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('text'));
      const tree = makeTreeWithCanvas([makeCanvas()]);
      await plugin.read(tree, ctx);

      const loadCall = (ctx.sendCommand as any).mock.calls.find(
        (c: any[]) => c[0] === 'Network.loadNetworkResource'
      );
      expect(loadCall[1].url).toBe(
        'https://docs.google.com/document/d/1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ/export?format=txt'
      );
    });
  });

  // -------------------------------------------------------------------------
  // findMainCanvas logic
  // -------------------------------------------------------------------------
  describe('findMainCanvas', () => {
    it('should prefer kix-canvas-tile-content over larger canvas', async () => {
      const content = 'Kix wins';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const largeCanvas = makeCanvas({
        backendNodeId: 200,
        boundingBox: { x: 0, y: 0, width: 2000, height: 2000 },
      });
      const kixCanvas = makeCanvas({
        backendNodeId: 201,
        attributes: ['class', 'kix-canvas-tile-content'],
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });
      const tree = makeTreeWithCanvas([largeCanvas, kixCanvas]);

      await plugin.read(tree, ctx);
      expect(kixCanvas.children).toHaveLength(1);
      expect(kixCanvas.children![0].nodeValue).toBe(content);
      expect(largeCanvas.children).toBeUndefined();
    });

    it('should use largest canvas by area when no kix class', async () => {
      const content = 'Area-based selection';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const small = makeCanvas({
        backendNodeId: 200,
        boundingBox: { x: 0, y: 0, width: 50, height: 50 },
      });
      const medium = makeCanvas({
        backendNodeId: 201,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });
      const large = makeCanvas({
        backendNodeId: 202,
        boundingBox: { x: 0, y: 0, width: 800, height: 1000 },
      });
      const tree = makeTreeWithCanvas([small, large, medium]);

      await plugin.read(tree, ctx);
      expect(large.children).toHaveLength(1);
      expect(large.children![0].nodeValue).toBe(content);
    });

    it('should handle canvas with zero-area bounding box', async () => {
      const content = 'Zero area';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const zeroCanvas = makeCanvas({
        backendNodeId: 200,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      });
      const normalCanvas = makeCanvas({
        backendNodeId: 201,
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });
      const tree = makeTreeWithCanvas([zeroCanvas, normalCanvas]);

      await plugin.read(tree, ctx);
      expect(normalCanvas.children).toHaveLength(1);
    });

    it('should handle mix of canvas with and without bounding boxes', async () => {
      const content = 'Mixed';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const noBbox = makeCanvas({ backendNodeId: 200 });
      const withBbox = makeCanvas({
        backendNodeId: 201,
        boundingBox: { x: 0, y: 0, width: 500, height: 300 },
      });
      const tree = makeTreeWithCanvas([noBbox, withBbox]);

      await plugin.read(tree, ctx);
      expect(withBbox.children).toHaveLength(1);
      expect(withBbox.children![0].nodeValue).toBe(content);
    });
  });

  // -------------------------------------------------------------------------
  // getAttributeMap
  // -------------------------------------------------------------------------
  describe('getAttributeMap (via findMainCanvas / editor detection)', () => {
    it('should handle node with undefined attributes', async () => {
      const content = 'No attrs canvas';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const canvas = makeCanvas({ attributes: undefined });
      const tree = makeTreeWithCanvas([canvas]);

      const result = await plugin.read(tree, ctx);
      // Should still work - falls back to first canvas
      expect(result.success).toBe(true);
      expect(canvas.children).toHaveLength(1);
    });

    it('should handle node with empty attributes array', async () => {
      const content = 'Empty attrs';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const canvas = makeCanvas({ attributes: [] });
      const tree = makeTreeWithCanvas([canvas]);

      const result = await plugin.read(tree, ctx);
      expect(result.success).toBe(true);
    });

    it('should correctly parse multiple attribute key-value pairs', async () => {
      const content = 'Multi attrs';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const canvas = makeCanvas({
        attributes: ['id', 'my-canvas', 'class', 'kix-canvas-tile-content main-canvas', 'width', '800'],
      });
      const tree = makeTreeWithCanvas([canvas]);
      await plugin.read(tree, ctx);

      // kix-canvas-tile-content should be detected
      expect(canvas.children).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Integration-style tests
  // -------------------------------------------------------------------------
  describe('full read flow integration', () => {
    it('should correctly report docId and contentLength in metadata', async () => {
      const content = 'Full integration test document content';
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock(content));
      const tree = makeTreeWithCanvas([makeCanvas()]);

      const result = await plugin.read(tree, ctx);
      expect(result.metadata).toEqual(
        expect.objectContaining({
          docId: '1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ',
          contentLength: content.length,
          canvasCount: 1,
          injectionTarget: 'canvas',
        })
      );
    });

    it('should handle complete flow with multiple CDP calls', async () => {
      const ctx = createMockContext(GOOGLE_DOC_URL, createSuccessfulFetchMock('doc text'));
      const tree = makeTreeWithCanvas([makeCanvas()]);

      const result = await plugin.read(tree, ctx);

      // Verify all 4 CDP calls were made in order
      const calls = (ctx.sendCommand as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls).toEqual([
        'Page.getFrameTree',
        'Network.loadNetworkResource',
        'IO.read',
        'IO.close',
      ]);
      expect(result.success).toBe(true);
    });
  });
});
