<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IUserPreferences } from '@/config/types';
  import { uiTheme, type UITheme } from '../stores/themeStore';
  import { showTokenUsage } from '../stores/tokenUsageStore';
  import Switch from '../components/common/Switch.svelte';
  import { t, _t, getCurrentLocale, setLocale } from '../lib/i18n';
  import supportedLanguages from '../../../_locales/supported_languages.json';
  import { sendMessage, notifyConfigUpdate, MessageType } from '../lib/messaging';
  import { platform } from '../stores/platformStore';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  export let settingsConfig: AgentConfig;
  export let highlightSettingId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // Theme
  let currentTheme: UITheme = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

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
    highlightSetting(highlightSettingId);
    highlightSettingId = undefined;
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

<div class="p-6">
  <button
    class="bg-transparent border-none cursor-pointer text-[15px] font-medium py-2 px-0 mb-4 flex items-center gap-1 transition-opacity duration-200 hover:opacity-80
      {currentTheme === 'chatgpt'
        ? 'font-chat text-chat-primary dark:text-chat-primary-dark'
        : 'font-terminal text-term-green'}"
    on:click={handleBack}
  >← {$_t("Back")}</button>

  <h2 class="m-0 mb-6 text-2xl font-semibold
    {currentTheme === 'chatgpt'
      ? 'font-chat text-chat-text dark:text-chat-text-dark'
      : 'font-terminal text-term-green'}"
  >{$_t("General Settings")}</h2>

  <div class="max-w-[600px] flex flex-col gap-3">
    <!-- UI Theme Selection -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'chatgpt'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
      data-setting-id="uiTheme"
    >
      <div>
        <label
          for="uiTheme"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'chatgpt'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("UI Theme")}</label>
        <div class="flex gap-4 mb-2">
          {#each themeOptions as option}
            <label
              class="flex-1 relative cursor-pointer rounded-xl overflow-hidden transition-all duration-200
                {currentPreferences.uiTheme === option.value
                  ? (currentTheme === 'chatgpt'
                    ? 'border-2 border-chat-primary dark:border-chat-primary-dark shadow-[0_0_0_3px_rgba(96,165,250,0.2)]'
                    : 'border-2 border-term-green shadow-[0_0_0_3px_rgba(0,255,0,0.2)]')
                  : (currentTheme === 'chatgpt'
                    ? 'border-2 border-chat-border dark:border-chat-border-dark hover:border-chat-primary dark:hover:border-chat-primary-dark'
                    : 'border-2 border-term-dim-green hover:border-term-green')}"
            >
              <input
                type="radio"
                name="uiTheme"
                value={option.value}
                checked={currentPreferences.uiTheme === option.value}
                on:change={handleThemeChange}
                class="absolute opacity-0 w-0 h-0"
              />
              <div class="flex flex-col">
                <div
                  class="h-20 flex items-center justify-center p-3
                    {option.value === 'terminal' ? 'bg-black' : 'bg-[#f7f7f8]'}"
                >
                  {#if option.value === 'terminal'}
                    <div class="font-terminal text-sm text-[#00ff00]">
                      <span class="mr-1">&gt;&gt;</span>
                      <span class="animate-blink">_</span>
                    </div>
                  {:else}
                    <div class="flex flex-col gap-2 w-full px-2">
                      <div class="h-3 rounded-xl w-3/5 self-end bg-[#60a5fa]"></div>
                      <div class="h-3 rounded-xl w-4/5 self-start bg-[#e5e5e5]"></div>
                    </div>
                  {/if}
                </div>
                <div
                  class="p-3 flex flex-col gap-1
                    {currentTheme === 'chatgpt'
                      ? 'bg-chat-surface dark:bg-chat-surface-dark'
                      : 'bg-term-bg'}"
                >
                  <span class="font-semibold text-[15px]
                    {currentTheme === 'chatgpt'
                      ? 'font-chat text-chat-text dark:text-chat-text-dark'
                      : 'font-terminal text-term-green'}"
                  >{option.label}</span>
                  <span class="text-sm leading-relaxed
                    {currentTheme === 'chatgpt'
                      ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                      : 'font-terminal text-term-dim-green'}"
                  >{option.description}</span>
                </div>
              </div>
            </label>
          {/each}
        </div>
        <div class="mt-1.5 text-sm leading-relaxed
          {currentTheme === 'chatgpt'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Choose the visual style for the side panel interface")}</div>
      </div>
    </div>

    <!-- Show Token Usage Toggle -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'chatgpt'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
      data-setting-id="showTokenUsage"
    >
      <div>
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-[15px] font-medium
              {currentTheme === 'chatgpt'
                ? 'font-chat text-chat-text dark:text-chat-text-dark'
                : 'font-terminal text-term-green'}"
            >{$_t("Show token usage in tasks")}</span>
            <span class="text-sm leading-relaxed
              {currentTheme === 'chatgpt'
                ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                : 'font-terminal text-term-dim-green'}"
            >{$_t("Display token consumption (input/output tokens) when tasks complete")}</span>
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
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'chatgpt'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-[15px] font-medium
              {currentTheme === 'chatgpt'
                ? 'font-chat text-chat-text dark:text-chat-text-dark'
                : 'font-terminal text-term-green'}"
            >{$_t("Start on login")}</span>
            <span class="text-sm leading-relaxed
              {currentTheme === 'chatgpt'
                ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                : 'font-terminal text-term-dim-green'}"
            >{$_t("Automatically start the app when you log in to your computer")}</span>
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
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'chatgpt'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <label
          for="language"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'chatgpt'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("Language")}</label>
        <select
          id="language"
          value={selectedLanguage}
          on:change={handleLanguageChange}
          class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200
            {currentTheme === 'chatgpt'
              ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark focus:ring-3 focus:ring-chat-primary/10 dark:focus:ring-chat-primary-dark/10'
              : 'font-terminal bg-term-bg text-term-green border border-term-dim-green focus:outline-none focus:border-term-bright-green focus:ring-3 focus:ring-term-green/10'}"
        >
          {#each supportedLanguages as lang}
            <option value={lang.code}>{lang.title}</option>
          {/each}
        </select>
        <div class="mt-1.5 text-sm leading-relaxed
          {currentTheme === 'chatgpt'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Select your preferred language for the interface")}</div>
      </div>
    </div>

    <!-- Max Concurrent Sessions (Feature 015) -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'chatgpt'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div>
        <label
          for="maxSessions"
          class="block mb-2 text-sm font-medium
            {currentTheme === 'chatgpt'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
        >{$_t("Max Concurrent Sessions")}</label>
        <select
          id="maxSessions"
          value={currentPreferences.maxConcurrentSessions ?? 3}
          on:change={handleMaxSessionsChange}
          class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200
            {currentTheme === 'chatgpt'
              ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark focus:ring-3 focus:ring-chat-primary/10 dark:focus:ring-chat-primary-dark/10'
              : 'font-terminal bg-term-bg text-term-green border border-term-dim-green focus:outline-none focus:border-term-bright-green focus:ring-3 focus:ring-term-green/10'}"
        >
          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as num}
            <option value={num}>{num} {num === 1 ? $_t("session") : $_t("sessions")}</option>
          {/each}
        </select>
        <div class="mt-1.5 text-sm leading-relaxed
          {currentTheme === 'chatgpt'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >{$_t("Maximum number of parallel agent sessions, including scheduled tasks")}</div>
      </div>
    </div>

    <!-- Save Message -->
    {#if saveMessage}
      <div class="flex items-center gap-2 p-3 rounded-lg text-sm mt-4
        {saveMessageType === 'success'
          ? (currentTheme === 'chatgpt'
            ? 'text-chat-status-success dark:text-chat-status-success-dark bg-chat-status-success/10 dark:bg-chat-status-success-dark/10'
            : 'text-term-green bg-term-green/10')
          : (currentTheme === 'chatgpt'
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
