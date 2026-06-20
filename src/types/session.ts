/**
 * Session Tab Type Definitions
 *
 * Types and interfaces for managing tabs in WorkX
 */

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
