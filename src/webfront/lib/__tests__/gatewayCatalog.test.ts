import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  catalogUrl: '',
}));

vi.mock('../constants', () => ({
  get GATEWAY_CATALOG_URL() {
    return mocks.catalogUrl;
  },
}));

describe('gatewayCatalog', () => {
  beforeEach(() => {
    mocks.catalogUrl = 'https://hub.example.com/apps';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes the configured catalog URL', async () => {
    mocks.catalogUrl = '  https://hub.example.com/apps  ';
    const { getGatewayCatalogUrl } = await import('../gatewayCatalog');

    expect(getGatewayCatalogUrl()).toBe('https://hub.example.com/apps');
  });

  it('opens the configured catalog URL through the injected opener', async () => {
    const { openGatewayCatalog } = await import('../gatewayCatalog');
    const opener = vi.fn(async () => undefined);

    const result = await openGatewayCatalog(opener);

    expect(result).toEqual({ opened: true, url: 'https://hub.example.com/apps' });
    expect(opener).toHaveBeenCalledWith('https://hub.example.com/apps');
  });

  it('returns unopened when no catalog URL is configured', async () => {
    mocks.catalogUrl = '';
    const { openGatewayCatalog } = await import('../gatewayCatalog');
    const opener = vi.fn(async () => undefined);

    const result = await openGatewayCatalog(opener);

    expect(result).toEqual({ opened: false, url: null });
    expect(opener).not.toHaveBeenCalled();
  });
});
