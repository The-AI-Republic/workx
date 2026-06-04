<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { getInitializedUIClient } from '@/core/messaging';
  import { t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  type InstallStatus = 'installed' | 'uninstalled' | 'disabled';
  type DeviceStatus = 'missing_metadata' | 'ready' | 'needs_auth' | 'connected' | 'auth_error' | 'disabled' | 'blocked_by_provider_registration';

  interface MarketplaceApp {
    appId: string;
    slug: string;
    name: string;
    description?: string;
    iconUrl?: string;
    version?: string;
    capabilities?: string[];
    runtime?: {
      kind?: string;
      transport?: string;
      endpoint?: string;
    };
    trust?: {
      tier?: string;
      namespaceVerified?: boolean;
    };
    providerRegistration?: {
      status?: string;
    };
    install?: {
      status?: InstallStatus;
      enabled?: boolean;
      priority?: number;
    };
  }

  interface LocalApp {
    appId: string;
    slug: string;
    name: string;
    version: string;
    enabled: boolean;
    priority: number;
    connectionStatus: DeviceStatus;
    lastError?: string;
  }

  interface ActivationResult {
    status: string;
    message?: string;
    toolNames?: string[];
  }

  const MAX_PINNED_APPS = 10;

  let apps: MarketplaceApp[] = $state([]);
  let localApps: LocalApp[] = $state([]);
  let deviceId: string | null = $state(null);
  let query: string = $state('');
  let loading: boolean = $state(true);
  let error: string | null = $state(null);
  let message: string | null = $state(null);
  let busyAppId: string | null = $state(null);

  let currentTheme = $derived($uiTheme);
  let installedById = $derived(new Map(localApps.map(app => [app.appId, app])));
  let filteredApps = $derived(filterApps(apps, query));
  let installedCount = $derived(localApps.length);
  let connectedCount = $derived(localApps.filter(app => app.connectionStatus === 'connected').length);
  let pinnedCount = $derived(localApps.filter(app => app.priority === 1).length);

  onMount(async () => {
    await loadApps();
  });

  function close() {
    push('/');
  }

  function filterApps(items: MarketplaceApp[], text: string): MarketplaceApp[] {
    const needle = text.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(app => [
      app.name,
      app.slug,
      app.description,
      ...(app.capabilities ?? []),
    ].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }

  async function loadApps() {
    loading = true;
    error = null;
    message = null;

    try {
      const client = await getInitializedUIClient();
      await client.serviceRequest('apps.sync');
      const [marketplace, installations] = await Promise.all([
        client.serviceRequest<{ items: MarketplaceApp[] }>('apps.marketplace'),
        client.serviceRequest<{ deviceId: string; localItems: LocalApp[] }>('apps.installations'),
      ]);
      apps = marketplace.items ?? [];
      localApps = installations.localItems ?? [];
      deviceId = installations.deviceId ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function install(appId: string) {
    busyAppId = appId;
    error = null;
    message = null;
    try {
      await (await getInitializedUIClient()).serviceRequest('apps.install', { appId });
      message = t('Installed');
      await loadApps();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyAppId = null;
    }
  }

  async function uninstall(appId: string) {
    busyAppId = appId;
    error = null;
    message = null;
    try {
      await (await getInitializedUIClient()).serviceRequest('apps.uninstall', { appId });
      message = t('Uninstalled');
      await loadApps();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyAppId = null;
    }
  }

  async function activate(appId: string) {
    busyAppId = appId;
    error = null;
    message = null;
    try {
      const result = await (await getInitializedUIClient()).serviceRequest<ActivationResult>('apps.activate', { appId });
      message = result.message || activationMessage(result);
      await loadApps();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyAppId = null;
    }
  }

  async function connectAccount(appId: string) {
    busyAppId = appId;
    error = null;
    message = null;
    try {
      await (await getInitializedUIClient()).serviceRequest('apps.connectAccount', { appId }, { timeoutMs: 310_000 });
      message = t('Account connected');
      await loadApps();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyAppId = null;
    }
  }

  async function setPriority(appId: string, priority: 1 | 2) {
    const local = installedById.get(appId);
    if (priority === 1 && local?.priority !== 1 && pinnedCount >= MAX_PINNED_APPS) {
      error = `${t('You can pin up to')} ${MAX_PINNED_APPS} ${t('apps')}`;
      return;
    }

    busyAppId = appId;
    error = null;
    message = null;
    try {
      await (await getInitializedUIClient()).serviceRequest('apps.setPriority', { appId, priority });
      message = priority === 1 ? t('Pinned') : t('Folded');
      await loadApps();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyAppId = null;
    }
  }

  function activationMessage(result: ActivationResult): string {
    if (result.status === 'activated' || result.status === 'already_active') {
      return `${t('Activated')} ${result.toolNames?.length ?? 0} ${t('tools')}`;
    }
    if (result.status === 'needs_auth') {
      return t('Account connection required');
    }
    return result.status;
  }

  function statusLabel(local: LocalApp | undefined, app: MarketplaceApp): string {
    if (local?.connectionStatus) {
      return local.connectionStatus.replace(/_/g, ' ');
    }
    return app.install?.status === 'installed' ? 'ready' : 'not installed';
  }

  function trustLabel(app: MarketplaceApp): string {
    return app.trust?.tier?.replace(/_/g, ' ') || 'community';
  }

  function canActivate(local: LocalApp | undefined): boolean {
    return !!local && local.enabled && !['connected', 'needs_auth', 'disabled', 'blocked_by_provider_registration'].includes(local.connectionStatus);
  }

  function canPin(local: LocalApp | undefined): boolean {
    return !!local && (local.priority === 1 || pinnedCount < MAX_PINNED_APPS);
  }
</script>

<div class="apps-page" class:modern={currentTheme === 'modern'}>
  <div class="apps-container">
    <div class="apps-header">
      <div>
        <h2 class="apps-title">{t('Apps')}</h2>
        <div class="apps-meta">
          {installedCount} {t('installed')} - {connectedCount} {t('connected')} - {pinnedCount}/{MAX_PINNED_APPS} {t('pinned')}
          {#if deviceId}
            - {deviceId.slice(0, 8)}
          {/if}
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-button" onclick={loadApps} aria-label={t('Refresh apps')} disabled={loading}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M21 12a9 9 0 0 1-15.5 6.3"></path>
            <path d="M3 12A9 9 0 0 1 18.5 5.7"></path>
            <path d="M18 2v4h-4"></path>
            <path d="M6 22v-4h4"></path>
          </svg>
        </button>
        <button class="icon-button" onclick={close} aria-label={t('Close apps')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </button>
      </div>
    </div>

    <div class="toolbar">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m20 20-3.5-3.5"></path>
        </svg>
        <input bind:value={query} placeholder={t('Search apps')} aria-label={t('Search apps')} />
      </div>
    </div>

    {#if error}
      <div class="notice error">{error}</div>
    {:else if message}
      <div class="notice success">{message}</div>
    {/if}

    <div class="apps-content">
      {#if loading}
        <div class="empty-state">{t('Loading apps...')}</div>
      {:else if filteredApps.length === 0}
        <div class="empty-state">{t('No apps found')}</div>
      {:else}
        <div class="app-grid">
          {#each filteredApps as app (app.appId)}
            {@const local = installedById.get(app.appId)}
            <article class="app-card">
              <div class="app-card-main">
                <div class="app-icon" aria-hidden="true">
                  {app.name.slice(0, 1).toUpperCase()}
                </div>
                <div class="app-info">
                  <div class="app-row">
                    <h3>{app.name}</h3>
                    <span class="status-pill status-{local?.connectionStatus ?? app.install?.status ?? 'uninstalled'}">
                      {statusLabel(local, app)}
                    </span>
                  </div>
                  <p>{app.description}</p>
                  <div class="chips">
                    <span>{trustLabel(app)}</span>
                    {#if local}
                      <span>{local.priority === 1 ? t('Pinned') : t('Folded')}</span>
                    {/if}
                    {#if app.runtime?.transport}
                      <span>{app.runtime.transport}</span>
                    {/if}
                    {#if app.version}
                      <span>v{app.version}</span>
                    {/if}
                  </div>
                  {#if app.capabilities?.length}
                    <div class="capabilities">
                      {#each app.capabilities.slice(0, 4) as capability}
                        <span>{capability}</span>
                      {/each}
                    </div>
                  {/if}
                  {#if local?.lastError}
                    <div class="inline-error">{local.lastError}</div>
                  {/if}
                </div>
              </div>
              <div class="app-actions">
                {#if local}
                  {#if local.connectionStatus === 'needs_auth' || local.connectionStatus === 'auth_error'}
                    <button class="primary-button" onclick={() => connectAccount(app.appId)} disabled={busyAppId === app.appId}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path>
                        <path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"></path>
                      </svg>
                      <span>{t('Connect')}</span>
                    </button>
                  {/if}
                  <button
                    class="secondary-button"
                    onclick={() => setPriority(app.appId, local.priority === 1 ? 2 : 1)}
                    disabled={busyAppId === app.appId || !canPin(local)}
                    title={!canPin(local) ? `${t('You can pin up to')} ${MAX_PINNED_APPS} ${t('apps')}` : undefined}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 17v5"></path>
                      <path d="M7 2h10l-1 7 4 4v2H4v-2l4-4z"></path>
                    </svg>
                    <span>{local.priority === 1 ? t('Fold') : t('Pin')}</span>
                  </button>
                  <button class="secondary-button" onclick={() => activate(app.appId)} disabled={busyAppId === app.appId || !canActivate(local)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 2v10"></path>
                      <path d="M18.4 6.6a9 9 0 1 1-12.8 0"></path>
                    </svg>
                    <span>{local.connectionStatus === 'needs_auth' ? t('Needs auth') : t('Activate')}</span>
                  </button>
                  <button class="danger-button" onclick={() => uninstall(app.appId)} disabled={busyAppId === app.appId}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M3 6h18"></path>
                      <path d="M8 6V4h8v2"></path>
                      <path d="M19 6l-1 14H6L5 6"></path>
                    </svg>
                    <span>{t('Uninstall')}</span>
                  </button>
                {:else}
                  <button class="primary-button" onclick={() => install(app.appId)} disabled={busyAppId === app.appId}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 5v14"></path>
                      <path d="M5 12h14"></path>
                    </svg>
                    <span>{t('Install')}</span>
                  </button>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .apps-page {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--color-term-bg);
    color: var(--color-term-green);
    font-family: var(--font-terminal);
  }

  .apps-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 12px;
  }

  .apps-header,
  .toolbar {
    flex-shrink: 0;
  }

  .apps-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(0, 204, 0, 0.35);
  }

  .apps-title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .apps-meta {
    margin-top: 4px;
    color: var(--color-term-dim-green);
    font-size: 12px;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .icon-button,
  .primary-button,
  .secondary-button,
  .danger-button {
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
  }

  .icon-button {
    width: 34px;
    height: 34px;
    border: 1px solid rgba(0, 204, 0, 0.45);
    color: inherit;
    background: transparent;
  }

  .icon-button svg {
    width: 18px;
    height: 18px;
    stroke-width: 2;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .search-box {
    flex: 1;
    min-width: 0;
    height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(0, 204, 0, 0.45);
    border-radius: 6px;
    padding: 0 10px;
  }

  .search-box svg {
    width: 18px;
    height: 18px;
    color: var(--color-term-dim-green);
    stroke-width: 2;
    flex-shrink: 0;
  }

  .search-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    outline: none;
  }

  .search-box input::placeholder {
    color: var(--color-term-dim-green);
  }

  .notice {
    flex-shrink: 0;
    border-radius: 6px;
    padding: 9px 10px;
    font-size: 13px;
    border: 1px solid currentColor;
  }

  .notice.error,
  .inline-error {
    color: var(--color-term-red);
  }

  .notice.success {
    color: var(--color-term-bright-green);
  }

  .apps-content {
    min-height: 0;
    overflow: auto;
  }

  .empty-state {
    padding: 32px 4px;
    color: var(--color-term-dim-green);
    font-size: 14px;
  }

  .app-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 10px;
    padding-bottom: 12px;
  }

  .app-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    border: 1px solid rgba(0, 204, 0, 0.35);
    border-radius: 8px;
    padding: 12px;
    min-width: 0;
  }

  .app-card-main {
    display: flex;
    gap: 12px;
    min-width: 0;
  }

  .app-icon {
    width: 38px;
    height: 38px;
    flex: 0 0 38px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(0, 204, 0, 0.45);
    font-weight: 700;
  }

  .app-info {
    min-width: 0;
    flex: 1;
  }

  .app-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .app-row h3 {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
    letter-spacing: 0;
  }

  .status-pill,
  .chips span,
  .capabilities span {
    border-radius: 999px;
    border: 1px solid rgba(0, 204, 0, 0.35);
    padding: 2px 7px;
    font-size: 11px;
    line-height: 18px;
    white-space: nowrap;
  }

  .status-pill {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--color-term-bright-green);
  }

  .status-needs_auth,
  .status-auth_error {
    color: var(--color-term-yellow);
  }

  .status-uninstalled,
  .status-missing_metadata {
    color: var(--color-term-dim-green);
  }

  .app-info p {
    margin: 7px 0 0;
    color: var(--color-term-dim-green);
    font-size: 12px;
    line-height: 1.4;
  }

  .chips,
  .capabilities {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
  }

  .capabilities span {
    color: var(--color-term-dim-green);
  }

  .inline-error {
    margin-top: 8px;
    font-size: 12px;
    line-height: 1.35;
    word-break: break-word;
  }

  .app-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .primary-button,
  .secondary-button,
  .danger-button {
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid rgba(0, 204, 0, 0.45);
    background: transparent;
    color: inherit;
    font-size: 12px;
  }

  .primary-button {
    background: rgba(0, 204, 0, 0.12);
    color: var(--color-term-bright-green);
  }

  .danger-button {
    color: var(--color-term-red);
    border-color: rgba(255, 0, 0, 0.45);
  }

  .primary-button svg,
  .secondary-button svg,
  .danger-button svg {
    width: 16px;
    height: 16px;
    stroke-width: 2;
  }

  button:hover:not(:disabled) {
    background: rgba(0, 204, 0, 0.12);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .apps-page.modern {
    background: var(--color-chat-bg);
    color: var(--color-chat-text);
    font-family: var(--font-chat);
  }

  .modern .apps-header {
    border-bottom-color: var(--color-chat-border);
  }

  .modern .apps-meta,
  .modern .app-info p,
  .modern .capabilities span {
    color: var(--color-chat-text-secondary);
  }

  .modern .icon-button,
  .modern .search-box,
  .modern .app-card,
  .modern .app-icon,
  .modern .status-pill,
  .modern .chips span,
  .modern .capabilities span,
  .modern .primary-button,
  .modern .secondary-button {
    border-color: var(--color-chat-card-border);
  }

  .modern .app-card,
  .modern .search-box {
    background: var(--color-chat-card);
  }

  .modern .search-box svg,
  .modern .search-box input::placeholder {
    color: var(--color-chat-text-muted);
  }

  .modern .status-pill,
  .modern .primary-button {
    color: var(--color-chat-primary);
  }

  .modern .primary-button {
    background: rgba(37, 99, 235, 0.08);
  }

  .modern .danger-button {
    color: var(--color-chat-error);
    border-color: rgba(220, 38, 38, 0.35);
  }

  .modern button:hover:not(:disabled) {
    background: var(--color-chat-button-hover);
  }

  :global(.dark) .apps-page.modern {
    background: var(--color-chat-bg-dark);
    color: var(--color-chat-text-dark);
  }

  :global(.dark) .modern .apps-header {
    border-bottom-color: var(--color-chat-border-dark);
  }

  :global(.dark) .modern .apps-meta,
  :global(.dark) .modern .app-info p,
  :global(.dark) .modern .capabilities span {
    color: var(--color-chat-text-secondary-dark);
  }

  :global(.dark) .modern .icon-button,
  :global(.dark) .modern .search-box,
  :global(.dark) .modern .app-card,
  :global(.dark) .modern .app-icon,
  :global(.dark) .modern .status-pill,
  :global(.dark) .modern .chips span,
  :global(.dark) .modern .capabilities span,
  :global(.dark) .modern .primary-button,
  :global(.dark) .modern .secondary-button {
    border-color: var(--color-chat-card-border-dark);
  }

  :global(.dark) .modern .app-card,
  :global(.dark) .modern .search-box {
    background: var(--color-chat-card-dark);
  }

  :global(.dark) .modern .status-pill,
  :global(.dark) .modern .primary-button {
    color: var(--color-chat-primary-dark);
  }

  @media (max-width: 720px) {
    .apps-container {
      padding: 12px;
    }

    .app-grid {
      grid-template-columns: 1fr;
    }

    .app-card-main {
      align-items: flex-start;
    }

    .app-row {
      align-items: flex-start;
      flex-direction: column;
    }

    .status-pill {
      margin-left: 0;
    }

    .app-actions {
      justify-content: stretch;
    }

    .primary-button,
    .secondary-button,
    .danger-button {
      flex: 1 1 120px;
    }
  }
</style>
