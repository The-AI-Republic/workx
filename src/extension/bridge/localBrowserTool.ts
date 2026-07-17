/**
 * local_browser_tool — the single browser tool the bridge advertises.
 *
 * The desktop model sees ONE tool with an `action` enum instead of the ~10
 * underlying extension tools. Rationale (bridge design discussion):
 *   - small/free-tier desktop models pick tools far more reliably from a
 *     short tool list, and the old catalog had genuinely overlapping entries
 *     (snapshot vs web_scraping vs data_extraction);
 *   - availability becomes one honest bit: the tool is present exactly while
 *     the WorkX extension is connected;
 *   - the schema stays FLAT (action enum + superset of optional params, like
 *     `browser_tabs` already did) because `oneOf` discriminated unions are
 *     unevenly supported across the LLM providers WorkX targets. Per-action
 *     argument validation therefore happens at runtime, and every validation
 *     error must TEACH the fix (say which param is missing and which action
 *     obtains it), because with a flat schema the error message is the only
 *     schema enforcement the model gets.
 *
 * This module is a pure mapping layer: facade action -> executor-internal
 * tabs handler or an underlying registry tool invocation. It deliberately
 * exposes a curated subset (network_intercept, browser_viewport, web_scraping,
 * form_automation, storage_tool stay unadvertised in v1 — `extract`, `click`
 * and `type` cover the common paths; they can return as actions later without
 * any desktop/platform change).
 *
 * @module extension/bridge/localBrowserTool
 */

import type { NodeToolDescriptor } from '@workx/ws-server';

export const LOCAL_BROWSER_TOOL = 'local_browser_tool';

export const LOCAL_BROWSER_ACTIONS = [
  'list_tabs',
  'select_tab',
  'open_tab',
  'close_tab',
  'navigate',
  'back',
  'reload',
  'snapshot',
  'click',
  'type',
  'press_key',
  'scroll',
  'extract',
] as const;

export type LocalBrowserAction = (typeof LOCAL_BROWSER_ACTIONS)[number];

/** Facade call resolved to the executor's tabs handler. */
export interface TabsInvocation {
  target: 'tabs';
  params: Record<string, unknown>;
}

/** Facade call resolved to an underlying registry tool. */
export interface RegistryInvocation {
  target: 'registry';
  toolName: string;
  params: Record<string, unknown>;
  /** `navigate` may run without a selected tab: the executor opens one first. */
  autoOpenTab?: boolean;
}

export interface InvocationError {
  target: 'error';
  code: string;
  message: string;
}

export type LocalBrowserInvocation = TabsInvocation | RegistryInvocation | InvocationError;

function invalid(message: string): InvocationError {
  return { target: 'error', code: 'INVALID_ARGUMENTS', message };
}

/** The one descriptor the bridge advertises to the desktop. */
export function localBrowserToolDescriptor(): NodeToolDescriptor {
  return {
    name: LOCAL_BROWSER_TOOL,
    description:
      "Operate the user's real Chrome browser (via the WorkX extension). " +
      'Work tab-first: `list_tabs` to see open tabs, `select_tab`/`open_tab` to bind one; ' +
      '`navigate` auto-opens a tab when none is selected. ' +
      'Then loop observe→act: `snapshot` returns the visible DOM with element node_ids; ' +
      'perform ONE action (`click`, `type`, `press_key`, `scroll`) and snapshot again before the next — ' +
      'never chain multiple actions from a single snapshot. ' +
      '`type` focuses the target itself (no click-to-focus first). ' +
      'Use `extract` to pull structured data (tables, listings, fields) from the current page. ' +
      'This tool exists only while the WorkX Chrome extension is connected.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...LOCAL_BROWSER_ACTIONS],
          description:
            'list_tabs | select_tab (tab_id) | open_tab (url?) | close_tab | ' +
            'navigate (url) | back | reload | ' +
            'snapshot | click (node_id) | type (node_id, text) | press_key (key) | scroll (node_id) | ' +
            'extract (mode?, context?)',
        },
        tab_id: { type: 'number', description: "Tab to bind (for 'select_tab'; get ids from 'list_tabs')" },
        url: { type: 'string', description: "URL (for 'navigate' and 'open_tab')" },
        node_id: {
          type: 'string',
          description:
            "Element node id from 'snapshot' (for 'click', 'type', 'scroll'), " +
            'format "frameId:backendNodeId" e.g. "0:123"',
        },
        text: { type: 'string', description: "Text to type (for 'type'; may be empty to clear)" },
        key: { type: 'string', description: "Key to press (for 'press_key'), e.g. Enter, Escape, Tab, ArrowDown" },
        mode: {
          type: 'string',
          enum: ['semantic', 'structured', 'pattern', 'table', 'auto'],
          description: "Extraction mode (for 'extract'; default auto)",
        },
        context: { type: 'string', description: "What to extract, in plain language (for 'extract')" },
        options: {
          type: 'object',
          description:
            'Action-specific extras. click: {button?, scrollIntoView?}. ' +
            'type: {clearFirst?, replace?, insertAfter?, method? ("paste" recommended for >300 chars), commit? ("enter" submits)}. ' +
            'scroll: {scrollY? (+down/-up px), scrollX?}. press_key: {modifiers?}. ' +
            'navigate: {waitForLoad?, timeout?}. snapshot: {includeValues?}. ' +
            'extract: {patterns?, selectors?, schema?, format?, tableSelector?}.',
        },
      },
      required: ['action'],
    },
  };
}

