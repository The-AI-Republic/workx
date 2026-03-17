<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IUserPreferences } from '@/config/types';
  import { uiTheme } from '../stores/themeStore';
  import { userStore } from '../stores/userStore';
  import Switch from '../components/common/Switch.svelte';
  import { _t } from '../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  let {
    settingsConfig,
    highlightSettingId = undefined,
    isDirty = $bindable(false),
    onBack,
    onSaved,
    onNavigateTo,
  }: {
    settingsConfig: AgentConfig;
    highlightSettingId?: string | undefined;
    isDirty?: boolean;
    onBack?: () => void;
    onSaved?: (detail: { success: boolean; error?: string }) => void;
    onNavigateTo?: (view: string) => void;
  } = $props();

  let currentTheme = $derived($uiTheme);

  // Form state
  let originalPreferences: IUserPreferences = {};
  let currentPreferences: IUserPreferences = $state({});
  let isSaving = $state(false);
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  // Memory API key status
  let hasOpenAIKey = $state(false);

  // User tier (reactive)
  let isLoggedIn = $derived($userStore.isLoggedIn);
  let isFreeUser = $derived($userStore.userType === 0);
  let isPaidUser = $derived(isLoggedIn && !isFreeUser);
  let memoryUseOwnApiKey = $derived(currentPreferences.memoryUseOwnApiKey ?? true);
  let showMemoryKeyWarning = $derived(currentPreferences.memoryEnabled && memoryUseOwnApiKey && !hasOpenAIKey);

  $effect(() => {
    if (highlightSettingId) {
      highlightSetting(highlightSettingId);
      highlightSettingId = undefined;
    }
  });

  onMount(async () => {
    await loadPreferences();
    await checkOpenAIKey();
  });

  async function checkOpenAIKey() {
    try {
      const key = await settingsConfig.getProviderApiKey('openai');
      hasOpenAIKey = !!key;
    } catch {
      hasOpenAIKey = false;
    }
  }

  async function loadPreferences() {
    try {
      const config = settingsConfig.getConfig();
      originalPreferences = { ...config.preferences };
      currentPreferences = { ...config.preferences };
    } catch (error) {
      console.error('[MemorySettings] Failed to load preferences:', error);
      saveMessage = 'Failed to load preferences';
      saveMessageType = 'error';
    }
  }

  async function autoSave() {
    if (isSaving) return;

    try {
      isSaving = true;
      await settingsConfig.updateConfig({ preferences: currentPreferences });

      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(e => console.warn('[messaging] config update failed:', e));

      originalPreferences = { ...currentPreferences };
      saveMessage = 'Settings saved successfully';
      saveMessageType = 'success';

      onSaved?.({ success: true });

      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      console.error('[MemorySettings] Failed to save preferences:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save settings: ${errorMsg}`;
      saveMessageType = 'error';

      onSaved?.({ success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }

  function handleMemoryEnabledChange(value: boolean) {
    currentPreferences.memoryEnabled = value;

    if (value && isPaidUser) {
      currentPreferences.memoryUseOwnApiKey = false;
    } else if (value && (isFreeUser || !isLoggedIn)) {
      currentPreferences.memoryUseOwnApiKey = true;
    }

    autoSave();
  }

  function handleMemoryUseOwnKeyChange(value: boolean) {
    if (!isPaidUser) return;
    currentPreferences.memoryUseOwnApiKey = value;
    autoSave();
  }

  function handleBack() {
    onBack?.();
  }
</script>

<div class="p-6">
  <button
    class="bg-transparent border-none cursor-pointer text-[15px] font-medium py-2 px-0 mb-4 flex items-center gap-1 transition-opacity duration-200 hover:opacity-80
      {currentTheme === 'modern'
        ? 'font-chat text-chat-primary dark:text-chat-primary-dark'
        : 'font-terminal text-term-green'}"
    onclick={handleBack}
  >{$_t("Back")}</button>

  <h2 class="m-0 mb-6 text-2xl font-semibold
    {currentTheme === 'modern'
      ? 'font-chat text-chat-text dark:text-chat-text-dark'
      : 'font-terminal text-term-green'}"
  >{$_t("Memory Settings")}</h2>

  <div class="max-w-[600px] flex flex-col gap-3">
    <!-- Memory Enable Toggle -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
      data-setting-id="memoryEnabled"
    >
      <div>
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-[15px] font-medium
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text dark:text-chat-text-dark'
                : 'font-terminal text-term-green'}"
            >{$_t("Agent Memory")}</span>
            <span class="text-sm leading-relaxed
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                : 'font-terminal text-term-dim-green'}"
            >{$_t("Remember facts across conversations. Takes effect on next conversation.")}</span>
          </div>
          <Switch
            state={currentPreferences.memoryEnabled ?? false}
            onChange={handleMemoryEnabledChange}
          />
        </div>

        {#if currentPreferences.memoryEnabled}
          <!-- Memory routing: use own key vs backend -->
          {#if isPaidUser}
            <div class="mt-3 flex items-center justify-between gap-4 p-2.5 rounded-lg border
              {currentTheme === 'modern'
                ? 'border-chat-border/50 dark:border-chat-border-dark/50'
                : 'border-term-dim-green/30'}"
            >
              <div class="flex flex-col gap-0.5">
                <span class="text-sm font-medium
                  {currentTheme === 'modern'
                    ? 'font-chat text-chat-text dark:text-chat-text-dark'
                    : 'font-terminal text-term-green'}"
                >{$_t("Use own OpenAI API key")}</span>
                <span class="text-xs leading-relaxed
                  {currentTheme === 'modern'
                    ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
                    : 'font-terminal text-term-dim-green'}"
                >{$_t("When off, memory uses your account credits via backend routing.")}</span>
              </div>
              <Switch
                state={memoryUseOwnApiKey}
                onChange={handleMemoryUseOwnKeyChange}
              />
            </div>
          {:else if isLoggedIn && isFreeUser}
            <div class="mt-3 flex items-start gap-2 p-2.5 rounded-lg text-sm
              {currentTheme === 'modern'
                ? 'font-chat text-blue-600 dark:text-blue-400 bg-blue-500/10 dark:bg-blue-400/10'
                : 'font-terminal text-cyan-400 bg-cyan-400/10'}"
            >
              <svg class="mt-0.5 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
              <span>{$_t("Free tier requires your own OpenAI API key for memory. Upgrade to use account credits.")}</span>
            </div>
          {/if}

          <!-- Warning: own key mode but no key configured -->
          {#if showMemoryKeyWarning}
            <div class="mt-3 flex items-start gap-2 p-2.5 rounded-lg text-sm
              {currentTheme === 'modern'
                ? 'font-chat text-amber-600 dark:text-amber-400 bg-amber-500/10 dark:bg-amber-400/10'
                : 'font-terminal text-yellow-400 bg-yellow-400/10'}"
            >
              <svg class="mt-0.5 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>{$_t("Memory will not work until an OpenAI API key is configured. Enable \"Use Own API Key\" in Model Settings and add your OpenAI key.")}
                {#if onNavigateTo}
                  <button
                    class="inline underline font-medium cursor-pointer bg-transparent border-none p-0 text-inherit"
                    onclick={() => onNavigateTo?.('model-config')}
                  >{$_t("Go to Model Settings →")}</button>
                {/if}
              </span>
            </div>
          {/if}
        {/if}
      </div>
    </div>

    <!-- How Memory Works -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div class="flex flex-col gap-2">
        <span class="text-[15px] font-medium
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text dark:text-chat-text-dark'
            : 'font-terminal text-term-green'}"
        >{$_t("How it works")}</span>
        <div class="text-sm leading-relaxed flex flex-col gap-1.5
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >
          <p class="m-0">{$_t("The agent automatically extracts and remembers important facts from your conversations — preferences, project details, and personal context.")}</p>
          <p class="m-0">{$_t("All memory data is stored locally on your device. Nothing is sent to our servers.")}</p>
          <p class="m-0">{$_t("Core preferences (like 'always use dark mode') are injected into every conversation. Other facts are searchable on demand.")}</p>
          <p class="m-0">{$_t("Memory requires an OpenAI API key for embeddings (text-embedding-3-small). Extraction uses gpt-4o-mini for low cost.")}</p>
          <p class="m-0">{$_t("Multi model support is coming soon for memory.")}</p>
        </div>
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
