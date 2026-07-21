import { describe, expect, it } from 'vitest';
import { FOLDED_NAV_ITEMS, NAV_ITEMS, isNavActive } from '../layoutStore';

describe('layout navigation placement', () => {
  it('keeps folded destinations out of the primary navigation', () => {
    expect(NAV_ITEMS.some((item) => item.id === 'usage')).toBe(false);
    expect(NAV_ITEMS.some((item) => item.id === 'settings')).toBe(false);
    expect(FOLDED_NAV_ITEMS.map((item) => item.id)).toEqual(['usage', 'settings']);
  });

  it('defines every navigation destination exactly once', () => {
    const ids = [...NAV_ITEMS, ...FOLDED_NAV_ITEMS].map((item) => item.id);
    const routes = [...NAV_ITEMS, ...FOLDED_NAV_ITEMS].map((item) => item.route);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it.each(['/usage', '/settings'])('does not treat %s as the root route', (route) => {
    expect(isNavActive('/', route)).toBe(false);
    expect(isNavActive(route, route)).toBe(true);
  });
});
