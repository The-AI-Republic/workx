/**
 * ViewportTool (browser_viewport) — set/reset a deterministic viewport.
 *
 * Lets the agent pin a viewport size (for responsive/breakpoint testing) with
 * `deviceScaleFactor: 1`. While an override is active the tab is kept attached
 * (a registry handle is held) because detaching the debugger clears emulation;
 * `reset` clears the override and releases the handle.
 *
 * @module extension/tools/ViewportTool
 */

import {
  BaseTool,
  createToolDefinition,
  type BaseToolRequest,
  type BaseToolOptions,
  type ToolDefinition,
} from '../../tools/BaseTool';
import { getDebuggerSessionRegistry } from './browser/ChromeDebuggerSessionRegistry';
import { ViewportOverrideService } from './browser/ViewportOverrideService';
import type { DebuggerHandle } from '@/core/tools/browser/DebuggerSessionRegistry';

interface ViewportToolRequest extends BaseToolRequest {
  action: 'set' | 'reset';
  width?: number;
  height?: number;
}

/** Handles held per tab while an override is active (module-scoped state). */
const activeOverrides = new Map<number, DebuggerHandle>();

export class ViewportTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'browser_viewport',
    `Set or reset a deterministic browser viewport (with deviceScaleFactor: 1) for responsive/breakpoint testing.

## ACTIONS
- **set**: Apply a viewport of {width}x{height} CSS pixels. If width/height are omitted, pins the tab's current size (useful before screenshots so image pixels == CSS pixels). Example: set 375x667 for a mobile layout.
- **reset**: Clear the override and restore the browser's normal viewport.

## IMPORTANT
- Always **reset** the override before finishing your task — a left-over override resizes the page the user sees.`,
    {
      action: {
        type: 'string',
        description: 'set (apply a viewport override) or reset (clear it)',
        enum: ['set', 'reset'],
      },
      width: { type: 'number', description: 'Viewport width in CSS pixels (for set)' },
      height: { type: 'number', description: 'Viewport height in CSS pixels (for set)' },
    },
    {
      required: ['action'],
      category: 'browser',
      version: '1.0.0',
      metadata: {
        capabilities: ['viewport_override'],
        permissions: ['activeTab', 'debugger'],
        platforms: ['extension'],
      },
    }
  );

  constructor() {
    super();
  }

  protected async executeImpl(request: BaseToolRequest, options?: BaseToolOptions): Promise<unknown> {
    const typedRequest = request as ViewportToolRequest;
    this.validateChromeContext();

    const tabId = options?.metadata?.tabId;
    if (tabId === undefined || tabId === null || tabId === -1) {
      throw new Error('Target tab cannot be found. Please ensure a tab is bound to the current session.');
    }

    if (typedRequest.action === 'reset') {
      return await this.reset(tabId);
    }
    return await this.set(tabId, typedRequest);
  }

  private async set(tabId: number, request: ViewportToolRequest): Promise<unknown> {
    // Reuse a held handle for this tab, or acquire one and keep it so the
    // override survives subsequent tool calls until reset.
    const handle = activeOverrides.get(tabId) ?? (await getDebuggerSessionRegistry().acquire(tabId));
    try {
      const service = new ViewportOverrideService((method, params) => handle.sendCommand(method, params));
      const applied = await service.setOverride({ width: request.width, height: request.height });
      activeOverrides.set(tabId, handle);
      return { action: 'set', applied };
    } catch (error) {
      // On failure, don't leak the handle if we just acquired it.
      if (!activeOverrides.has(tabId)) {
        await handle.release();
      }
      throw error;
    }
  }

  private async reset(tabId: number): Promise<unknown> {
    const handle = activeOverrides.get(tabId);
    if (!handle) {
      return { action: 'reset', wasActive: false };
    }
    activeOverrides.delete(tabId);
    const service = new ViewportOverrideService((method, params) => handle.sendCommand(method, params));
    await service.clearOverride();
    await handle.release();
    return { action: 'reset', wasActive: true };
  }
}

/** Test-only: drop held override handles. */
export function __resetViewportOverridesForTests(): void {
  activeOverrides.clear();
}
