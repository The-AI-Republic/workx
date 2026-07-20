<script lang="ts">
  import { onMount } from 'svelte';
  import type { ComponentRuntimeStatus, ComponentView } from '@/core/components';
  import { componentsClient, componentUiError } from '@/webfront/components-runtime/client';
  import { t } from '../lib/i18n';

  let { onBack }: { onBack?: () => void } = $props();

  let loading = $state(true);
  let busyId = $state('');
  let status: ComponentRuntimeStatus | null = $state(null);
  let components: ComponentView[] = $state([]);
  let errorMessage = $state('');
  let successMessage = $state('');

  onMount(load);

  async function load() {
    loading = true;
    clearMessages();
    try {
      status = await componentsClient.status();
      if (!status.available) {
        errorMessage = `Managed components are unavailable (${status.errorCode ?? 'initialization failed'}).`;
        components = [];
        return;
      }
      components = await componentsClient.list();
    } catch (error) {
      errorMessage = componentUiError(error);
    } finally {
      loading = false;
    }
  }

  function clearMessages() {
    errorMessage = '';
    successMessage = '';
  }

  function formatBytes(bytes?: number): string {
    if (bytes === undefined) return 'Unavailable';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function stateLabel(component: ComponentView): string {
    if (component.state === 'installed') return 'Installed';
    if (component.state === 'not_installed') return 'Not installed';
    if (component.state === 'invalid') return 'Needs repair';
    return 'Unsupported';
  }

  async function install(component: ComponentView) {
    clearMessages();
    const verb = component.state === 'invalid' ? 'Repair' : 'Download and install';
    const approved = window.confirm(
      `${verb} ${component.displayName} ${component.version}?\n\n` +
        `Download: ${formatBytes(component.downloadSizeBytes)}\n` +
        `Location: ${status?.componentsPath ?? '~/.workx/components'}\n\n` +
        'This will not modify your system PATH or require administrator access.'
    );
    if (!approved) return;
    busyId = component.id;
    try {
      const installed = await componentsClient.install(component.id);
      components = components.map((item) => (item.id === installed.id ? installed : item));
      successMessage = `${installed.displayName} ${installed.version} is ready.`;
    } catch (error) {
      errorMessage = componentUiError(error);
    } finally {
      busyId = '';
    }
  }

  async function verify(component: ComponentView) {
    clearMessages();
    busyId = component.id;
    try {
      const verified = await componentsClient.verify(component.id);
      components = components.map((item) => (item.id === verified.id ? verified : item));
      successMessage = `${verified.displayName} passed its integrity and health checks.`;
    } catch (error) {
      errorMessage = componentUiError(error);
      await refreshList();
    } finally {
      busyId = '';
    }
  }

  async function uninstall(component: ComponentView) {
    clearMessages();
    if (
      !window.confirm(
        `Remove ${component.displayName} from WorkX?\n\nThis does not remove analysis results or change system software.`
      )
    ) {
      return;
    }
    busyId = component.id;
    try {
      await componentsClient.uninstall(component.id);
      await refreshList();
      successMessage = `${component.displayName} was removed from WorkX.`;
    } catch (error) {
      errorMessage = componentUiError(error);
    } finally {
      busyId = '';
    }
  }

  async function refreshList() {
    components = await componentsClient.list();
  }
</script>

<section class="components-settings" aria-labelledby="components-title">
  <header class="section-header">
    <button class="back-button" onclick={onBack} aria-label={t('Back to settings')}>←</button>
    <div>
      <h2 id="components-title">{t('Components')}</h2>
      <p>{t('Install optional local capabilities privately for WorkX.')}</p>
    </div>
  </header>

  <div class="privacy-note">
    <strong>Private installation:</strong>
    Components are installed under <code>{status?.componentsPath ?? '~/.workx/components'}</code>.
    WorkX does not add them to your system PATH or use a system package manager.
  </div>

  {#if errorMessage}
    <div class="message error" role="alert">{errorMessage}</div>
  {/if}
  {#if successMessage}
    <div class="message success" role="status">{successMessage}</div>
  {/if}

  {#if loading}
    <div class="loading" aria-label="Loading components">Loading components…</div>
  {:else if !status?.available}
    <button class="secondary-button" onclick={load}>Retry initialization check</button>
  {:else}
    <div class="component-list">
      {#each components as component (component.id)}
        <article class="component-card">
          <div class="component-heading">
            <div>
              <h3>{component.displayName}</h3>
              <div class="version">
                Version {component.version} · {component.platform ?? 'Unsupported platform'}
              </div>
            </div>
            <span
              class:installed={component.state === 'installed'}
              class:invalid={component.state === 'invalid'}
              class="state-badge"
            >
              {stateLabel(component)}
            </span>
          </div>

          <p>{component.description}</p>
          <dl>
            <div>
              <dt>Download</dt>
              <dd>{formatBytes(component.downloadSizeBytes)}</dd>
            </div>
            <div>
              <dt>Installed size</dt>
              <dd>
                {component.installedSizeBytes ? formatBytes(component.installedSizeBytes) : '—'}
              </dd>
            </div>
            <div>
              <dt>Capabilities</dt>
              <dd>{component.capabilities.join(', ')}</dd>
            </div>
            <div>
              <dt>License</dt>
              <dd>
                <a href={component.license.url} target="_blank" rel="noreferrer"
                  >{component.license.name}</a
                >
              </dd>
            </div>
          </dl>

          <div class="actions">
            {#if component.state === 'not_installed' || component.state === 'invalid'}
              <button
                class="primary-button"
                onclick={() => install(component)}
                disabled={busyId !== '' || component.state === 'unsupported'}
              >
                {busyId === component.id
                  ? 'Installing…'
                  : component.state === 'invalid'
                    ? 'Repair'
                    : 'Install'}
              </button>
            {:else if component.state === 'installed'}
              <button
                class="secondary-button"
                onclick={() => verify(component)}
                disabled={busyId !== ''}
              >
                {busyId === component.id ? 'Checking…' : 'Verify'}
              </button>
              <button
                class="danger-button"
                onclick={() => uninstall(component)}
                disabled={busyId !== ''}
              >
                Remove
              </button>
            {/if}
            <a class="details-link" href={component.homepage} target="_blank" rel="noreferrer"
              >Project website</a
            >
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .components-settings {
    padding: 1.5rem;
    color: var(--workx-text);
  }

  .section-header {
    display: flex;
    align-items: flex-start;
    gap: 0.9rem;
    margin-bottom: 1rem;
  }

  .section-header h2,
  .section-header p,
  .component-card h3,
  .component-card p {
    margin: 0;
  }

  .section-header p,
  .component-card p,
  .version {
    color: var(--workx-text-secondary);
  }

  .back-button,
  .primary-button,
  .secondary-button,
  .danger-button {
    border-radius: 0.4rem;
    cursor: pointer;
    font: inherit;
  }

  .back-button {
    border: 0;
    background: transparent;
    color: var(--workx-text);
    padding: 0.2rem 0.4rem;
    font-size: 1.25rem;
  }

  .privacy-note,
  .message {
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    padding: 0.85rem;
    margin: 1rem 0;
    background: var(--workx-surface);
  }

  .privacy-note code {
    overflow-wrap: anywhere;
  }

  .message.error {
    border-color: #c85151;
  }

  .message.success {
    border-color: #3f9b65;
  }

  .component-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .component-card {
    border: 1px solid var(--workx-border);
    border-radius: 0.6rem;
    padding: 1rem;
    background: var(--workx-surface);
  }

  .component-heading {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }

  .state-badge {
    align-self: flex-start;
    border: 1px solid var(--workx-border);
    border-radius: 999px;
    padding: 0.2rem 0.55rem;
    white-space: nowrap;
    font-size: 0.8rem;
  }

  .state-badge.installed {
    border-color: #3f9b65;
  }

  .state-badge.invalid {
    border-color: #c98c32;
  }

  dl {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin: 1rem 0;
  }

  dl > div {
    display: grid;
    grid-template-columns: minmax(7rem, 0.3fr) 1fr;
    gap: 0.75rem;
  }

  dt {
    color: var(--workx-text-secondary);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.65rem;
  }

  .primary-button,
  .secondary-button,
  .danger-button {
    padding: 0.5rem 0.8rem;
    border: 1px solid var(--workx-border);
  }

  .primary-button {
    color: white;
    background: var(--workx-primary, #4f6bed);
  }

  .secondary-button {
    color: var(--workx-text);
    background: transparent;
  }

  .danger-button {
    color: #e06c6c;
    background: transparent;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .details-link,
  a {
    color: var(--workx-primary, #6d8cff);
  }

  .loading {
    padding: 1rem 0;
  }
</style>
