<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IExtensionSettings, IPermissionSettings } from '@/config/types';
  import { _t } from '../lib/i18n';
  import { notifyConfigUpdate } from '../lib/messaging';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  export let settingsConfig: AgentConfig;
  export let highlightSettingId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // Form state
  let originalExtension: IExtensionSettings = {
    permissions: {}
  };
  let currentExtension: IExtensionSettings = {
    permissions: {}
  };
  let isDirty = false;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // For allowed origins input
  let allowedOriginsText = '';

  $: if (highlightSettingId) {
    highlightSetting(highlightSettingId);
    highlightSettingId = undefined;
  }

  onMount(async () => {
    await loadSettings();
  });

  async function loadSettings() {
    try {
      const config = settingsConfig.getConfig();
      originalExtension = { ...config.extension };
      currentExtension = { ...config.extension };

      // Ensure permissions object exists
      if (!currentExtension.permissions) {
        currentExtension.permissions = {};
      }

      // Initialize allowed origins text area
      if (currentExtension.allowedOrigins && Array.isArray(currentExtension.allowedOrigins)) {
        allowedOriginsText = currentExtension.allowedOrigins.join('\n');
      } else {
        allowedOriginsText = '';
      }
    } catch (error) {
      console.error('[ExtensionSettings] Failed to load settings:', error);
      saveMessage = 'Failed to load settings';
      saveMessageType = 'error';
    }
  }

  function handleInput() {
    isDirty = true;
  }

  function handleOriginsInput() {
    // Parse textarea into array (one origin per line)
    const origins = allowedOriginsText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    currentExtension.allowedOrigins = origins;
    isDirty = true;
  }

  function handleBack() {
    dispatch('back');
  }

  async function handleSave() {
    if (!isDirty) return;

    try {
      isSaving = true;

      // Update allowed origins from text area
      handleOriginsInput();

      await settingsConfig.updateConfig({ extension: currentExtension });

      // Notify backend of config update
      notifyConfigUpdate();

      originalExtension = { ...currentExtension };
      isDirty = false;
      saveMessage = 'Settings saved successfully';
      saveMessageType = 'success';

      dispatch('saved', { success: true });

      // Clear message after 3 seconds
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      console.error('[ExtensionSettings] Failed to save settings:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save settings: ${errorMsg}`;
      saveMessageType = 'error';

      dispatch('saved', { success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="extension-settings">
  <button class="back-button" on:click={handleBack}>← {$_t("Back")}</button>

  <h2 class="settings-title">{$_t("Extension & Permission Settings")}</h2>

  <div class="settings-form">
    <!-- Extension Configuration Section -->
    <div class="section settings-card">
      <h3 class="section-title">{$_t("Extension Configuration")}</h3>

      <!-- Extension Enabled -->
      <div class="form-group" data-setting-id="extension-enabled">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={currentExtension.enabled}
            on:input={handleInput}
            class="form-checkbox"
          />
          <span>{$_t("Enable Extension")}</span>
        </label>
        <div class="help-text">{$_t("Master toggle to enable or disable the extension")}</div>
      </div>

      <!-- Content Script Enabled -->
      <div class="form-group" data-setting-id="content-script-enabled">
        <label class="checkbox-label">
          <input
            type="checkbox"
            bind:checked={currentExtension.contentScriptEnabled}
            on:input={handleInput}
            class="form-checkbox"
          />
          <span>{$_t("Enable Content Scripts")}</span>
        </label>
        <div class="help-text">{$_t("Allow content scripts to run on web pages")}</div>
      </div>

      <!-- Update Channel -->
      <div class="form-group">
        <label for="update-channel" class="form-label">{$_t("Update Channel")}</label>
        <select
          id="update-channel"
          bind:value={currentExtension.updateChannel}
          on:input={handleInput}
          class="form-select"
        >
          <option value="stable">{$_t("Stable")}</option>
          <option value="beta">{$_t("Beta")}</option>
        </select>
        <div class="help-text">{$_t("Choose which update channel to follow")}</div>
      </div>

      <!-- Storage Quota Warning -->
      <div class="form-group">
        <label for="storage-quota" class="form-label">{$_t("Storage Quota Warning (%)")}</label>
        <input
          id="storage-quota"
          type="number"
          min="50"
          max="100"
          bind:value={currentExtension.storageQuotaWarning}
          on:input={handleInput}
          class="form-input"
          placeholder="90"
        />
        <div class="help-text">{$_t("Show warning when storage usage exceeds this percentage (default: 90%)")}</div>
      </div>

      <!-- Allowed Origins -->
      <div class="form-group">
        <label for="allowed-origins" class="form-label">{$_t("Allowed Origins")}</label>
        <textarea
          id="allowed-origins"
          bind:value={allowedOriginsText}
          on:input={handleOriginsInput}
          class="form-textarea"
          rows="5"
          placeholder="https://example.com&#10;https://api.example.com&#10;https://*.example.org"
        ></textarea>
        <div class="help-text">{$_t("List of allowed origins (one per line). Supports wildcards (*).")}</div>
      </div>
    </div>

    <!-- Save Button -->
    <div class="button-group">
      <button
        class="btn btn-primary"
        on:click={handleSave}
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
  .extension-settings {
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

  .form-input:focus {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .form-textarea {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    background: var(--browserx-surface);
    color: var(--browserx-text);
    font-size: 0.875rem;
    font-family: 'Courier New', Courier, monospace;
    resize: vertical;
    transition: all 0.2s;
  }

  .form-textarea:focus {
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

  .form-checkbox {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--browserx-primary);
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
