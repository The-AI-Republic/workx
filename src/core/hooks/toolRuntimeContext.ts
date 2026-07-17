import type { HookInput } from './types';

export type ToolRuntimeContext = Pick<
  HookInput,
  'tab_id' | 'current_url' | 'current_domain' | 'cwd'
>;
type MutableToolRuntimeContext = {
  -readonly [K in keyof ToolRuntimeContext]: ToolRuntimeContext[K];
};

interface RuntimeSessionLike {
  getTabId?(): number;
  getToolRegistry?(): {
    getCurrentPageContext?(): Promise<{ currentUrl?: string; currentDomain?: string }>;
  } | null;
}

function parseDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function getCwd(): string | undefined {
  try {
    if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
      return process.cwd();
    }
  } catch {
    // Optional runtime context must never break tool execution.
  }
  return undefined;
}

/**
 * Best-effort hook context for browser/runtime-aware tool hooks.
 *
 * This helper is deliberately non-throwing. Extension builds can resolve a
 * bound tab URL through chrome.tabs; server/headless builds usually return
 * only cwd, and no-tab sessions return the documented optional shape.
 */
export async function getToolRuntimeContext(
  session: RuntimeSessionLike,
): Promise<ToolRuntimeContext> {
  const context: MutableToolRuntimeContext = {};
  const cwd = getCwd();
  if (cwd) context.cwd = cwd;

  let tabId: number | undefined;
  try {
    tabId = session.getTabId?.();
  } catch {
    tabId = undefined;
  }
  if (typeof tabId === 'number' && tabId >= 0) {
    context.tab_id = tabId;
  } else {
    return context;
  }

  try {
    const page = await session.getToolRegistry?.()?.getCurrentPageContext?.();
    if (page?.currentUrl) {
      context.current_url = page.currentUrl;
      context.current_domain = page.currentDomain ?? parseDomain(page.currentUrl);
    }
  } catch {
    // Missing permissions, closed tabs, and headless runtimes all degrade to
    // tab_id-only context.
  }

  return context;
}
