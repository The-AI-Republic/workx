<script lang="ts">
  import { onMount } from 'svelte';
  import { AgentConfig } from '@/config/AgentConfig';
  import type { IUserPreferences } from '@/config/types';
  import { uiTheme, themePreference, type ThemePreference } from '../stores/themeStore';
  import { showTokenUsage } from '../stores/tokenUsageStore';
  import Switch from '../components/common/Switch.svelte';
  import { t, _t, getCurrentLocale, setLocale } from '../lib/i18n';
  import supportedLanguages from '../../../_locales/supported_languages.json';
  import { getInitializedUIClient } from '@/core/messaging';
  import { platform } from '../stores/platformStore';
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

  // Theme
  let currentTheme = $derived($uiTheme);

  // Form state
  let originalPreferences: IUserPreferences = {};
  let currentPreferences: IUserPreferences = $state({});
  let isSaving = $state(false);
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  // Language state
  let selectedLanguage = $state(getCurrentLocale());
  let browserLanguage = getCurrentLocale();

  $effect(() => {
    if (highlightSettingId) {
      highlightSetting(highlightSettingId);
      highlightSettingId = undefined;
    }
  });

  // Theme options - reactive to locale changes
  let themeOptions = $derived([
    {
      value: 'terminal' as ThemePreference,
      label: $_t('Terminal'),
      description: $_t('Green text terminal')
    },
    {
      value: 'modern-auto' as ThemePreference,
      label: $_t('Modern Chat Auto'),
      description: $_t('Follows system theme')
    },
    {
      value: 'modern-light' as ThemePreference,
      label: $_t('Modern Chat Light'),
      description: $_t('Always light')
    },
    {
      value: 'modern-dark' as ThemePreference,
      label: $_t('Modern Chat Dark'),
      description: $_t('Always dark')
    }
  ]);

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

      // Settings uses an isolated AgentConfig instance, so saving here does not
      // update the shared singleton that the chat/scheduler views read from
      // (AgentConfig.getInstance()). Without this refresh those views re-run
      // themePreference.initialize(...) with the STALE in-memory preferences on
      // their next mount, making the theme "bounce back" when settings close.
      try {
        const shared = await AgentConfig.getInstance();
        await shared.reload();
      } catch (e) {
        console.warn('[GeneralSettings] Failed to refresh shared config after save:', e);
      }

      // Notify backend of config update
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(e => console.warn('[messaging] config update failed:', e));

      originalPreferences = { ...currentPreferences };
      saveMessage = t('Settings saved successfully');
      saveMessageType = 'success';

      onSaved?.({ success: true });

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

      onSaved?.({ success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }

  function handleThemeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const newTheme = target.value as ThemePreference;
    currentPreferences.uiTheme = newTheme;

    // Apply theme immediately
    themePreference.setTheme(newTheme);

    autoSave();
  }

  function handleShowTokenUsageChange(show: boolean) {
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

    // Notify backend to update SessionManager limit
    getInitializedUIClient().then(c => c.serviceRequest('session.setMaxConcurrent', { maxConcurrent: value })).catch(() => {
      console.warn('[GeneralSettings] Failed to update max concurrent sessions');
    });
  }

  // Default working folder for NEW desktop sessions. Existing sessions retain
  // their own captured folder; empty leaves new sessions without a folder.
  function handleWorkspaceRootChange(event: Event) {
    const v = (event.target as HTMLInputElement).value.trim();
    currentPreferences.workspaceRoot = v.length ? v : undefined;
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

  async function handleAutoStartChange(enabled: boolean) {
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
    onBack?.();
  }
</script>

<div class="p-6">
  <button
    class="bg-transparent border-none cursor-pointer text-sm font-medium py-2 px-0 mb-4 flex items-center gap-1 transition-opacity duration-200 hover:opacity-80
      {currentTheme === 'modern'
        ? 'font-chat text-chat-primary dark:text-chat-primary-dark'
        : 'font-terminal text-term-green'}"
    onclick={handleBack}
  >← {$_t("Back")}</button>

  <h2 class="m-0 mb-6 text-2xl font-semibold
    {currentTheme === 'modern'
      ? 'font-chat text-chat-text dark:text-chat-text-dark'
      : 'font-terminal text-term-green'}"
  >{$_t("General Settings")}</h2>

  <div class="max-w-[600px] flex flex-col gap-3">
    <!-- UI Theme Selection -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
      data-setting-id="uiTheme"
    >
      <div>
        <label
          for="uiTheme"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("UI Theme")}</label>
        <div class="grid grid-cols-2 gap-3 mb-2">
          {#each themeOptions as option}
            <label
              class="relative cursor-pointer rounded-xl overflow-hidden transition-all duration-200
                {currentPreferences.uiTheme === option.value
                  ? (currentTheme === 'modern'
                    ? 'border-2 border-chat-primary dark:border-chat-primary-dark shadow-[0_0_0_3px_rgba(96,165,250,0.2)]'
                    : 'border-2 border-term-green shadow-[0_0_0_3px_rgba(0,255,0,0.2)]')
                  : (currentTheme === 'modern'
                    ? 'border-2 border-chat-border dark:border-chat-border-dark hover:border-chat-primary dark:hover:border-chat-primary-dark'
                    : 'border-2 border-term-dim-green hover:border-term-green')}"
            >
              <input
                type="radio"
                name="uiTheme"
                value={option.value}
                checked={currentPreferences.uiTheme === option.value}
                onchange={handleThemeChange}
                class="absolute opacity-0 w-0 h-0"
              />
              <div class="flex flex-col">
                <!-- Preview area -->
                <div
                  class="h-16 flex items-center justify-center p-2
                    {option.value === 'terminal' ? 'bg-black' :
                     option.value === 'modern-dark' ? 'bg-[#212121]' :
                     option.value === 'modern-light' ? 'bg-[#f7f7f8]' :
                     'bg-gradient-to-r from-[#f7f7f8] to-[#212121]'}"
                >
                  {#if option.value === 'terminal'}
                    <div class="font-terminal text-xs text-[#00ff00]">
                      <span class="mr-1">&gt;&gt;</span>
                      <span class="animate-blink">_</span>
                    </div>
                  {:else if option.value === 'modern-auto'}
                    <div class="flex items-center gap-1.5">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                      <span class="text-[#9ca3af] text-xs">/</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                    </div>
                  {:else if option.value === 'modern-light'}
                    <div class="flex flex-col gap-1.5 w-full px-2">
                      <div class="h-2.5 rounded-lg w-3/5 self-end bg-[#60a5fa]"></div>
                      <div class="h-2.5 rounded-lg w-4/5 self-start bg-[#e5e5e5]"></div>
                    </div>
                  {:else}
                    <div class="flex flex-col gap-1.5 w-full px-2">
                      <div class="h-2.5 rounded-lg w-3/5 self-end bg-[#60a5fa]"></div>
                      <div class="h-2.5 rounded-lg w-4/5 self-start bg-[#3e3e3e]"></div>
                    </div>
                  {/if}
                </div>
                <!-- Label area -->
                <div
                  class="p-2.5 flex flex-col gap-0.5
                    {currentTheme === 'modern'
                      ? 'bg-chat-surface dark:bg-chat-surface-dark'
                      : 'bg-term-bg'}"
                >
                  <span class="font-semibold text-sm
                    {currentTheme === 'modern'
                      ? 'font-chat text-chat-text dark:text-chat-text-dark'
                      : 'font-terminal text-term-green'}"
                  >{option.label}</span>
                  <span class="text-meta font-normal
                    {currentTheme === 'modern'
                      ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                      : 'font-terminal text-term-dim-green'}"
                  >{option.description}</span>
                </div>
              </div>
            </label>
          {/each}
        </div>
        <div class="mt-1.5 text-sm leading-ui
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Choose the visual style for the side panel interface")}</div>
      </div>
    </div>

    <!-- Show Token Usage Toggle -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
      data-setting-id="showTokenUsage"
    >
      <div>
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text dark:text-chat-text-dark'
                : 'font-terminal text-term-green'}"
            >{$_t("Show token usage in tasks")}</span>
            <span class="text-sm leading-ui
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                : 'font-terminal text-term-dim-green'}"
            >{$_t("Display token consumption (input/output tokens) when tasks complete")}</span>
          </div>
          <Switch
            state={currentPreferences.showTokenUsage ?? false}
            onChange={handleShowTokenUsageChange}
          />
        </div>
      </div>
    </div>

    <!-- Auto-Start on Login Toggle (desktop only) -->
    {#if platform.hasAutoStart}
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text dark:text-chat-text-dark'
                : 'font-terminal text-term-green'}"
            >{$_t("Start on login")}</span>
            <span class="text-sm leading-ui
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                : 'font-terminal text-term-dim-green'}"
            >{$_t("Automatically start the app when you log in to your computer")}</span>
          </div>
          <Switch
            state={currentPreferences.autoStartEnabled ?? false}
            onChange={handleAutoStartChange}
          />
        </div>
      </div>
    </div>
    {/if}

    <!-- Language Selection -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <label
          for="language"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("Language")}</label>
        <select
          id="language"
          value={selectedLanguage}
          onchange={handleLanguageChange}
          class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200
            {currentTheme === 'modern'
              ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark focus:ring-3 focus:ring-chat-primary/10 dark:focus:ring-chat-primary-dark/10'
              : 'font-terminal bg-term-bg text-term-green border border-term-dim-green focus:outline-none focus:border-term-bright-green focus:ring-3 focus:ring-term-green/10'}"
        >
          {#each supportedLanguages as lang}
            <option value={lang.code}>{lang.title}</option>
          {/each}
        </select>
        <div class="mt-1.5 text-sm leading-ui
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Select your preferred language for the interface")}</div>
      </div>
    </div>

    <!-- Max Concurrent Sessions (Feature 015) -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <label
          for="maxSessions"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("Max Concurrent Sessions")}</label>
        <select
          id="maxSessions"
          value={currentPreferences.maxConcurrentSessions ?? 3}
          onchange={handleMaxSessionsChange}
          class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200
            {currentTheme === 'modern'
              ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark focus:ring-3 focus:ring-chat-primary/10 dark:focus:ring-chat-primary-dark/10'
              : 'font-terminal bg-term-bg text-term-green border border-term-dim-green focus:outline-none focus:border-term-bright-green focus:ring-3 focus:ring-term-green/10'}"
        >
          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as num}
            <option value={num}>{num} {num === 1 ? $_t("session") : $_t("sessions")}</option>
          {/each}
        </select>
        <div class="mt-1.5 text-sm leading-ui
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Maximum number of parallel agent sessions, including scheduled tasks")}</div>
      </div>
    </div>

    <!-- Default working folder (desktop) -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <label
          for="workspaceRoot"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("Default Working Folder")}</label>
        <input
          id="workspaceRoot"
          type="text"
          spellcheck="false"
          placeholder="/absolute/path/to/your/project"
          value={currentPreferences.workspaceRoot ?? ''}
          onchange={handleWorkspaceRootChange}
          class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200
            {currentTheme === 'modern'
              ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark focus:ring-3 focus:ring-chat-primary/10 dark:focus:ring-chat-primary-dark/10'
              : 'font-terminal bg-term-bg text-term-green border border-term-dim-green focus:outline-none focus:border-term-bright-green focus:ring-3 focus:ring-term-green/10'}"
        />
        <div class="mt-1.5 text-sm leading-ui
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Desktop only. New conversations start in this folder in both General and Code mode. Leave empty to start with no selected folder; existing conversations keep their own folder.")}</div>
      </div>
    </div>

    <!-- Save Message -->
    {#if saveMessage}
      <div class="flex items-center gap-2 p-3 rounded-lg text-sm mt-4
        {saveMessageType === 'success'
          ? (currentTheme === 'modern'
            ? 'text-chat-status-success dark:text-chat-status-success-dark bg-chat-status-success/10 dark:bg-chat-status-success-dark/10'
            : 'text-term-green bg-term-green/10')
          : (currentTheme === 'modern'
            ? 'text-chat-status-error dark:text-chat-status-error-dark bg-chat-status-error/10 dark:bg-chat-status-error-dark/10'
            : 'text-term-red bg-term-red/10')}"
      >
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
  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  .animate-blink {
    animation: blink 1s infinite;
  }
</style>
