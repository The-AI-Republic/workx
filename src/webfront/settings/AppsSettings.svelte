<script lang="ts">
  import { onMount } from 'svelte';
  import { appsStore, initializeAppsStore, refreshAppsStore } from '../stores/appsStore';
  import { openExternalUrl } from '../lib/gatewayCatalog';
  import { removeAppsApiKey, saveAppsApiKey, validateAppsApiKey } from '../lib/apis/apps';
  import { t } from '../lib/i18n';

  let { onBack }: { onBack?: () => void } = $props();
  let apiKey = $state('');
  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);
  let access = $derived($appsStore.access);
  let policy = $derived($appsStore.policy);

  onMount(() => {
    void initializeAppsStore();
  });

  async function validateKey() {
    const candidate = apiKey.trim();
    if (!candidate) return;
    busy = true;
    error = null;
    message = null;
    try {
      await validateAppsApiKey(candidate);
      message = t('OpenHub API key is valid.');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function saveKey() {
    const candidate = apiKey.trim();
    if (!candidate) return;
    busy = true;
    error = null;
    message = null;
    try {
      await saveAppsApiKey(candidate);
      await refreshAppsStore();
      message = t('OpenHub API key saved.');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      apiKey = '';
      busy = false;
    }
  }

  async function removeKey() {
    busy = true;
    error = null;
    message = null;
    try {
      await removeAppsApiKey();
      await refreshAppsStore();
      message = t('OpenHub API key removed.');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      apiKey = '';
      busy = false;
    }
  }
</script>

<section class="apps-settings" aria-labelledby="apps-settings-title">
  <div class="header">
    <button class="back" onclick={onBack} aria-label={t('Back to settings')}>←</button>
    <div>
      <h2 id="apps-settings-title">{t('Apps')}</h2>
      <p>{policy ? t(policy.setupCopy.description) : t('Configure OpenHub Apps access.')}</p>
    </div>
  </div>

  {#if $appsStore.loading}
    <p>{t('Loading settings...')}</p>
  {:else if policy?.authMethod === 'api-key'}
    <div class="card">
      <h3>{t('OpenHub API key')}</h3>
      <p>{t('This is an OpenHub/Apps credential, not a model-provider API key.')}</p>
      {#if access?.credentialSource === 'managed-api-key'}
        <p class="status">{t('An administrator-managed credential is active.')}</p>
      {:else if access?.hasCredential}
        <p class="status">{t('An OpenHub credential is configured.')}</p>
      {/if}
      <input
        type="password"
        bind:value={apiKey}
        autocomplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        placeholder={t('OpenHub API key')}
        disabled={busy}
      />
      <div class="actions">
        <button onclick={validateKey} disabled={busy || !apiKey.trim()}>{t('Validate')}</button>
        <button class="primary" onclick={saveKey} disabled={busy || !apiKey.trim()}
          >{access?.credentialSource === 'stored-api-key' ? t('Replace') : t('Save')}</button
        >
        {#if access?.credentialSource === 'stored-api-key'}<button
            onclick={removeKey}
            disabled={busy}>{t('Remove')}</button
          >{/if}
        <button class="link" onclick={() => openExternalUrl(policy.apiKeyManagementUrl)}
          >{t('Apply for an OpenHub key')}</button
        >
      </div>
    </div>
  {:else}
    <p>{t('OpenHub API-key access is unavailable in this build.')}</p>
  {/if}
  {#if message}<p class="success">{message}</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .apps-settings {
    padding: 1.5rem;
    color: var(--workx-text);
  }
  .header {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    margin-bottom: 1.25rem;
  }
  .header h2,
  .header p {
    margin: 0;
  }
  .header p {
    opacity: 0.7;
    font-size: var(--text-sm);
    margin-top: 0.25rem;
  }
  .back {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: var(--text-xl);
    cursor: pointer;
  }
  .card {
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    padding: 1rem;
    background: var(--workx-surface);
  }
  .card h3 {
    margin: 0 0 0.5rem;
  }
  .card p {
    font-size: var(--text-sm);
    opacity: 0.75;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.65rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.375rem;
    background: transparent;
    color: inherit;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .actions button {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.375rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions .primary {
    background: var(--workx-primary);
    color: white;
  }
  .actions .link {
    border: 0;
    text-decoration: underline;
    margin-left: auto;
  }
  .status,
  .success {
    color: var(--workx-success, #16a34a);
  }
  .error {
    color: var(--workx-error, #dc2626);
  }
</style>
