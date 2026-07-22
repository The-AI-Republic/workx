<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { uiTheme } from '../../stores/themeStore';
  import { appsStore, initializeAppsStore, refreshAppsStore } from '../../stores/appsStore';
  import { _t } from '../../lib/i18n';
  import { openExternalUrl } from '../../lib/gatewayCatalog';
  import {
    activateApp,
    AppsApiError,
    fetchAppIcon,
    fetchMarketplace,
    getAuthStatus,
    installApp,
    needsAuth,
    startOAuth,
    submitApiKey,
    type ManualSetupField,
    type MarketplaceApp,
  } from '../../lib/apis/apps';

  let currentTheme = $derived($uiTheme);
  let modern = $derived(currentTheme === 'modern');
  let access = $derived($appsStore.access);
  let policy = $derived($appsStore.policy);
  let configured = $derived(access?.configured === true);
  let ready = $derived(
    access?.credentialStatus === 'ready' && access?.capabilityStatus === 'supported'
  );
  let accessCard = $derived.by(() => {
    if (access?.capabilityStatus === 'incompatible') {
      return {
        title: 'Apps service update required',
        description:
          'This OpenHub deployment does not support the Apps authentication contract required by WorkX.',
        action: 'retry' as const,
      };
    }
    if (access?.credentialStatus === 'unverified' || access?.backendStatus === 'unavailable') {
      return {
        title: 'Apps service unavailable',
        description: 'WorkX could not verify Apps access. Check your connection and try again.',
        action: 'retry' as const,
      };
    }
    if (access?.credentialStatus === 'validating') {
      return {
        title: 'Checking Apps access',
        description: 'WorkX is verifying your Apps credential.',
        action: 'none' as const,
      };
    }
    if (access?.credentialStatus === 'forbidden') {
      return {
        title: 'Apps access unavailable',
        description: 'The current OpenHub API key does not have permission to use Apps.',
        action: 'retry' as const,
      };
    }
    if (access?.credentialStatus === 'invalid-credential') {
      return {
        title: 'Reconnect Apps',
        description: 'OpenHub rejected the current Apps API key.',
        action: 'setup' as const,
      };
    }
    return {
      title: policy?.setupCopy.title ?? 'Apps unavailable',
      description: policy?.setupCopy.description ?? $appsStore.error ?? access?.reason ?? '',
      action: 'setup' as const,
    };
  });

  let apps = $state<MarketplaceApp[]>([]);
  let icons = $state<Record<string, string>>({});
  let loading = $state(false);
  let error = $state<string | null>(null);
  let query = $state('');
  let pendingId = $state<string | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let loadedRevision = -1;

  let oauthPendingIds = $state<string[]>([]);
  let connectErrors = $state<Record<string, string>>({});
  let apiKeyFormId = $state<string | null>(null);
  let apiKeyFields = $state<ManualSetupField[]>([]);
  let apiKeyValues = $state<Record<string, string>>({});
  let apiKeyError = $state<string | null>(null);
  let apiKeySubmitting = $state(false);
  const pollers = new Map<string, { cancelled: boolean }>();

  function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function load(search = query, background = false) {
    if (!ready) return;
    const currentGeneration = ++generation;
    if (!background || apps.length === 0) loading = true;
    if (!background) error = null;
    try {
      const page = await fetchMarketplace({ query: search });
      if (currentGeneration !== generation) return;
      apps = page.items;
      error = null;
      void loadIcons(page.items, currentGeneration);
    } catch (cause) {
      if (currentGeneration !== generation) return;
      if (!background) error = message(cause);
    } finally {
      if (currentGeneration === generation) loading = false;
    }
  }

  async function loadIcons(items: MarketplaceApp[], currentGeneration: number) {
    await Promise.allSettled(
      items
        .filter((app) => app.hasIcon)
        .map(async (app) => {
          const icon = await fetchAppIcon(app.appId);
          if (!icon || currentGeneration !== generation) return;
          icons = { ...icons, [app.appId]: `data:${icon.mimeType};base64,${icon.base64}` };
        })
    );
  }

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(query), 250);
  }

  function replaceApp(updated: MarketplaceApp | null) {
    if (!updated) return false;
    apps = apps.map((app) => (app.appId === updated.appId ? updated : app));
    return true;
  }

  async function runAction(
    app: MarketplaceApp,
    action: (appId: string) => Promise<MarketplaceApp | null>
  ) {
    pendingId = app.appId;
    error = null;
    try {
      if (!replaceApp(await action(app.appId))) await load();
    } catch (cause) {
      error = message(cause);
    } finally {
      pendingId = null;
    }
  }

  async function handleInstall(app: MarketplaceApp) {
    pendingId = app.appId;
    setConnectError(app.appId, null);
    try {
      if (!replaceApp(await installApp(app.appId))) await load();
      const auth = await getAuthStatus(app.appId);
      if (auth) applyAuth(app.appId, auth);
      if (needsAuth(auth)) {
        pendingId = null;
        await handleConnect({ ...(apps.find((item) => item.appId === app.appId) ?? app), auth });
      }
    } catch (cause) {
      error = message(cause);
    } finally {
      if (pendingId === app.appId) pendingId = null;
    }
  }

  function isInstalled(app: MarketplaceApp): boolean {
    return app.installStatus === 'installed';
  }
  function appNeedsConnect(app: MarketplaceApp): boolean {
    return isInstalled(app) && needsAuth(app.auth);
  }
  function isOauthPending(appId: string): boolean {
    return oauthPendingIds.includes(appId);
  }
  function applyAuth(appId: string, auth: MarketplaceApp['auth']) {
    apps = apps.map((app) => (app.appId === appId ? { ...app, auth } : app));
  }
  function setConnectError(appId: string, value: string | null) {
    if (value) connectErrors = { ...connectErrors, [appId]: value };
    else {
      const next = { ...connectErrors };
      delete next[appId];
      connectErrors = next;
    }
  }

  async function handleConnect(app: MarketplaceApp) {
    setConnectError(app.appId, null);
    if (app.auth?.type === 'api_key' || app.auth?.type === 'basic') {
      apiKeyFields = app.auth.manualFields;
      apiKeyValues = Object.fromEntries(apiKeyFields.map((field) => [field.key, '']));
      apiKeyFormId = app.appId;
      apiKeyError = null;
      return;
    }
    await connectOAuth(app);
  }

  async function connectOAuth(app: MarketplaceApp) {
    if (pollers.has(app.appId)) return;
    const controller = { cancelled: false };
    pollers.set(app.appId, controller);
    oauthPendingIds = [...oauthPendingIds, app.appId];
    try {
      const oauth = await startOAuth(app.appId);
      await openExternalUrl(oauth.authorizationUrl);
      if (await pollAuthUntilConnected(app.appId, controller)) await load();
      else if (!controller.cancelled)
        setConnectError(
          app.appId,
          `Couldn't confirm the ${app.name} connection. Finish in your browser, then retry.`
        );
    } catch (cause) {
      if (!controller.cancelled) setConnectError(app.appId, message(cause));
    } finally {
      if (pollers.get(app.appId) === controller) {
        pollers.delete(app.appId);
        oauthPendingIds = oauthPendingIds.filter((id) => id !== app.appId);
      }
    }
  }

  async function pollAuthUntilConnected(
    appId: string,
    controller: { cancelled: boolean }
  ): Promise<boolean> {
    const deadline = Date.now() + 90_000;
    while (!controller.cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (controller.cancelled) return false;
      try {
        const status = await getAuthStatus(appId);
        if (status) applyAuth(appId, status);
        if (status?.status === 'connected') return true;
      } catch {
        // Keep polling through transient runtime/backend failures.
      }
    }
    return false;
  }

  function cancelOAuth(appId: string) {
    const controller = pollers.get(appId);
    if (controller) controller.cancelled = true;
    pollers.delete(appId);
    oauthPendingIds = oauthPendingIds.filter((id) => id !== appId);
  }

  function closeCredentialForm() {
    apiKeyFormId = null;
    apiKeyFields = [];
    apiKeyValues = {};
    apiKeyError = null;
  }

  async function submitCredentialForm(app: MarketplaceApp) {
    const missing = apiKeyFields.filter(
      (field) => !field.optional && !(apiKeyValues[field.key] ?? '').trim()
    );
    if (missing.length) {
      apiKeyError = `Enter ${missing.map((field) => field.label).join(', ')}.`;
      return;
    }
    apiKeySubmitting = true;
    try {
      const fields = Object.fromEntries(
        Object.entries(apiKeyValues).filter(([, value]) => value.trim())
      );
      const auth = await submitApiKey(app.appId, fields);
      if (auth) applyAuth(app.appId, auth);
      closeCredentialForm();
      await load();
    } catch (cause) {
      apiKeyError = cause instanceof AppsApiError ? cause.message : message(cause);
    } finally {
      apiKeyValues = {};
      apiKeySubmitting = false;
    }
  }

  function openSetup() {
    push('/settings?view=apps');
  }

  function refreshOnReturn() {
    if (ready) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(query, true), 300);
    } else {
      void refreshAppsStore();
    }
  }

  $effect(() => {
    const revision = access?.revision ?? -1;
    if (ready && revision !== loadedRevision) {
      loadedRevision = revision;
      void load();
    }
  });

  onMount(() => {
    void initializeAppsStore();
    window.addEventListener('focus', refreshOnReturn);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshOnReturn();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', onVisibility);
      if (searchTimer) clearTimeout(searchTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const controller of pollers.values()) controller.cancelled = true;
      pollers.clear();
    };
  });
