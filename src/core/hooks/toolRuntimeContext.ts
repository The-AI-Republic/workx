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
  getWorkingDirectory?(): string | undefined;
  getToolRegistry?(): {
    getCurrentPageContext?(): Promise<{ currentUrl?: string; currentDomain?: string }>;
  } | null;
}

export interface ToolPageContext {
  tabId?: number;
  currentUrl?: string;
  currentDomain?: string;
}

export interface ToolRuntimeContextOptions {
  /** Reuse the page snapshot already resolved for this tool call. */
  pageContext?: ToolPageContext;
  /** False prevents this helper from initiating its own browser read. */
  resolvePageContext?: boolean;
}

function parseDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
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
  options: ToolRuntimeContextOptions = {},
): Promise<ToolRuntimeContext> {
  const context: MutableToolRuntimeContext = {};
  let cwd: string | undefined;
  try {
    cwd = session.getWorkingDirectory?.();
  } catch {
    cwd = undefined;
  }
  if (cwd) context.cwd = cwd;

  let tabId: number | undefined;
  try {
    tabId = options.pageContext?.tabId ?? session.getTabId?.();
  } catch {
    tabId = undefined;
  }
  if (typeof tabId === 'number' && tabId >= 0) {
    context.tab_id = tabId;
  }

  let page = options.pageContext;
  if (!page && options.resolvePageContext !== false && context.tab_id !== undefined) {
    try {
      page = await session.getToolRegistry?.()?.getCurrentPageContext?.();
    } catch {
      // Missing permissions, closed tabs, and headless runtimes all degrade to
      // stored tab/cwd context.
    }
  }
  try {
    if (page?.currentUrl) {
      context.current_url = page.currentUrl;
      context.current_domain = page.currentDomain ?? parseDomain(page.currentUrl);
    }
  } catch {
    // Malformed optional page context must never break tool execution.
  }

  return context;
}