const VALID_ACTIONS_HINT = `Valid actions: ${LOCAL_BROWSER_ACTIONS.join(', ')}.`;

/**
 * Resolve one facade call. Returns a tabs/registry invocation or a teaching
 * error; never throws.
 */
export function mapLocalBrowserAction(parameters: Record<string, unknown>): LocalBrowserInvocation {
  const action = parameters.action;
  if (typeof action !== 'string' || action.length === 0) {
    return invalid(`'action' is required. ${VALID_ACTIONS_HINT}`);
  }

  const { tab_id, url, node_id, text, key, mode, context, options } = parameters as {
    tab_id?: unknown;
    url?: unknown;
    node_id?: unknown;
    text?: unknown;
    key?: unknown;
    mode?: unknown;
    context?: unknown;
    options?: unknown;
  };

  switch (action as LocalBrowserAction) {
    // ── tabs ────────────────────────────────────────────────────────────
    case 'list_tabs':
      return { target: 'tabs', params: { action: 'list' } };
    case 'select_tab':
      if (!Number.isInteger(Number(tab_id))) {
        return invalid("action 'select_tab' requires a numeric 'tab_id' — call 'list_tabs' first to get tab ids.");
      }
      return { target: 'tabs', params: { action: 'select', tab_id } };
    case 'open_tab':
      return { target: 'tabs', params: { action: 'open', url } };
    case 'close_tab':
      return { target: 'tabs', params: { action: 'close' } };

    // ── navigation ──────────────────────────────────────────────────────
    case 'navigate':
      if (typeof url !== 'string' || url.length === 0) {
        return invalid("action 'navigate' requires a 'url'.");
      }
      return {
        target: 'registry',
        toolName: 'browser_navigation',
        params: { action: 'navigate', url, options },
        autoOpenTab: true,
      };
    case 'back':
      return { target: 'registry', toolName: 'browser_navigation', params: { action: 'goBack', options } };
    case 'reload':
      return { target: 'registry', toolName: 'browser_navigation', params: { action: 'reload', options } };

    // ── observe / act (DOM) ─────────────────────────────────────────────
    case 'snapshot':
      return { target: 'registry', toolName: 'browser_dom', params: { action: 'snapshot', options } };
    case 'click':
      if (typeof node_id !== 'string' || node_id.length === 0) {
        return invalid("action 'click' requires a 'node_id' — take a 'snapshot' first to get element node_ids.");
      }
      return { target: 'registry', toolName: 'browser_dom', params: { action: 'click', node_id, options } };
    case 'type':
      if (typeof node_id !== 'string' || node_id.length === 0) {
        return invalid("action 'type' requires a 'node_id' — take a 'snapshot' first to get element node_ids.");
      }
      if (typeof text !== 'string') {
        return invalid("action 'type' requires 'text' (a string; may be empty \"\" to clear the field).");
      }
      return { target: 'registry', toolName: 'browser_dom', params: { action: 'type', node_id, text, options } };
    case 'press_key':
      if (typeof key !== 'string' || key.length === 0) {
        return invalid("action 'press_key' requires a 'key' (e.g. Enter, Escape, Tab, ArrowDown).");
      }
      return { target: 'registry', toolName: 'browser_dom', params: { action: 'keypress', key, node_id, options } };
    case 'scroll':
      if (typeof node_id !== 'string' || node_id.length === 0) {
        return invalid(
          "action 'scroll' requires a 'node_id' — take a 'snapshot' and target the element marked scrollable " +
            '(the <html> node scrolls the page).',
        );
      }
      return { target: 'registry', toolName: 'browser_dom', params: { action: 'scroll', node_id, options } };

    // ── extraction ──────────────────────────────────────────────────────
    case 'extract': {
      const extra = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
      return {
        target: 'registry',
        toolName: 'data_extraction',
        params: { mode: mode ?? 'auto', context, ...extra },
      };
    }

    default:
      return {
        target: 'error',
        code: 'UNKNOWN_ACTION',
        message: `Unknown action '${action}'. ${VALID_ACTIONS_HINT}`,
      };
  }
}
