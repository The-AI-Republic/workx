<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import {
    fetchMarketplace,
    installApp,
    activateApp,
    isAppsCatalogConfigured,
    AppsApiError,
    type MarketplaceApp,
  } from '../../lib/apis/apps';

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
      const page = await fetchMarketplace({ query: q, signal: controller.signal });
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

  async function handleInstall(app: MarketplaceApp) {
    pendingId = app.appId;
    error = null;
    try {
      await installApp(app.appId);
      await load(query);
    } catch (err) {
      error = err instanceof AppsApiError ? err.message : String(err);
    } finally {
      pendingId = null;
    }
  }

  async function handleActivate(app: MarketplaceApp) {
    pendingId = app.appId;
    error = null;
    try {
      await activateApp(app.appId);
      await load(query);
    } catch (err) {
      error = err instanceof AppsApiError ? err.message : String(err);
    } finally {
      pendingId = null;
    }
  }

  function isInstalled(app: MarketplaceApp): boolean {
    return app.installStatus === 'installed';
  }

  $effect(() => {
    load();
    return () => {
      searchController?.abort();
      if (searchTimer) clearTimeout(searchTimer);
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

            <div class="mt-auto flex items-center gap-2 pt-1">
              {#if isInstalled(app)}
                {#if app.isActivated}
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
              {:else}
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
              {/if}
              {#if app.version}
                <span class="ml-auto text-[10px]
                  {modern ? 'text-chat-text-muted dark:text-chat-text-muted-dark' : 'text-term-dim-green'}">
                  v{app.version}
                </span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
