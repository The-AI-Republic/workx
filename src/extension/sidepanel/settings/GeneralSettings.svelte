<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IUserPreferences } from '@/config/types';
  import { uiTheme, type UITheme } from '../stores/themeStore';
  import { showTokenUsage } from '../stores/tokenUsageStore';
  import Switch from '../components/common/Switch.svelte';
  import { t, _t, getCurrentLocale, setLocale } from '../lib/i18n';
  import supportedLanguages from '../../../../_locales/supported_languages.json';
  import { sendMessage, notifyConfigUpdate, MessageType } from '../lib/messaging';
  import { platform } from '../stores/platformStore';

  export let settingsConfig: AgentConfig;
  export let highlightSettingId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // Form state
  let originalPreferences: IUserPreferences = {};
  let currentPreferences: IUserPreferences = {};
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Language state
  let selectedLanguage = getCurrentLocale();
  let browserLanguage = getCurrentLocale();

  $: if (highlightSettingId) {
    (async () => {
      await tick();
      const el = document.getElementById(highlightSettingId) ||
                 document.querySelector(`[data-setting-id="${highlightSettingId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const target = el.closest('.settings-card') || el.closest('.form-group') || el;
        target.classList.add('highlight-pulse');
        setTimeout(() => target.classList.remove('highlight-pulse'), 1500);
      }
      highlightSettingId = undefined;
    })();
  }

  // Theme options - reactive to locale changes
  $: themeOptions = [
    {
      value: 'terminal' as UITheme,
      label: $_t('Terminal'),
      description: $_t('Classic terminal style with green text on black background')
    },
    {
      value: 'chatgpt' as UITheme,
      label: $_t('Modern Chat'),
      description: $_t('Clean, modern chat interface similar to ChatGPT')
    }
  ];

  onMount(async () => {
    await loadPreferences();
  });

  async function loadPreferences() {
    try {
      const config = settingsConfig.getConfig();
      originalPreferences = { ...config.preferences };
      currentPreferences = { ...config.preferences };

      // Load language preference or use browser language as default
      selectedLanguage = currentPreferences.language || browserLanguage;

      // Initialize locale from saved preference
      if (currentPreferences.language) {
        setLocale(currentPreferences.language);
      }
    } catch (error) {
      console.error('[GeneralSettings] Failed to load preferences:', error);
      saveMessage = t('Failed to load preferences');
      saveMessageType = 'error';
    }
  }

  async function autoSave() {
    if (isSaving) return;

    try {
      isSaving = true;
      await settingsConfig.updateConfig({ preferences: currentPreferences });

      // Notify backend of config update
      notifyConfigUpdate();

      originalPreferences = { ...currentPreferences };
      saveMessage = t('Settings saved successfully');
      saveMessageType = 'success';

      dispatch('saved', { success: true });

      // Clear message after 3 seconds
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      console.error('[GeneralSettings] Failed to save preferences:', error);
      const errorMsg = error instanceof Error ? error.message : t('Unknown error');
      saveMessage = t('Failed to save settings') + `: ${errorMsg}`;
      saveMessageType = 'error';

      dispatch('saved', { success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }

  function handleThemeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const newTheme = target.value as UITheme;
    currentPreferences.uiTheme = newTheme;

    // Apply theme immediately
    uiTheme.setTheme(newTheme);

    autoSave();
  }

  function handleShowTokenUsageChange(event: CustomEvent<boolean>) {
    const show = event.detail;
    currentPreferences.showTokenUsage = show;

    // Apply immediately
    showTokenUsage.setShowTokenUsage(show);

    autoSave();
  }

  // Feature 015: Handle max concurrent sessions change
  function handleMaxSessionsChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const value = parseInt(target.value, 10);
    currentPreferences.maxConcurrentSessions = value;

    // Notify backend to update AgentRegistry limit
    sendMessage(MessageType.SET_MAX_CONCURRENT_SESSIONS, { maxConcurrent: value }).catch(() => {
      console.warn('[GeneralSettings] Failed to update max concurrent sessions');
    });

    autoSave();
  }

  function handleLanguageChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    selectedLanguage = target.value;
    currentPreferences.language = selectedLanguage;

    // Apply language change immediately
    setLocale(selectedLanguage);

    autoSave();
  }

  async function handleAutoStartChange(event: CustomEvent<boolean>) {
    const enabled = event.detail;
    currentPreferences.autoStartEnabled = enabled;

    // Sync OS-level autostart state immediately
    try {
      const { initializeAutoStart } = await import('@/desktop/autostart');
      await initializeAutoStart(enabled);
    } catch (error) {
      console.warn('[GeneralSettings] Failed to update auto-start:', error);
    }

    autoSave();
  }

  function handleBack() {
    dispatch('back');
  }
</script>

<div class="general-settings">
  <button class="back-button" on:click={handleBack}>← {$_t("Back")}</button>

  <h2 class="settings-title">{$_t("General Settings")}</h2>

  <div class="settings-form">
    <!-- UI Theme Selection -->
    <div class="settings-card" data-setting-id="uiTheme">
      <div class="form-group">
        <label for="uiTheme" class="form-label">{$_t("UI Theme")}</label>
        <div class="theme-options">
          {#each themeOptions as option}
            <label class="theme-option" class:selected={currentPreferences.uiTheme === option.value}>
              <input
                type="radio"
                name="uiTheme"
                value={option.value}
                checked={currentPreferences.uiTheme === option.value}
                on:change={handleThemeChange}
                class="theme-radio"
              />
              <div class="theme-option-content">
                <div class="theme-option-preview {option.value}">
                  {#if option.value === 'terminal'}
                    <div class="preview-terminal">
                      <span class="preview-prompt">&gt;&gt;</span>
                      <span class="preview-text">_</span>
                    </div>
                  {:else}
                    <div class="preview-chat">
                      <div class="preview-bubble user"></div>
                      <div class="preview-bubble agent"></div>
                    </div>
                  {/if}
                </div>
                <div class="theme-option-info">
                  <span class="theme-option-label">{option.label}</span>
                  <span class="theme-option-desc">{option.description}</span>
                </div>
              </div>
            </label>
          {/each}
        </div>
        <div class="help-text">{$_t("Choose the visual style for the side panel interface")}</div>
      </div>
    </div>

    <!-- Show Token Usage Toggle -->
    <div class="settings-card" data-setting-id="showTokenUsage">
      <div class="form-group">
        <div class="switch-row">
          <div class="switch-label">
            <span class="switch-title">{$_t("Show token usage in tasks")}</span>
            <span class="switch-description">{$_t("Display token consumption (input/output tokens) when tasks complete")}</span>
          </div>
          <Switch
            state={currentPreferences.showTokenUsage ?? false}
            on:change={handleShowTokenUsageChange}
          />
        </div>
      </div>
    </div>

    <!-- Auto-Start on Login Toggle (desktop only) -->
    {#if platform.hasAutoStart}
    <div class="settings-card">
      <div class="form-group">
        <div class="switch-row">
          <div class="switch-label">
            <span class="switch-title">{$_t("Start on login")}</span>
            <span class="switch-description">{$_t("Automatically start the app when you log in to your computer")}</span>
          </div>
          <Switch
            state={currentPreferences.autoStartEnabled ?? false}
            on:change={handleAutoStartChange}
          />
        </div>
      </div>
    </div>
    {/if}

    <!-- Language Selection -->
    <div class="settings-card">
      <div class="form-group">
        <label for="language" class="form-label">{$_t("Language")}</label>
        <select
          id="language"
          value={selectedLanguage}
          on:change={handleLanguageChange}
          class="form-select"
        >
          {#each supportedLanguages as lang}
            <option value={lang.code}>{lang.title}</option>
          {/each}
        </select>
        <div class="help-text">{$_t("Select your preferred language for the interface")}</div>
      </div>
    </div>

    <!-- Max Concurrent Sessions (Feature 015) -->
    <div class="settings-card">
      <div class="form-group">
        <label for="maxSessions" class="form-label">{$_t("Max Concurrent Sessions")}</label>
        <select
          id="maxSessions"
          value={currentPreferences.maxConcurrentSessions ?? 3}
          on:change={handleMaxSessionsChange}
          class="form-select"
        >
          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as num}
            <option value={num}>{num} {num === 1 ? $_t("session") : $_t("sessions")}</option>
          {/each}
        </select>
        <div class="help-text">{$_t("Maximum number of parallel agent sessions, including scheduled tasks")}</div>
      </div>
    </div>

    <!-- Color Theme Selection - DISABLED (future feature) -->
    <!-- <div class="form-group">
      <label for="theme" class="form-label">Color Theme</label>
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
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .settings-card {
    background: var(--browserx-surface);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--browserx-border);
  }

  .form-group {
    margin-bottom: 0;
  }

  .form-group:not(:last-child) {
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

  .language-note {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
    background: color-mix(in srgb, var(--browserx-primary) 5%, transparent);
    border-radius: 0.375rem;
    border-left: 3px solid var(--browserx-primary);
  }

  .language-note svg {
    flex-shrink: 0;
    opacity: 0.7;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .switch-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .switch-title {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--browserx-text);
  }

  .switch-description {
    font-size: 0.8125rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
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

  .placeholder-message {
    padding: 2rem;
    text-align: center;
    background: var(--browserx-surface);
    border: 1px dashed var(--browserx-border);
    border-radius: 0.5rem;
    margin: 2rem 0;
  }

  .placeholder-message p {
    margin: 0 0 0.75rem 0;
    color: var(--browserx-text);
    font-size: 0.9375rem;
  }

  .placeholder-note {
    color: var(--browserx-text-secondary);
    font-size: 0.8125rem;
  }

  /* Theme Option Styles */
  .theme-options {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .theme-option {
    flex: 1;
    position: relative;
    cursor: pointer;
    border: 2px solid var(--browserx-border);
    border-radius: 0.75rem;
    overflow: hidden;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .theme-option:hover {
    border-color: var(--browserx-primary);
  }

  .theme-option.selected {
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 20%, transparent);
  }

  .theme-radio {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .theme-option-content {
    display: flex;
    flex-direction: column;
  }

  .theme-option-preview {
    height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.75rem;
  }

  .theme-option-preview.terminal {
    background-color: #000000;
  }

  .theme-option-preview.chatgpt {
    background-color: #f7f7f8;
  }

  .preview-terminal {
    font-family: 'Monaco', 'Consolas', monospace;
    font-size: 0.875rem;
    color: #00ff00;
  }

  .preview-prompt {
    margin-right: 0.25rem;
  }

  .preview-text {
    animation: blink 1s infinite;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  .preview-chat {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    padding: 0 0.5rem;
  }

  .preview-bubble {
    height: 12px;
    border-radius: 0.75rem;
  }

  .preview-bubble.user {
    width: 60%;
    align-self: flex-end;
    background-color: #60a5fa;
  }

  .preview-bubble.agent {
    width: 80%;
    align-self: flex-start;
    background-color: #e5e5e5;
  }

  .theme-option-info {
    padding: 0.75rem;
    background: var(--browserx-surface);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .theme-option-label {
    font-weight: 600;
    font-size: 0.9375rem;
    color: var(--browserx-text);
  }

  .theme-option-desc {
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
  }

  @keyframes highlightPulse {
    0%, 100% { background-color: transparent; }
    25%, 75% { background-color: color-mix(in srgb, var(--browserx-primary) 15%, transparent); }
  }

  :global(.highlight-pulse) {
    animation: highlightPulse 0.75s ease-in-out 2;
  }
</style>