</script>

<div
  data-testid="apps-page"
  class="h-full overflow-y-auto {currentTheme} {modern
    ? 'font-chat bg-chat-bg text-chat-text dark:bg-chat-bg-dark dark:text-chat-text-dark'
    : 'font-terminal bg-term-bg text-term-green'}"
>
  <div
    class="px-4 py-3 flex gap-2 items-center {modern
      ? 'border-b border-chat-border dark:border-chat-border-dark'
      : 'border-b border-term-dim-green'}"
  >
    <h1
      class="m-0 text-base font-semibold {modern
        ? 'text-chat-text dark:text-chat-text-dark'
        : 'text-term-green'}"
    >
      {$_t('Apps')}
    </h1>
  </div>

  {#if ready}
    <div class="px-4 py-3">
      <input
        type="search"
        bind:value={query}
        oninput={onSearchInput}
        placeholder={$_t('Search apps…')}
        class="w-full px-3 py-2 text-sm rounded bg-transparent border {modern
          ? 'border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark'
          : 'border-term-dim-green text-term-green'}"
      />
    </div>
  {/if}

  <div class="px-4 pb-6">
    {#if $appsStore.loading}
      <p class="text-sm opacity-70">{$_t('Loading apps…')}</p>
    {:else if !configured}
      <p class="text-sm opacity-70">{$_t('The app catalog is not configured for this build.')}</p>
    {:else if !ready}
      <div
        data-testid="apps-access-card"
        class="rounded-lg border p-4 {modern
          ? 'border-chat-border bg-chat-surface text-chat-text dark:border-chat-border-dark dark:bg-chat-surface-dark dark:text-chat-text-dark'
          : 'border-term-dim-green bg-[#0a0a0a] text-term-green'}"
      >
        <h2 class="m-0 text-base font-semibold">
          {$_t(accessCard.title)}
        </h2>
        <p
          class="text-sm {modern
            ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
            : 'text-term-dim-green'}"
        >
          {$_t(accessCard.description)}
        </p>
        {#if accessCard.action === 'retry'}
          <button
            class="text-sm underline {modern
              ? 'text-chat-primary hover:opacity-80 dark:text-chat-primary-dark'
              : 'text-term-bright-green hover:text-term-green'}"
            onclick={() => refreshAppsStore()}>{$_t('Retry')}</button
          >
        {:else if accessCard.action === 'setup'}
          <button
            class="text-sm px-3 py-1.5 rounded {modern
              ? 'border border-chat-primary bg-chat-primary text-white hover:opacity-90 dark:border-chat-primary-dark dark:bg-chat-primary-dark'
              : 'border border-term-green bg-term-green text-black hover:bg-term-bright-green'}"
            onclick={openSetup}
          >
            {policy ? $_t(policy.setupCopy.action) : $_t('Configure')}
          </button>
        {/if}
      </div>
    {:else if loading}
      <p class="text-sm opacity-70">{$_t('Loading apps…')}</p>
    {:else if error}
      <div class="text-sm rounded p-3 text-red-500">
        {error} <button class="underline" onclick={() => load()}>{$_t('Retry')}</button>
      </div>
    {:else if apps.length === 0}
      <p class="text-sm opacity-70">{$_t('No apps found.')}</p>
    {:else}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each apps as app (app.appId)}
          <article
            class="flex flex-col gap-2 rounded-lg p-3 border {modern
              ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
              : 'border-term-dim-green'}"
          >
            <div class="flex items-start gap-3">
              {#if icons[app.appId]}
                <img src={icons[app.appId]} alt="" class="w-9 h-9 rounded object-cover" />
              {:else}
                <div class="w-9 h-9 rounded flex items-center justify-center border">
                  {app.name.charAt(0).toUpperCase()}
                </div>
              {/if}
              <div class="min-w-0">
                <h2 class="m-0 text-sm font-semibold truncate">{app.name}</h2>
                <p class="m-0 text-xs opacity-60 truncate">{app.categories.join(' · ')}</p>
              </div>
            </div>
            {#if app.description}<p class="m-0 text-sm opacity-70 line-clamp-3">
                {app.description}
              </p>{/if}
            <div class="mt-auto flex gap-2 items-center flex-wrap">
              {#if !isInstalled(app)}
                <button
                  disabled={pendingId === app.appId}
                  onclick={() => handleInstall(app)}
                  class="text-sm px-2.5 py-1 rounded border disabled:opacity-50"
                  >{pendingId === app.appId ? $_t('Working…') : $_t('Install')}</button
                >
              {:else if appNeedsConnect(app)}
                {#if isOauthPending(app.appId)}
                  <span class="text-xs opacity-70">{$_t('Connecting… finish in your browser')}</span
                  ><button class="text-sm underline" onclick={() => cancelOAuth(app.appId)}
                    >{$_t('Cancel')}</button
                  >
                {:else}
                  <button
                    class="text-sm px-2.5 py-1 rounded border"
                    onclick={() => handleConnect(app)}
                    >{app.auth?.status === 'expired' ? $_t('Reconnect') : $_t('Connect')}</button
                  >
                {/if}
              {:else if app.isActivated}
                <span class="text-xs text-green-500">{$_t('Active')}</span>
              {:else}
                <button
                  disabled={pendingId === app.appId}
                  class="text-sm px-2.5 py-1 rounded border disabled:opacity-50"
                  onclick={() => runAction(app, activateApp)}>{$_t('Activate')}</button
                >
              {/if}
              {#if app.version}<span class="ml-auto text-xs opacity-60">v{app.version}</span>{/if}
            </div>
            {#if connectErrors[app.appId]}<p class="m-0 text-xs text-red-500">
                {connectErrors[app.appId]}
              </p>{/if}
            {#if apiKeyFormId === app.appId}
              <div class="flex flex-col gap-2 border rounded p-2">
                {#each apiKeyFields as field (field.key)}
                  <label class="text-sm flex flex-col gap-1"
                    ><span>{field.label}{field.optional ? '' : ' *'}</span><input
                      type={field.type === 'secret' ? 'password' : 'text'}
                      bind:value={apiKeyValues[field.key]}
                      autocomplete="off"
                      class="px-2 py-1 border rounded bg-transparent"
                    /></label
                  >
                {/each}
                {#if apiKeyError}<p class="m-0 text-xs text-red-500">{apiKeyError}</p>{/if}
                <div class="flex gap-2">
                  <button
                    disabled={apiKeySubmitting}
                    class="text-sm px-2 py-1 border rounded"
                    onclick={() => submitCredentialForm(app)}
                    >{apiKeySubmitting ? $_t('Saving…') : $_t('Save')}</button
                  >
                  <button class="text-sm underline" onclick={closeCredentialForm}
                    >{$_t('Cancel')}</button
                  >
                  {#if app.auth?.setupUrl}<button
                      class="ml-auto text-sm underline"
                      onclick={() => openExternalUrl(app.auth!.setupUrl!)}
                      >{$_t('Where do I get this?')}</button
                    >{/if}
                </div>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </div>
</div>
