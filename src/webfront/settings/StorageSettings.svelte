<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { ICacheSettings, IStorageConfig } from '@/config/types';
  import { _t } from '../lib/i18n';
  import { notifyConfigUpdate } from '../lib/messaging';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  let {
    settingsConfig,
    highlightSettingId = $bindable<string | undefined>(undefined),
    onBack,
    onSaved,
  }: {
    settingsConfig: AgentConfig;
    highlightSettingId?: string | undefined;
    onBack?: () => void;
    onSaved?: (detail: { success: boolean; error?: string }) => void;
  } = $props();

  // Form state
  let originalCache: ICacheSettings = $state({});
  let currentCache: ICacheSettings = $state({});
  let originalStorage: IStorageConfig = $state({});
  let currentStorage: IStorageConfig = $state({});
  let isDirty = $state(false);
  let isSaving = $state(false);
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  // For rolloutTTL input
  let rolloutTTLValue = $state('');
  let rolloutTTLUnit: 'days' | 'permanent' = $state('days');

  // Reactive statement for disabling dependent fields
  let cacheFieldsDisabled = $derived(!currentCache.enabled);

  // Highlight setting effect
  $effect(() => {
    if (highlightSettingId) {
      highlightSetting(highlightSettingId);
      highlightSettingId = undefined;
    }
  });

  onMount(async () => {
    await loadSettings();
  });

  async function loadSettings() {
    try {
      const config = settingsConfig.getConfig();
      originalCache = { ...config.cache };
      currentCache = { ...config.cache };
      originalStorage = config.storage ? { ...config.storage } : {};
      currentStorage = config.storage ? { ...config.storage } : {};

      // Initialize rolloutTTL UI state
      if (currentStorage.rolloutTTL === 'permanent') {
        rolloutTTLUnit = 'permanent';
        rolloutTTLValue = '';
      } else if (typeof currentStorage.rolloutTTL === 'number') {
        rolloutTTLUnit = 'days';
        rolloutTTLValue = String(currentStorage.rolloutTTL);
      } else {
        // Default to 60 days
        rolloutTTLUnit = 'days';
        rolloutTTLValue = '60';
      }
    } catch (error) {
      console.error('[StorageSettings] Failed to load settings:', error);
      saveMessage = 'Failed to load settings';
      saveMessageType = 'error';
    }
  }

  function handleInput() {
    isDirty = true;
  }

  function handleRolloutTTLChange() {
    if (rolloutTTLUnit === 'permanent') {
      currentStorage.rolloutTTL = 'permanent';
    } else {
      const numValue = parseInt(rolloutTTLValue, 10);
      currentStorage.rolloutTTL = isNaN(numValue) ? 60 : numValue;
    }
    isDirty = true;
  }

  function handleBack() {
    onBack?.();
  }

  async function handleSave() {
    if (!isDirty) return;

    try {
      isSaving = true;

      // Update rolloutTTL based on current UI state
      if (rolloutTTLUnit === 'permanent') {
        currentStorage.rolloutTTL = 'permanent';
      } else {
        const numValue = parseInt(rolloutTTLValue, 10);
        currentStorage.rolloutTTL = isNaN(numValue) ? 60 : numValue;
      }

      await settingsConfig.updateConfig({
        cache: currentCache,
        storage: currentStorage,
      });

      // Notify backend of config update
      notifyConfigUpdate();

      originalCache = { ...currentCache };
      originalStorage = { ...currentStorage };
      isDirty = false;
      saveMessage = 'Settings saved successfully';
      saveMessageType = 'success';

      onSaved?.({ success: true });

      // Clear message after 3 seconds
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      console.error('[StorageSettings] Failed to save settings:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save settings: ${errorMsg}`;
      saveMessageType = 'error';

      onSaved?.({ success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="storage-settings">
  <button class="back-button" onclick={handleBack}>{@html '&#8592;'} {$_t("Back")}</button>

  <h2 class="settings-title">{$_t("Storage & Cache Settings")}</h2>

  <div class="settings-form">
    <!-- Cache Section -->
    <div class="section settings-card">
      <h3 class="section-title">{$_t("Cache Settings")}</h3>

      <!-- Cache Enabled Toggle -->
      <div class="form-group" data-setting-id="cache-enabled">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={currentCache.enabled}
            oninput={handleInput}
            class="form-checkbox"
          />
          <span>{$_t("Enable Cache")}</span>
        </label>
        <div class="help-text">{$_t("Enable caching to improve performance by storing frequently accessed data")}</div>
      </div>

      <!-- Cache TTL -->
      <div class="form-group">
        <label for="cache-ttl" class="form-label">{$_t("Cache TTL (seconds)")}</label>
        <input
          id="cache-ttl"
          type="number"
          min="1"
          bind:value={currentCache.ttl}
          oninput={handleInput}
          disabled={cacheFieldsDisabled}
          class="form-input"
          placeholder="3600"
        />
        <div class="help-text">{$_t("Time-to-live for cached items in seconds (default: 3600)")}</div>
      </div>

      <!-- Cache Max Size -->
      <div class="form-group">
        <label for="cache-maxsize" class="form-label">{$_t("Max Cache Size (MB)")}</label>
        <input
          id="cache-maxsize"
          type="number"
          min="1"
          bind:value={currentCache.maxSize}
          oninput={handleInput}
          disabled={cacheFieldsDisabled}
          class="form-input"
          placeholder="100"
        />
        <div class="help-text">{$_t("Maximum cache size in megabytes (default: 100)")}</div>
      </div>

      <!-- Compression Enabled -->
      <div class="form-group" data-setting-id="cache-compression-enabled">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={currentCache.compressionEnabled}
            oninput={handleInput}
            disabled={cacheFieldsDisabled}
            class="form-checkbox"
          />
          <span>{$_t("Enable Compression")}</span>
        </label>
        <div class="help-text">{$_t("Compress cached data to save storage space")}</div>
      </div>

      <!-- Persist to Storage -->
      <div class="form-group" data-setting-id="cache-persist-to-storage">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={currentCache.persistToStorage}
            oninput={handleInput}
            disabled={cacheFieldsDisabled}
            class="form-checkbox"
          />
          <span>{$_t("Persist Cache to Storage")}</span>
        </label>
        <div class="help-text">{$_t("Store cache data persistently across browser sessions")}</div>
      </div>
    </div>

    <!-- Storage Section -->
    <div class="section settings-card">
      <h3 class="section-title">{$_t("Storage Settings")}</h3>

      <!-- Rollout TTL -->
      <div class="form-group">
        <label for="rollout-ttl-unit" class="form-label">{$_t("Rollout Expiration")}</label>
        <select
          id="rollout-ttl-unit"
          bind:value={rolloutTTLUnit}
          onchange={handleRolloutTTLChange}
          class="form-select"
        >
          <option value="days">{$_t("Expire after days")}</option>
          <option value="permanent">{$_t("Never expire (permanent)")}</option>
        </select>
        <div class="help-text">{$_t("Set when rollout data should expire")}</div>
      </div>

      {#if rolloutTTLUnit === 'days'}
        <div class="form-group">
          <label for="rollout-ttl-value" class="form-label">{$_t("Days until expiration")}</label>
          <input
            id="rollout-ttl-value"
            type="number"
            min="1"
            bind:value={rolloutTTLValue}
            oninput={handleRolloutTTLChange}
            class="form-input"
            placeholder="60"
          />
          <div class="help-text">{$_t("Number of days before rollout data expires (default: 60)")}</div>
        </div>
      {/if}
    </div>

    <!-- Save Button -->
    <div class="button-group">
      <button
        class="btn btn-primary"
        onclick={handleSave}
        disabled={!isDirty || isSaving}
      >
        {isSaving ? $_t('Saving...') : $_t('Save Settings')}
      </button>
    </div>

    <!-- Save Message -->
    {#if saveMessage}
      <div class="message {saveMessageType}">
        {#if saveMessageType === 'success'}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <polyline points="20,6 9,17 4,12"></polyline>
          </svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        {/if}
        {saveMessage}
      </div>
    {/if}
  </div>
</div>

<style>
  .storage-settings {
    padding: 1.5rem;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--browserx-primary);
    cursor: pointer;
    font-size: 0.9375rem;
    font-weight: 500;
    padding: 0.5rem 0;
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    transition: opacity 0.2s;
  }

  .back-button:hover {
    opacity: 0.8;
  }

  .settings-title {
    margin: 0 0 1.5rem 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .settings-form {
    max-width: 600px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
  }

  .settings-card {
    background: var(--browserx-surface);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--browserx-border);
  }

  .section-title {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text);
  }

  .form-input {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    background: var(--browserx-surface);
    color: var(--browserx-text);
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .form-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background: color-mix(in srgb, var(--browserx-surface) 80%, var(--browserx-border));
  }

  .form-input:focus:not(:disabled) {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .form-select {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    background: var(--browserx-surface);
    color: var(--browserx-text);
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .form-select:focus {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9375rem;
    color: var(--browserx-text);
  }

  .checkbox-label input:disabled {
    cursor: not-allowed;
  }

  .form-checkbox {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--browserx-primary);
  }

  .form-checkbox:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .help-text {
    margin-top: 0.375rem;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
  }

  .button-group {
    margin-top: 2rem;
  }

  .btn {
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid var(--browserx-primary);
    background: transparent;
    color: var(--browserx-primary);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 15%, transparent);
  }

  /* Modern Chat theme - filled buttons */
  :global(.settings-modal-container.modern) .btn-primary {
    background: var(--browserx-primary);
    color: white;
    border: none;
  }

  :global(.settings-modal-container.modern) .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 85%, black);
  }

  .message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    margin-top: 1rem;
  }

  .message.success {
    color: var(--browserx-success);
    background: color-mix(in srgb, var(--browserx-success) 10%, transparent);
  }

  .message.error {
    color: var(--browserx-error);
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
  }
</style>
