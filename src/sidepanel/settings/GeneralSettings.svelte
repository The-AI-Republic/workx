<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '../../config/AgentConfig';
  import type { IUserPreferences } from '../../config/types';

  export let settingsConfig: AgentConfig;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // Form state
  let originalPreferences: IUserPreferences = {};
  let currentPreferences: IUserPreferences = {};
  let isDirty = false;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  onMount(async () => {
    await loadPreferences();
  });

  async function loadPreferences() {
    try {
      const config = settingsConfig.getConfig();
      originalPreferences = { ...config.preferences };
      currentPreferences = { ...config.preferences };
    } catch (error) {
      console.error('[GeneralSettings] Failed to load preferences:', error);
      saveMessage = 'Failed to load preferences';
      saveMessageType = 'error';
    }
  }

  function handleInput() {
    isDirty = true;
  }

  function handleBack() {
    dispatch('back');
  }

  async function handleSave() {
    if (!isDirty) return;

    try {
      isSaving = true;
      await settingsConfig.updateConfig({ preferences: currentPreferences });

      // Send CONFIG_UPDATE message
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {
        console.warn('[GeneralSettings] Failed to notify service worker');
      });

      originalPreferences = { ...currentPreferences };
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
      console.error('[GeneralSettings] Failed to save preferences:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save settings: ${errorMsg}`;
      saveMessageType = 'error';

      dispatch('saved', { success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="general-settings">
  <button class="back-button" on:click={handleBack}>← Back</button>

  <h2 class="settings-title">General Settings</h2>

  <div class="settings-form">
    <!-- Theme Selection - DISABLED (not currently supported) -->
    <!-- <div class="form-group">
      <label for="theme" class="form-label">Theme</label>
      <select
        id="theme"
        bind:value={currentPreferences.theme}
        on:input={handleInput}
        class="form-select"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <div class="help-text">Choose your preferred color theme</div>
    </div> -->

    <!-- Telemetry Toggle -->
    <div class="form-group">
      <label class="checkbox-label">
        <input
          type="checkbox"
          bind:checked={currentPreferences.telemetryEnabled}
          on:input={handleInput}
          class="form-checkbox"
        />
        <span>Enable Telemetry</span>
      </label>
      <div class="help-text">Help improve the extension by sending anonymous usage data</div>
    </div>

    <!-- Auto-sync Toggle -->
    <div class="form-group">
      <label class="checkbox-label">
        <input
          type="checkbox"
          bind:checked={currentPreferences.autoSync}
          on:input={handleInput}
          class="form-checkbox"
        />
        <span>Auto-sync Settings</span>
      </label>
      <div class="help-text">Automatically sync settings across devices (when available)</div>
    </div>

    <!-- Save Button -->
    <div class="button-group">
      <button
        class="btn btn-primary"
        on:click={handleSave}
        disabled={!isDirty || isSaving}
      >
        {isSaving ? 'Saving...' : 'Save Settings'}
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
  .general-settings {
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
    font-size: 0.8125rem;
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
    border: none;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--browserx-primary);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 90%, black);
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
