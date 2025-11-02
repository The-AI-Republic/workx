/**
 * PageScreenShotTool - CDP-based screenshot capture and coordinate-based interaction
 *
 * Provides visual page analysis and coordinate-based interactions as a complement
 * to DOM-based page operations.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from './BaseTool';
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
 * PageScreenShotTool v1.0
 *
 * CDP-based screenshot and coordinate interaction tool for visual page analysis
 */
export class PageScreenShotTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'page_vision',
    'Visual page screenshot and coordinate-based interaction tool. Captures viewport screenshots and performs coordinate-based actions (click, type, scroll, keypress) for visual analysis. Use as complement to browser_dom when visual understanding is needed. COORDINATES ARE AUTOMATICALLY CLIPPED: Simply provide coordinates based on your visual analysis of the screenshot image. The system will automatically clip out-of-bounds coordinates to the nearest valid position within the viewport.',
    {
      action: {
        type: 'string',
        description: 'Action type: screenshot (capture viewport), click (click at coordinates), type (type text at coordinates), scroll (scroll to coordinates), keypress (press key)',
        enum: ['screenshot', 'click', 'type', 'scroll', 'keypress'],
      },
      tab_id: {
        type: 'number',
        description: 'Target tab ID (optional, defaults to active tab)',
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

    // Get target tab
    const targetTab = typedRequest.tab_id
      ? await this.validateTabId(typedRequest.tab_id)
      : await this.getActiveTab();

    const tabId = targetTab.id!;

    // Route by action type - return raw data, BaseTool.execute() will wrap it
    switch (typedRequest.action) {
      case 'screenshot':
        return await this.executeScreenshot(tabId, typedRequest);
      case 'click':
        return await this.executeClick(tabId, typedRequest);
      case 'type':
        return await this.executeType(tabId, typedRequest);
      case 'scroll':
        return await this.executeScrollAction(tabId, typedRequest);
      case 'keypress':
        return await this.executeKeypress(tabId, typedRequest);
      default:
        throw new Error(`Unknown action: ${typedRequest.action}`);
    }
  }

  /**
   * Execute screenshot action
   */
  private async executeScreenshot(
    tabId: number,
    request: ScreenshotToolRequest
  ): Promise<ScreenshotResponseData> {
    try {
      this.log('debug', 'Executing screenshot', { tabId, scroll_offset: request.scroll_offset });

      // Create screenshot service
      const screenshotService = await ScreenshotService.forTab(tabId);

      // Capture screenshot (with or without scroll)
      const { base64Data, viewport } = request.scroll_offset
        ? await screenshotService.captureWithScroll(request.scroll_offset)
        : await screenshotService.captureViewport();

      // Save screenshot to chrome.storage.local
      await ScreenshotFileManager.saveScreenshot(base64Data);

      this.log('info', 'Screenshot captured and saved', {
        viewport: `${viewport.width}x${viewport.height}`,
        size: `${(base64Data.length * 0.75 / 1024).toFixed(2)}KB`,
      });

      return {
        image_file_id: 'screenshot_cache', // Fixed ID - screenshot stored at chrome.storage.local key
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

    this.log('debug', 'Executing click', { tabId, coordinates: request.coordinates });

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

    this.log('debug', 'Executing type', { tabId, coordinates: request.coordinates, text: request.text });

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

    this.log('debug', 'Executing scroll', { tabId, coordinates: request.coordinates });

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

    this.log('debug', 'Executing keypress', { tabId, key: request.key });

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

    if (wasClipped) {
      this.log('info', 'Coordinates clipped to viewport bounds', {
        requested: { x: coordinates.x, y: coordinates.y },
        clipped: { x: clippedX, y: clippedY },
        viewport: { width: viewport.width, height: viewport.height, maxX, maxY }
      });
    }

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
   * Get active tab
   */
  protected async getActiveTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('TAB_NOT_FOUND: No active tab found');
    }
    return tab;
  }

  /**
   * Validate tab ID exists
   */
  protected async validateTabId(tabId: number): Promise<chrome.tabs.Tab> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab;
    } catch (error: any) {
      throw new Error(`TAB_NOT_FOUND: No tab with id ${tabId}`);
    }
  }

  /**
   * Log helper
   */
  protected log(level: 'debug' | 'info' | 'error', message: string, data?: any): void {
    const prefix = '[PageScreenShotTool]';
    if (level === 'error') {
      console.error(prefix, message, data);
    } else if (level === 'info') {
      console.log(prefix, message, data);
    } else {
      console.debug(prefix, message, data);
    }
  }
}
