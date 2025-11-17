/**
 * Session Tab Binding Type Definitions
 *
 * Types and interfaces for managing tab-to-session bindings in BrowserX
 */

/**
 * Tab Binding State
 * Represents the association between a session and a browser tab
 */
export interface TabBindingState {
  tabId: number;              // Browser tab ID
  sessionId: string;          // Bound session ID
  boundAt: number;            // Timestamp when binding established
  tabTitle: string;           // Last known tab title (for UI display)
  tabUrl: string;             // Last known tab URL
}

/**
 * Reasons a tab can become invalid
 */
export enum TabInvalidReason {
  CLOSED = 'closed',
  CRASHED = 'crashed',
  UNRESPONSIVE = 'unresponsive',
  PERMISSION_DENIED = 'permission_denied',
  NOT_FOUND = 'not_found',
}

/**
 * Tab Validation State
 * Runtime state indicating validity of a tab
 */
export type TabValidationState =
  | { status: 'valid'; tab: chrome.tabs.Tab }
  | { status: 'invalid'; reason: TabInvalidReason }
  | { status: 'checking' };

/**
 * Tab Information
 * Extended information about a browser tab
 */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  muted?: boolean;
  windowId: number;
  status: 'loading' | 'complete';
  index: number;
  favicon?: string;
  incognito?: boolean;
}
