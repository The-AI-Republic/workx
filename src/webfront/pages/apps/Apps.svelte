<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import { platform } from '../../stores/platformStore';
  import { getInitializedUIClient } from '@/core/messaging';
  import {
    fetchMarketplace,
    installApp,
    activateApp,
    getAuthStatus,
    startOAuth,
    submitApiKey,
    needsAuth,
    isAppsCatalogConfigured,
    AppsApiError,
    type MarketplaceApp,
    type ManualSetupField,
  } from '../../lib/apis/apps';
  import { openExternalUrl } from '../../lib/gatewayCatalog';

  let currentTheme = $derived($uiTheme);
  let modern = $derived(currentTheme === 'modern');

  let apps = $state<MarketplaceApp[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let query = $state('');
  /** appId currently being installed/activated, for per-card button state. */
  let pendingId = $state<string | null>(null);

  const configured = isAppsCatalogConfigured();

  let searchController: AbortController | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // On desktop the WebView has no cookies — the runtime owns credentials — so
  // the token comes from the `auth.getAccessToken` runtime service. Cache it
  // briefly so a marketplace request per search keystroke doesn't round-trip.
  const DESKTOP_TOKEN_TTL_MS = 30_000;
  let desktopTokenCache: { value: string | null; at: number } | null = null;

  async function resolveAccessToken(): Promise<string | null> {
    if (platform.platformName !== 'desktop') return null;
    const now = Date.now();
    if (desktopTokenCache && now - desktopTokenCache.at < DESKTOP_TOKEN_TTL_MS) {
      return desktopTokenCache.value;
    }
    let value: string | null = null;
    try {
      const client = await getInitializedUIClient();
      const res = await client.serviceRequest<{ accessToken: string | null }>('auth.getAccessToken');
      value = res?.accessToken ?? null;
    } catch {
      value = null;
    }
    desktopTokenCache = { value, at: now };
    return value;
  }

  async function load(q = '') {
    if (!configured) {
      loading = false;
      error = null;
      return;
    }
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    loading = true;
    error = null;
    try {
      const accessToken = await resolveAccessToken();
      const page = await fetchMarketplace({ query: q, signal: controller.signal, accessToken });
      if (controller.signal.aborted) return;
      apps = page.items;
    } catch (err) {
      if (controller.signal.aborted) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!controller.signal.aborted) loading = false;
    }
  }

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => load(query), 250);
  }

  /**
   * Run an install/activate mutation, then apply the updated card in place
   * (the Hub echoes the new card) rather than refetching the whole catalog.
   * Falls back to a refetch only when the Hub returns no card.
   */
  async function runAction(
    app: MarketplaceApp,
    action: (appId: string, accessToken?: string | null) => Promise<MarketplaceApp | null>,
  ) {
    pendingId = app.appId;
    error = null;
    try {
      const accessToken = await resolveAccessToken();
      const updated = await action(app.appId, accessToken);
      if (updated) {
        apps = apps.map((a) => (a.appId === app.appId ? updated : a));
      } else {
        await load(query);
      }
    } catch (err) {
      error = err instanceof AppsApiError ? err.message : String(err);
    } finally {
      pendingId = null;
    }
  }

  const handleInstall = (app: MarketplaceApp) => runAction(app, installApp);
  const handleActivate = (app: MarketplaceApp) => runAction(app, activateApp);

  function isInstalled(app: MarketplaceApp): boolean {
    return app.installStatus === 'installed';
  }

  /** True when an installed app still needs the user to connect a credential. */
  function appNeedsConnect(app: MarketplaceApp): boolean {
    return isInstalled(app) && needsAuth(app.auth);
  }

  // ─── Connect-auth flow ────────────────────────────────────────────────────
  /** appId currently mid OAuth (browser open + polling). */
  let oauthPendingId = $state<string | null>(null);
  /** appId whose manual-credential form is open. */
  let apiKeyFormId = $state<string | null>(null);
  let apiKeyFields = $state<ManualSetupField[]>([]);
  let apiKeyValues = $state<Record<string, string>>({});
  let apiKeyError = $state<string | null>(null);
  let apiKeySubmitting = $state(false);
  let pollController: { cancelled: boolean } | null = null;

  /** Patch one app's auth block in place (after a connect succeeds). */
  function applyAuth(appId: string, auth: MarketplaceApp['auth']) {
    apps = apps.map((a) => (a.appId === appId ? { ...a, auth } : a));
  }

  async function handleConnect(app: MarketplaceApp) {
    const type = app.auth?.type ?? 'oauth2';
    if (type === 'api_key' || type === 'basic') {
      apiKeyError = null;
      apiKeyFields = app.auth?.manualFields ?? [];
      apiKeyValues = Object.fromEntries(apiKeyFields.map((f) => [f.key, '']));
      apiKeyFormId = app.appId;
      return;
    }
    await connectOAuth(app);
  }

  async function connectOAuth(app: MarketplaceApp) {
    error = null;
    oauthPendingId = app.appId;
    pollController = { cancelled: false };
    const controller = pollController;
    try {
      const accessToken = await resolveAccessToken();
      const { authorizationUrl } = await startOAuth(app.appId, { accessToken });
      await openExternalUrl(authorizationUrl);
      // The provider redirects to the Hub callback (not back into the app), so
      // poll the Hub for the new connection until it lands or we time out.
      const connected = await pollAuthUntilConnected(app.appId, controller);
      if (controller.cancelled) return;
      if (connected) {
        await load(query); // refresh suggestedAction / isActivated
      } else {
        error = `Couldn't confirm the ${app.name} connection. Finish in your browser, then Retry.`;
      }
    } catch (err) {
      if (!controller.cancelled) error = err instanceof Error ? err.message : String(err);
    } finally {
      if (oauthPendingId === app.appId) oauthPendingId = null;
    }
  }

  /** Poll auth status (~every 2.5s, ~90s budget) until connected. */
  async function pollAuthUntilConnected(
    appId: string,
    controller: { cancelled: boolean },
  ): Promise<boolean> {
    const accessToken = await resolveAccessToken();
    const deadline = Date.now() + 90_000;
    while (!controller.cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      if (controller.cancelled) return false;
      try {
        const status = await getAuthStatus(appId, accessToken);
        if (status) applyAuth(appId, status);
        if (status && status.status === 'connected') return true;
      } catch {
        // transient — keep polling within the budget
      }
    }
    return false;
  }

  function cancelOAuth() {
    if (pollController) pollController.cancelled = true;
    oauthPendingId = null;
  }

  function closeApiKeyForm() {
    apiKeyFormId = null;
    apiKeyError = null;
    apiKeyValues = {};
  }

  async function submitApiKeyForm(app: MarketplaceApp) {
    apiKeyError = null;
    const missing = apiKeyFields.filter((f) => !f.optional && !(apiKeyValues[f.key] ?? '').trim());
    if (missing.length) {
      apiKeyError = `Enter ${missing.map((f) => f.label).join(', ')}.`;
      return;
    }
    apiKeySubmitting = true;
    try {
      const accessToken = await resolveAccessToken();
      const fields = Object.fromEntries(
        Object.entries(apiKeyValues).filter(([, v]) => (v ?? '').trim()),
      );
      const auth = await submitApiKey(app.appId, fields, { accessToken });
      if (auth) applyAuth(app.appId, auth);
      closeApiKeyForm();
      await load(query);
    } catch (err) {
      apiKeyError = err instanceof AppsApiError ? err.message : String(err);
    } finally {
      apiKeySubmitting = false;
    }
  }

  $effect(() => {
    load();
    return () => {
      searchController?.abort();
      if (searchTimer) clearTimeout(searchTimer);
      if (pollController) pollController.cancelled = true;
    };
  });
