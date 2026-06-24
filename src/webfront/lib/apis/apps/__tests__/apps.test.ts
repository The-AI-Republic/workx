import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Cookie surface returns no token by default so tests exercise the public path.
const getAccessToken = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../../../utils/cookie', () => ({ getAccessToken }));
// Avoid pulling the web auth service (and its env) into these unit tests.
vi.mock('../../../../auth/WebAuthService', () => ({
  getWebAuthService: () => ({ hasValidToken: async () => false, getAccessToken: async () => null }),
}));

const CATALOG_API = 'https://hub.example.com/api/v1/apps';

async function loadModule() {
  process.env.VITE_GATEWAY_CATALOG_API_URL = CATALOG_API;
  vi.resetModules();
  return import('../index');
}

describe('apps marketplace api', () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VITE_GATEWAY_CATALOG_API_URL;
  });

  it('fetches and normalizes the marketplace, building the catalog URL with query', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        items: [
          { appId: 'a1', slug: 'gmail', name: 'Gmail', description: 'Email', categories: ['productivity'], installStatus: 'installed', isActivated: true, version: '1.2.0' },
          { id: 'a2', slug: 'slack' }, // sparse row → defaults fill in
        ],
        nextCursor: 'c2',
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fetchMarketplace, isAppsCatalogConfigured } = await loadModule();
    expect(isAppsCatalogConfigured()).toBe(true);

    const page = await fetchMarketplace({ query: 'mail' });

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe(`${CATALOG_API}/marketplace?q=mail`);
    expect(page.nextCursor).toBe('c2');
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ appId: 'a1', name: 'Gmail', installStatus: 'installed', isActivated: true });
    // Sparse row falls back to slug/appId and sane defaults.
    expect(page.items[1]).toMatchObject({ appId: 'a2', name: 'slack', installStatus: 'uninstalled', enabled: false });
  });

  it('attaches a bearer token when one is available', async () => {
    getAccessToken.mockResolvedValue('tok-123');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ items: [] }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fetchMarketplace } = await loadModule();
    await fetchMarketplace();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('throws AppsApiError with status on a failed response', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) })) as unknown as typeof fetch;
    const { fetchMarketplace, AppsApiError } = await loadModule();
    await expect(fetchMarketplace()).rejects.toBeInstanceOf(AppsApiError);
  });

  it('refuses to mutate without a token', async () => {
    getAccessToken.mockResolvedValue(null);
    global.fetch = vi.fn() as unknown as typeof fetch;
    const { installApp, AppsApiError } = await loadModule();
    await expect(installApp('a1')).rejects.toBeInstanceOf(AppsApiError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses an explicit accessToken override (desktop) without probing cookies', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ appId: 'a1', installStatus: 'installed' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { installApp } = await loadModule();
    const card = await installApp('a1', 'desktop-tok');

    expect(getAccessToken).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer desktop-tok');
    expect(card).toMatchObject({ appId: 'a1', installStatus: 'installed' });
  });

  it('drops catalog rows that have no usable id', async () => {
    global.fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ items: [{ appId: 'keep' }, { slug: 'no-id' }, {}] }),
    })) as unknown as typeof fetch;

    const { fetchMarketplace } = await loadModule();
    const page = await fetchMarketplace();
    expect(page.items.map((a) => a.appId)).toEqual(['keep']);
  });

  it('coerces non-string fields to null instead of leaking [object Object]', async () => {
    global.fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ items: [{ appId: 'a1', name: '', description: { en: 'x' }, iconUrl: { url: 'y' } }] }),
    })) as unknown as typeof fetch;

    const { fetchMarketplace } = await loadModule();
    const [app] = (await fetchMarketplace()).items;
    expect(app.description).toBeNull();
    expect(app.iconUrl).toBeNull();
    // Empty-string name falls back rather than rendering a blank card.
    expect(app.name).toBe('a1');
  });

  it('caches the browser token across calls within the TTL', async () => {
    getAccessToken.mockResolvedValue('tok-1');
    global.fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ items: [] }),
    })) as unknown as typeof fetch;

    const { fetchMarketplace } = await loadModule();
    await fetchMarketplace({ query: 'a' });
    await fetchMarketplace({ query: 'ab' });
    await fetchMarketplace({ query: 'abc' });
    // Token probe is memoized: one resolution despite three requests.
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });
});
