<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IExtensionSettings, IPermissionSettings } from '@/config/types';
  import { _t, t } from '../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  let {
    settingsConfig,
    highlightSettingId = undefined,
    isDirty = $bindable(false),
    onBack,
    onSaved,
  }: {
    settingsConfig: AgentConfig;
    highlightSettingId?: string | undefined;
    isDirty?: boolean;
    onBack?: () => void;
    onSaved?: (detail: { success: boolean; error?: string }) => void;
  } = $props();

  // Form state
  let originalExtension: IExtensionSettings = $state({
    permissions: {}
  });
  let currentExtension: IExtensionSettings = $state({
    permissions: {}
  });
  let isSaving = $state(false);
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  // For allowed origins input
  let allowedOriginsText = $state('');

  // Desktop bridge card state (chrome.storage-backed, saved independently)
  const chromeAvailable = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  let bridgeEnabled = $state(false);
  let bridgeToken = $state('');
  let bridgeUrl = $state('ws://127.0.0.1:18101');
  let bridgeDirty = $state(false);
  let bridgeSaving = $state(false);
  let bridgeMessage = $state('');
  let bridgeMessageType: 'success' | 'error' | '' = $state('');
  let bridgeStatus = $state<{ status: string; lastError: string | null } | null>(null);
  let bridgeStatusListener:
    | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
    | null = null;
  let destroyed = false;

  async function loadBridgeCard() {
    if (!chromeAvailable) return;
    try {
      const { getBridgeSettings, BRIDGE_STATUS_KEY } = await import('@/extension/bridge/bridgeSettings');
      const settings = await getBridgeSettings();
      bridgeEnabled = settings.enabled;
      bridgeToken = settings.token;
      bridgeUrl = settings.url;

      const raw = await chrome.storage.session.get(BRIDGE_STATUS_KEY);
      bridgeStatus = (raw?.[BRIDGE_STATUS_KEY] as typeof bridgeStatus) ?? null;
      // The component may have unmounted while the async storage reads were
      // pending. Do not attach a listener that onDestroy can no longer remove.
      if (destroyed) return;
      bridgeStatusListener = (changes, area) => {
        if (area === 'session' && changes[BRIDGE_STATUS_KEY]) {
          bridgeStatus = (changes[BRIDGE_STATUS_KEY].newValue as typeof bridgeStatus) ?? null;
        }
      };
      chrome.storage.onChanged.addListener(bridgeStatusListener);
    } catch (error) {
      console.warn('[ExtensionSettings] Failed to load desktop bridge settings:', error);
    }
  }

  onDestroy(() => {
    destroyed = true;
    if (bridgeStatusListener && chromeAvailable) {
      chrome.storage.onChanged.removeListener(bridgeStatusListener);
      bridgeStatusListener = null;
    }
  });

  async function handleBridgeSave() {
    if (!chromeAvailable) return;
    try {
      bridgeSaving = true;
      const { setBridgeSettings } = await import('@/extension/bridge/bridgeSettings');
      const token = bridgeToken.trim();
      await setBridgeSettings({
        enabled: bridgeEnabled,
        token,
        url: bridgeUrl.trim(),
        // Native messaging is zero-pairing on macOS/Linux. Entering a token
        // explicitly selects the direct-WS fallback, including on Windows
        // where native-host registry installation is not bundled yet.
        transport: token ? 'ws' : 'native',
      });
      bridgeDirty = false;
      bridgeMessage = 'Desktop bridge settings saved';
      bridgeMessageType = 'success';
      setTimeout(() => {
        bridgeMessage = '';
        bridgeMessageType = '';
      }, 3000);
    } catch (error) {
      bridgeMessage = `Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}`;
      bridgeMessageType = 'error';
    } finally {
      bridgeSaving = false;
    }
  }

  // Returns already-translated text (static keys so extract-i18n finds them).
  function bridgeStatusLabel(status: string | undefined): string {
    switch (status) {
      case 'connected':
        return t('Connected to WorkX Desktop');
      case 'connecting':
        return t('Connecting…');
      case 'error':
        return t('Connection failed');
      default:
        return t('Not connected (bridge disabled)');
    }
  }

  $effect(() => {
    if (highlightSettingId) {
      highlightSetting(highlightSettingId);
      highlightSettingId = undefined;
    }
  });

  onMount(async () => {
    await loadSettings();
    await loadBridgeCard();
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
    onBack?.();
  }

  async function handleSave() {
    if (!isDirty) return;

    try {
      isSaving = true;

      // Update allowed origins from text area
      handleOriginsInput();

      await settingsConfig.updateConfig({ extension: currentExtension });

      // Notify backend of config update
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(e => console.warn('[messaging] config update failed:', e));

      originalExtension = { ...currentExtension };
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
      console.error('[ExtensionSettings] Failed to save settings:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save settings: ${errorMsg}`;
      saveMessageType = 'error';

      onSaved?.({ success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="extension-settings">
  <button class="back-button" onclick={handleBack}>← {$_t("Back")}</button>

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
            oninput={handleInput}
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
            oninput={handleInput}
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
          oninput={handleInput}
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
          oninput={handleInput}
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
          oninput={handleOriginsInput}
          class="form-textarea"
          rows="5"
          placeholder="https://example.com&#10;https://api.example.com&#10;https://*.example.org"
        ></textarea>
        <div class="help-text">{$_t("List of allowed origins (one per line). Supports wildcards (*).")}</div>
      </div>
    </div>

    <!-- Desktop Bridge Section -->
    {#if chromeAvailable}
      <div class="section settings-card">
        <h3 class="section-title">{$_t("Desktop Bridge")}</h3>
        <div class="help-text" style="margin-bottom: 0.75rem;">
          {$_t("Let the WorkX desktop app use this browser as its browser tool. Leave the token blank for automatic native connection on macOS/Linux; paste a desktop pairing token for the WebSocket fallback (including Windows).")}
        </div>

        <div class="form-group" data-setting-id="bridge-enabled">
          <label class="checkbox-label">
            <input
              type="checkbox"
              bind:checked={bridgeEnabled}
              oninput={() => (bridgeDirty = true)}
              class="form-checkbox"
            />
            <span>{$_t("Enable Desktop Bridge")}</span>
          </label>
        </div>

        <div class="form-group" data-setting-id="bridge-token">
          <label for="bridge-token" class="form-label">{$_t("Pairing Token")}</label>
          <input
            id="bridge-token"
            type="password"
            bind:value={bridgeToken}
            oninput={() => (bridgeDirty = true)}
            class="form-input"
            placeholder={$_t("Paste the token from WorkX Desktop → Settings → Tools")}
            autocomplete="off"
          />
          <div class="help-text">{$_t("A non-empty token selects the direct WebSocket fallback; clearing it selects native messaging.")}</div>
        </div>

        <div class="form-group" data-setting-id="bridge-url">
          <label for="bridge-url" class="form-label">{$_t("Desktop App URL")}</label>
          <input
            id="bridge-url"
            type="text"
            bind:value={bridgeUrl}
            oninput={() => (bridgeDirty = true)}
            class="form-input"
            placeholder="ws://127.0.0.1:18101"
          />
          <div class="help-text">{$_t("Only change this if the desktop app-server uses a non-default port.")}</div>
        </div>

        <div class="form-group">
          <div class="help-text">
            <strong>{$_t("Status")}:</strong>
            {bridgeStatusLabel(bridgeStatus?.status)}
            {#if bridgeStatus?.status === 'error' && bridgeStatus?.lastError}
              — {bridgeStatus.lastError}
            {/if}
          </div>
        </div>

        <div class="button-group">
          <button class="btn btn-primary" onclick={handleBridgeSave} disabled={!bridgeDirty || bridgeSaving}>
            {bridgeSaving ? $_t('Saving...') : $_t('Save Bridge Settings')}
          </button>
        </div>

        {#if bridgeMessage}
          <div class="message {bridgeMessageType}">{bridgeMessage}</div>
        {/if}
      </div>
    {/if}

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
  .extension-settings {
    padding: 1.5rem;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--workx-primary);
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
    color: var(--workx-text);
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
    background: var(--workx-surface);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--workx-border);
  }

  .section-title {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--workx-text);
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--workx-text);
  }

  .form-input {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.375rem;
    background: var(--workx-surface);
    color: var(--workx-text);
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--workx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--workx-primary) 10%, transparent);
  }

  .form-textarea {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.375rem;
    background: var(--workx-surface);
    color: var(--workx-text);
    font-size: 0.875rem;
    font-family: 'Courier New', Courier, monospace;
    resize: vertical;
    transition: all 0.2s;
  }

  .form-textarea:focus {
    outline: none;
    border-color: var(--workx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--workx-primary) 10%, transparent);
  }

  .form-select {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.375rem;
    background: var(--workx-surface);
    color: var(--workx-text);
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .form-select:focus {
    outline: none;
    border-color: var(--workx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--workx-primary) 10%, transparent);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9375rem;
    color: var(--workx-text);
  }

  .form-checkbox {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--workx-primary);
  }

  .help-text {
    margin-top: 0.375rem;
    font-size: 0.875rem;
    color: var(--workx-text-secondary);
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
    border: 1px solid var(--workx-primary);
    background: transparent;
    color: var(--workx-primary);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--workx-primary) 15%, transparent);
  }

  /* Modern Chat theme - filled buttons */
  :global(.settings-modal-container.modern) .btn-primary {
    background: var(--workx-primary);
    color: white;
    border: none;
  }

  :global(.settings-modal-container.modern) .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--workx-primary) 85%, black);
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
    color: var(--workx-success);
    background: color-mix(in srgb, var(--workx-success) 10%, transparent);
  }

  .message.error {
    color: var(--workx-error);
    background: color-mix(in srgb, var(--workx-error) 10%, transparent);
  }
</style>