</script>

<div class="h-full overflow-y-auto {currentTheme}
  {modern ? 'bg-chat-bg dark:bg-chat-bg-dark' : 'bg-term-bg'}">

  <!-- Page Header -->
  <div class="px-4 py-3 flex items-center gap-2
    {modern
      ? 'border-b border-chat-border dark:border-chat-border-dark'
      : 'border-b border-term-dim-green'}">
    <svg class="w-5 h-5 {modern ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}"
      viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="7" height="7" rx="1"></rect>
      <rect x="14" y="3" width="7" height="7" rx="1"></rect>
      <rect x="3" y="14" width="7" height="7" rx="1"></rect>
      <rect x="14" y="14" width="7" height="7" rx="1"></rect>
    </svg>
    <h1 class="m-0 text-base font-semibold
      {modern ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-green font-terminal'}">
      {$_t('Apps')}
    </h1>
  </div>

  <!-- Search -->
  {#if configured}
    <div class="px-4 py-3">
      <input
        type="search"
        bind:value={query}
        oninput={onSearchInput}
        placeholder={$_t('Search apps…')}
        class="w-full px-3 py-2 text-sm rounded outline-none
          {modern
            ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark font-chat placeholder:text-chat-text-muted dark:placeholder:text-chat-text-muted-dark'
            : 'bg-transparent border border-term-dim-green text-term-green font-terminal placeholder:text-term-dim-green'}"
      />
    </div>
  {/if}

  <div class="px-4 pb-6">
    {#if !configured}
      <p class="text-sm {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
        {$_t('The app catalog is not configured for this build.')}
      </p>
    {:else if loading}
      <p class="text-sm {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
        {$_t('Loading apps…')}
      </p>
    {:else if error}
      <div class="text-sm rounded p-3
        {modern ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'border border-term-dim-green text-term-green'}">
        {error}
        <button
          class="ml-2 underline cursor-pointer"
          onclick={() => load(query)}
        >{$_t('Retry')}</button>
      </div>
    {:else if apps.length === 0}
      <p class="text-sm {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
        {$_t('No apps found.')}
      </p>
    {:else}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each apps as app (app.appId)}
          <div class="flex flex-col gap-2 rounded-lg p-3
            {modern
              ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark'
              : 'bg-transparent border border-term-dim-green'}">
            <div class="flex items-start gap-3">
              {#if app.iconUrl}
                <img src={app.iconUrl} alt="" class="w-9 h-9 rounded shrink-0 object-cover" />
              {:else}
                <div class="w-9 h-9 rounded shrink-0 flex items-center justify-center text-sm font-semibold
                  {modern ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark' : 'border border-term-dim-green text-term-green'}">
                  {app.name.charAt(0).toUpperCase()}
                </div>
              {/if}
              <div class="min-w-0 flex-1">
                <h2 class="m-0 text-sm font-semibold truncate
                  {modern ? 'text-chat-text dark:text-chat-text-dark font-chat' : 'text-term-green font-terminal'}">
                  {app.name}
                </h2>
                {#if app.categories.length}
                  <p class="m-0 text-xs truncate
                    {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                    {app.categories.join(' · ')}
                  </p>
                {/if}
              </div>
            </div>

            {#if app.description}
              <p class="m-0 text-xs line-clamp-3
                {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                {app.description}
              </p>
            {/if}

            <div class="mt-auto flex items-center gap-2 pt-1 flex-wrap">
              {#if !isInstalled(app)}
                <button
                  disabled={pendingId === app.appId}
                  onclick={() => handleInstall(app)}
                  class="text-xs px-2.5 py-1 rounded cursor-pointer disabled:opacity-50
                    {modern
                      ? 'bg-chat-primary dark:bg-chat-primary-dark text-white font-chat hover:opacity-90'
                      : 'border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
                >
                  {pendingId === app.appId ? $_t('Working…') : $_t('Install')}
                </button>
              {:else if appNeedsConnect(app)}
                {#if oauthPendingId === app.appId}
                  <span class="text-xs {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                    {$_t('Connecting… finish in your browser')}
                  </span>
                  <button
                    onclick={cancelOAuth}
                    class="text-xs px-2 py-1 rounded cursor-pointer
                      {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:underline' : 'text-term-dim-green hover:underline'}"
                  >
                    {$_t('Cancel')}
                  </button>
                {:else}
                  <button
                    onclick={() => handleConnect(app)}
                    class="text-xs px-2.5 py-1 rounded cursor-pointer
                      {modern
                        ? 'bg-chat-primary dark:bg-chat-primary-dark text-white font-chat hover:opacity-90'
                        : 'border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
                  >
                    {app.auth?.status === 'expired' ? $_t('Reconnect') : $_t('Connect')}
                  </button>
                {/if}
              {:else if app.isActivated}
                <span class="text-xs px-2 py-1 rounded
                  {modern ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'text-term-green'}">
                  {$_t('Active')}
                </span>
              {:else}
                <button
                  disabled={pendingId === app.appId}
                  onclick={() => handleActivate(app)}
                  class="text-xs px-2.5 py-1 rounded cursor-pointer disabled:opacity-50
                    {modern
                      ? 'bg-chat-button-hover dark:bg-chat-button-hover-dark text-chat-text dark:text-chat-text-dark font-chat'
                      : 'border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
                >
                  {pendingId === app.appId ? $_t('Working…') : $_t('Activate')}
                </button>
              {/if}
              {#if app.auth?.accountHint && app.auth?.status === 'connected'}
                <span class="text-[10px] truncate max-w-[120px]
                  {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                  {app.auth.accountHint}
                </span>
              {/if}
              {#if app.version}
                <span class="ml-auto text-[10px]
                  {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                  v{app.version}
                </span>
              {/if}
            </div>

            {#if apiKeyFormId === app.appId}
              <div class="flex flex-col gap-2 mt-1 p-2 rounded
                {modern ? 'bg-chat-bg dark:bg-chat-bg-dark' : 'border border-term-dim-green'}">
                {#each apiKeyFields as field (field.key)}
                  <label class="flex flex-col gap-1 text-xs
                    {modern ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}">
                    <span>{field.label}{field.optional ? '' : ' *'}</span>
                    <input
                      type={field.type === 'secret' ? 'password' : 'text'}
                      bind:value={apiKeyValues[field.key]}
                      placeholder={field.placeholder ?? ''}
                      autocomplete="off"
                      class="px-2 py-1 rounded text-xs
                        {modern
                          ? 'bg-chat-surface dark:bg-chat-surface-dark border border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark'
                          : 'bg-transparent border border-term-dim-green text-term-green'}"
                    />
                  </label>
                {/each}
                {#if apiKeyError}
                  <p class="m-0 text-xs text-red-500">{apiKeyError}</p>
                {/if}
                <div class="flex items-center gap-2">
                  <button
                    disabled={apiKeySubmitting}
                    onclick={() => submitApiKeyForm(app)}
                    class="text-xs px-2.5 py-1 rounded cursor-pointer disabled:opacity-50
                      {modern
                        ? 'bg-chat-primary dark:bg-chat-primary-dark text-white font-chat hover:opacity-90'
                        : 'border border-term-dim-green text-term-green font-terminal hover:bg-[rgba(0,255,0,0.1)]'}"
                  >
                    {apiKeySubmitting ? $_t('Saving…') : $_t('Save')}
                  </button>
                  <button
                    onclick={closeApiKeyForm}
                    class="text-xs px-2 py-1 rounded cursor-pointer
                      {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark hover:underline' : 'text-term-dim-green hover:underline'}"
                  >
                    {$_t('Cancel')}
                  </button>
                  {#if app.auth?.setupUrl}
                    <a href={app.auth.setupUrl} target="_blank" rel="noopener noreferrer"
                      class="ml-auto text-[10px] underline
                        {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                      {$_t('Where do I get this?')}
                    </a>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
