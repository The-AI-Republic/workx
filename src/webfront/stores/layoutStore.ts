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

const WIDE_BREAKPOINT = '(min-width: 1500px)';

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
  {
    id: 'apps',
    label: 'Apps',
    route: '/apps',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>',
  },
  {
    id: 'usage',
    label: 'Usage',
    route: '/usage',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9" rx="1"></rect><rect x="10" y="7" width="4" height="14" rx="1"></rect><rect x="17" y="3" width="4" height="18" rx="1"></rect></svg>',
  },
];

// ---------------------------------------------------------------------------
// Active route detection
// ---------------------------------------------------------------------------

/**
 * Determines if a navigation route is active given the current location.
 * The root route ('/') is treated as a catch-all: it's active when the
 * location doesn't match any other known nav route.
 */
/** Routes that are valid pages but not shown in NAV_ITEMS (e.g. Settings is in user center). */
const HIDDEN_ROUTES = ['/settings'];

export function isNavActive(route: string, currentLocation: string): boolean {
  if (route === '/') {
    const allRoutes = [
      ...NAV_ITEMS.filter((item) => item.route !== '/').map((item) => item.route),
      ...HIDDEN_ROUTES,
    ];
    return !allRoutes.some((r) => currentLocation.startsWith(r));
  }
  return currentLocation.startsWith(route);
}
