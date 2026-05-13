/**
 * PageVisionTool - CDP-based screenshot capture and coordinate-based interaction
 *
 * Provides visual page analysis and coordinate-based interactions as a complement
 * to DOM-based page operations.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from '../../tools/BaseTool';
import type {
  ScreenshotToolRequest,
  ScreenshotResponseData,
  ActionResponseData,
  ResponseData,
} from './screenshot/types';
import { ScreenshotService } from './screenshot/ScreenshotService';
import { ScreenshotFileManager } from './screenshot/ScreenshotFileManager';
import { CoordinateActionService } from './screenshot/CoordinateActionService';

/**
 * PageVisionTool v1.0
 *
 * CDP-based screenshot and coordinate interaction tool for visual page analysis
 */
export class PageVisionTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'page_vision',
    `Visual page screenshot and coordinate-based interaction tool. COMPLEMENTARY to browser_dom - use only in specific scenarios.

## WHEN TO USE (use ONLY in these scenarios)

1. **Visual Understanding Needed**: DOM structure alone cannot convey visual layout/styling
   - Canvas-based UIs, WebGL content, complex visualizations
   - PDF content analysis
   - Styled elements where appearance matters (buttons, colors, layouts)
   - Image-heavy pages where visual context is crucial

2. **DOM Analysis Failed**: DOM structure is obfuscated, heavily nested, or unclear
   - Shadow DOM with complex nesting
   - Dynamically generated IDs without semantic meaning
   - Iframe content that's difficult to parse

## WHEN NOT TO USE
- ❌ Standard web forms with clear DOM structure (use browser_dom)
- ❌ Text content extraction (use browser_dom)
- ❌ Standard button clicks with accessible node IDs (use browser_dom)
- ❌ First attempt at any page interaction (always try browser_dom first)

## WORKFLOW PATTERN
1. browser_dom.snapshot() → Analyze DOM structure
2. Check inViewport field for target elements
3. If inViewport: false → browser_dom.scroll(node_id) → Bring into view
4. If DOM analysis insufficient → page_vision.screenshot() → Visual analysis
5. Perform action:
   - If DOM node identified → browser_dom.click/type (PREFERRED)
   - If coordinate-based needed → page_vision.click/type(x, y)

## COORDINATE USAGE
Simply provide coordinates based on visual analysis of the screenshot image.
- The system automatically clips out-of-bounds coordinates to valid viewport bounds
- No manual validation needed - just report what you see in the image
- Example: "Search box appears at (850, 95)" → Use page_vision.click(x=850, y=95)

## COST AWARENESS
- Screenshots consume 1000-2000 tokens per image
- Use judiciously - only when DOM-based approach is genuinely insufficient
- Prefer browser_dom for all standard interactions`,
    {
      action: {
        type: 'string',
        description: 'Action type: screenshot (capture viewport), click (click at coordinates), type (type text at coordinates), scroll (scroll to coordinates), keypress (press key)',
        enum: ['screenshot', 'click', 'type', 'scroll', 'keypress'],
      },
      coordinates: {
        type: 'object',
        description: 'Screen coordinates for click, type, or scroll actions (x, y in pixels). Provide coordinates based on your visual analysis of the screenshot image. Out-of-bounds coordinates are automatically clipped to valid viewport bounds - no manual validation needed.',
        properties: {
          x: {
            type: 'number',
            description: 'Horizontal coordinate in pixels from left edge of image',
          },
          y: {
            type: 'number',
            description: 'Vertical coordinate in pixels from top edge of image',
          },
        },
      },
      text: {
        type: 'string',
        description: 'Text to type (required for type action)',
      },
      key: {
        type: 'string',
        description: 'Key to press (required for keypress action). Examples: Enter, Escape, Tab, ArrowDown',
      },
      scroll_offset: {
        type: 'object',
        description: 'Scroll offset before screenshot (optional, for screenshot action)',
        properties: {
          x: {
            type: 'number',
            description: 'Horizontal scroll position in pixels',
          },
          y: {
            type: 'number',
            description: 'Vertical scroll position in pixels',
          },
        },
      },
      options: {
        type: 'object',
        description: 'Action-specific options. For click: { button?: "left"|"right"|"middle", modifiers?: KeyModifiers, wait_after_action?: number }. For type: { wait_after_action?: number }. For scroll: { block?: "start"|"center"|"end"|"nearest", inline?: "start"|"center"|"end"|"nearest" }. For keypress: { modifiers?: KeyModifiers }',
      },
    },
    {
      required: ['action'],
      category: 'visual',
      version: '1.0.0',
      metadata: {
        capabilities: [
          'screenshot_capture',
          'coordinate_click',
          'coordinate_type',
          'coordinate_scroll',
          'coordinate_keypress',
          'viewport_detection',
        ],
        permissions: ['activeTab', 'debugger', 'storage'],
        platforms: ['extension'],
      },
    }
  );

  constructor() {
    super();
  }

  /**
   * Override execute to inject action into metadata
   */
  async execute(request: BaseToolRequest, options?: BaseToolOptions): Promise<any> {
    const typedRequest = request as ScreenshotToolRequest;

    // Inject action into metadata so it's available in the response
    const enrichedOptions = {
      ...options,
      metadata: {
        ...options?.metadata,
        action: typedRequest.action,
      },
    };

    return super.execute(request, enrichedOptions);
  }

  /**
   * Execute screenshot tool action
   *
   * Returns raw data only - BaseTool.execute() will wrap it in the standard response format
   */
  protected async executeImpl(
    request: BaseToolRequest,
    options?: BaseToolOptions
  ): Promise<ResponseData> {

    const typedRequest = request as ScreenshotToolRequest;

    // Validate Chrome context
    this.validateChromeContext();

    // Get tabId from metadata (passed internally, not from LLM)
    const tabId = options?.metadata?.tabId;

    // Check if tabId is valid
    if (tabId === undefined || tabId === null) {
      throw new Error('Target tab ID not provided in execution context');
    }

    if (tabId === -1) {
      throw new Error('Target tab cannot be found. Please ensure a tab is bound to the current session.');
    }


    // Validate tab exists
    try {
      const tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(`Target tab ${tabId} not found or inaccessible`);
    }


    // Route by action type - return raw data, BaseTool.execute() will wrap it
    let result: ResponseData;
    switch (typedRequest.action) {
      case 'screenshot':
        result = await this.executeScreenshot(tabId, typedRequest);
        break;
      case 'click':
        result = await this.executeClick(tabId, typedRequest);
        break;
      case 'type':
        result = await this.executeType(tabId, typedRequest);
        break;
      case 'scroll':
        result = await this.executeScrollAction(tabId, typedRequest);
        break;
      case 'keypress':
        result = await this.executeKeypress(tabId, typedRequest);
        break;
      default:
        throw new Error(`Unknown action: ${typedRequest.action}`);
    }

    return result;
  }

  /**
   * Execute screenshot action
   */
  private async executeScreenshot(
    tabId: number,
    request: ScreenshotToolRequest
  ): Promise<ScreenshotResponseData> {
    try {
      // Create screenshot service
      const screenshotService = await ScreenshotService.forTab(tabId);

      // Capture screenshot (with or without scroll)
      const { base64Data, viewport } = request.scroll_offset
        ? await screenshotService.captureWithScroll(request.scroll_offset)
        : await screenshotService.captureViewport();

      // Save screenshot to ConfigStorageProvider
      await ScreenshotFileManager.saveScreenshot(base64Data);

      return {
        image_file_id: 'screenshot_cache', // Fixed ID - screenshot stored at ConfigStorageProvider key
        width: viewport.width,
        height: viewport.height,
        format: 'png',
        viewport_bounds: viewport,
      };
    } catch (error: any) {
      this.log('error', `Screenshot failed: ${error.message}`, { tabId });
      throw error;
    }
  }

  /**
   * Execute click action at coordinates
   */
  private async executeClick(
    tabId: number,
    request: ScreenshotToolRequest
  ): Promise<ActionResponseData> {
    if (!request.coordinates) {
      throw new Error('VALIDATION_ERROR: coordinates required for click action');
    }

    // Validate coordinates
    await this.validateCoordinates(tabId, request.coordinates);

    // Create coordinate action service
    const actionService = await CoordinateActionService.forTab(tabId);

    // Execute click
    await actionService.clickAt(request.coordinates, {
      button: request.options?.button,
      modifiers: request.options?.modifiers,
      waitAfter: request.options?.wait_after_action || 100,
    });

    return {
      coordinates_used: request.coordinates,
      action_timestamp: new Date().toISOString(),
    };
  }

  /**
   * Execute type action at coordinates
   */
  private async executeType(
    tabId: number,
    request: ScreenshotToolRequest
  ): Promise<ActionResponseData> {
    if (!request.coordinates) {
      throw new Error('VALIDATION_ERROR: coordinates required for type action');
    }
    if (!request.text) {
      throw new Error('VALIDATION_ERROR: text required for type action');
    }

    // Validate coordinates
    await this.validateCoordinates(tabId, request.coordinates);

    // Create coordinate action service
    const actionService = await CoordinateActionService.forTab(tabId);

    // Execute type
    await actionService.typeAt(request.coordinates, request.text, {
      waitAfter: request.options?.wait_after_action || 100,
    });

    return {
      coordinates_used: request.coordinates,
      action_timestamp: new Date().toISOString(),
    };
  }

  /**
   * Execute scroll action to coordinates
   */
  private async executeScrollAction(
    tabId: number,
    request: ScreenshotToolRequest
  ): Promise<ActionResponseData> {
    if (!request.coordinates) {
      throw new Error('VALIDATION_ERROR: coordinates required for scroll action');
    }

    // Create coordinate action service
    const actionService = await CoordinateActionService.forTab(tabId);

    // Execute scroll
    await actionService.scrollTo(request.coordinates, {
      waitAfter: request.options?.wait_after_action || 200,
    });

    return {
      coordinates_used: request.coordinates,
      action_timestamp: new Date().toISOString(),
    };
  }

  /**
   * Execute keypress action
   */
  private async executeKeypress(
    tabId: number,
    request: ScreenshotToolRequest
  ): Promise<ActionResponseData> {
    if (!request.key) {
      throw new Error('VALIDATION_ERROR: key required for keypress action');
    }

    // Create coordinate action service
    const actionService = await CoordinateActionService.forTab(tabId);

    // Execute keypress
    await actionService.keypressAt(request.key, {
      modifiers: request.options?.modifiers,
      waitAfter: request.options?.wait_after_action || 100,
    });

    return {
      action_timestamp: new Date().toISOString(),
    };
  }

  /**
   * Validate coordinates are within viewport bounds
   */
  /**
   * Validate and clip coordinates to viewport bounds
   *
   * This method automatically adjusts out-of-bounds coordinates to the nearest valid coordinate.
   * LLM provides coordinates based on image analysis, and we clip them to actual viewport bounds.
   *
   * @param tabId - Target tab ID
   * @param coordinates - Requested coordinates (may be out of bounds)
   * @returns Clipped coordinates guaranteed to be within viewport bounds
   */
  private async validateCoordinates(
    tabId: number,
    coordinates: { x: number; y: number }
  ): Promise<{ x: number; y: number; clipped: boolean }> {
    // Get viewport bounds via CDP
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight })',
      returnByValue: true
    }) as { result?: { value: { width: number; height: number } } };

    if (!result?.result?.value) {
      throw new Error('INVALID_COORDINATES: Failed to get viewport bounds');
    }

    const viewport = result.result.value;

    // Calculate valid bounds (0 to width-1, 0 to height-1)
    const maxX = viewport.width - 1;
    const maxY = viewport.height - 1;

    // Clip coordinates to valid range
    const clippedX = Math.max(0, Math.min(coordinates.x, maxX));
    const clippedY = Math.max(0, Math.min(coordinates.y, maxY));

    const wasClipped = clippedX !== coordinates.x || clippedY !== coordinates.y;

    // Update the coordinates object in-place (will be used by caller)
    coordinates.x = clippedX;
    coordinates.y = clippedY;

    return { x: clippedX, y: clippedY, clipped: wasClipped };
  }



  /**
   * Validate Chrome context
   */
  protected validateChromeContext(): void {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      throw new Error('VALIDATION_ERROR: Chrome extension context required');
    }
  }

  /**
   * Log helper
   */
  protected log(level: 'debug' | 'info' | 'error', message: string, data?: any): void {
    const prefix = '[PageVisionTool]';
    if (level === 'error') {
      console.error(prefix, message, data);
    } else if (level === 'info') {
      console.log(prefix, message, data);
    } else {
      console.debug(prefix, message, data);
    }
  }
}
