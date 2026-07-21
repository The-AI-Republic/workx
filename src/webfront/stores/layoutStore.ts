/**
 * Layout Store for responsive layout state and navigation items.
 *
 * Provides a readable store for wide-mode detection via matchMedia,
 * and exports the shared navigation item definitions.
 */

import { readable, type Readable } from 'svelte/store';
import { GATEWAY_CATALOG_API_BASE_URL } from '../lib/constants';

// ---------------------------------------------------------------------------
// Wide-mode media query store
// ---------------------------------------------------------------------------

const WIDE_BREAKPOINT = '(min-width: 1500px)';

/**
 * Readable store that tracks whether the viewport is in "wide" mode
 * (>= 769 px). Falls back to `false` when running outside a browser
 * (SSR / tests). `window.matchMedia` is absent under jsdom, so guard for
 * it too — otherwise subscribing throws in the test environment.
 */
export const isWideMode: Readable<boolean> = readable(false, (set) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
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
 * Primary navigation destinations rendered inline in the left panel.
 * Icons are inline SVG strings (24x24 viewBox, stroke-based, currentColor)
 * matching the style used in NavTab.svelte.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'chat',
    label: 'Chat',
    route: '/',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>',
  },
  {
    id: 'scheduler',
    label: 'Scheduler',
    route: '/scheduler',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>',
  },
  {
    id: 'skills',
    label: 'Skills',
    route: '/skills',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path><line x1="9" y1="7" x2="17" y2="7"></line><line x1="9" y1="11" x2="15" y2="11"></line></svg>',
  },
  // The Apps catalog is only reachable when a Hub catalog API base is wired up;
  // otherwise the page is a dead-end, so omit the nav entry entirely.
  ...(GATEWAY_CATALOG_API_BASE_URL.trim().length > 0
    ? [
        {
          id: 'apps',
          label: 'Apps',
          route: '/apps',
          icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>',
        },
      ]
    : []),
];

/**
 * Secondary destinations shared by the OSS "More" menu and the hosted-auth
 * user center. Keeping the collection independent from {@link NAV_ITEMS}
 * guarantees each destination has exactly one navigation placement per build.
 */
export const FOLDED_NAV_ITEMS: NavItem[] = [
  {
    id: 'usage',
    label: 'Usage',
    route: '/usage',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9" rx="1"></rect><rect x="10" y="7" width="4" height="14" rx="1"></rect><rect x="17" y="3" width="4" height="18" rx="1"></rect></svg>',
  },
  {
    id: 'settings',
    label: 'Settings',
    route: '/settings',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>',
  },
];

const NAV_ROUTES = [...NAV_ITEMS, ...FOLDED_NAV_ITEMS]
  .filter((item) => item.route !== '/')
  .map((item) => item.route);

// ---------------------------------------------------------------------------
// Active route detection
// ---------------------------------------------------------------------------

/**
 * Determines if a navigation route is active given the current location.
 * The root route ('/') is treated as a catch-all: it's active when the
 * location doesn't match any other known nav route.
 */
export function isNavActive(route: string, currentLocation: string): boolean {
  if (route === '/') {
    return !NAV_ROUTES.some((knownRoute) => currentLocation.startsWith(knownRoute));
  }
  return currentLocation.startsWith(route);
}
