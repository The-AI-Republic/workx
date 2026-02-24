/**
 * Layout Store for responsive layout state and navigation items.
 *
 * Provides a readable store for wide-mode detection via matchMedia,
 * and exports the shared navigation item definitions.
 */

import { readable, type Readable } from 'svelte/store';

// ---------------------------------------------------------------------------
// Wide-mode media query store
// ---------------------------------------------------------------------------

const WIDE_BREAKPOINT = '(min-width: 769px)';

/**
 * Readable store that tracks whether the viewport is in "wide" mode
 * (>= 769 px). Falls back to `false` when running outside a browser
 * (SSR / tests).
 */
export const isWideMode: Readable<boolean> = readable(false, (set) => {
  if (typeof window === 'undefined') {
    return;
  }

  const mql = window.matchMedia(WIDE_BREAKPOINT);
  set(mql.matches);

  const onChange = (e: MediaQueryListEvent) => set(e.matches);
  mql.addEventListener('change', onChange);

  return () => {
    mql.removeEventListener('change', onChange);
  };
});

// ---------------------------------------------------------------------------
// Navigation items
// ---------------------------------------------------------------------------

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  route: string;
}

/**
 * Canonical list of top-level navigation destinations.
 * Icons are inline SVG strings (24x24 viewBox, stroke-based, currentColor)
 * matching the style used in FooterBar.svelte.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'chat',
    label: 'Chat',
    route: '/',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>',
  },
  {
    id: 'settings',
    label: 'Settings',
    route: '/settings',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>',
  },
  {
    id: 'scheduler',
    label: 'Scheduler',
    route: '/scheduler',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>',
  },
];
