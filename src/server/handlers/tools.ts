/**
 * Tools Method Handler
 *
 * Handles tools.catalog — lists available tools.
 *
 * @module server/handlers/tools
 */

import { registerMethodHandler, type MethodContext } from '@workx/ws-server';

export interface ToolsHandlerDeps {
  getToolCatalog: () => Promise<unknown[]>;
}

let _deps: ToolsHandlerDeps | null = null;

export function registerToolsHandlers(deps: ToolsHandlerDeps): void {
  _deps = deps;
  registerMethodHandler('tools.catalog', handleToolsCatalog);
}

async function handleToolsCatalog(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  if (!_deps) throw new Error('Tools handlers not initialized');

  const tools = await _deps.getToolCatalog();
  return { tools };
}
