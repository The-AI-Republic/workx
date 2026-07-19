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

  type MemorySnapshotEntry = {
    time: string;
    category: string;
    text: string;
    truncated: boolean;
  };

  type MemorySnapshotDay = {
    date: string;
    entries: MemorySnapshotEntry[];
    truncated: boolean;
  };

  type MemorySnapshot = {
    available: boolean;
    enabled: boolean;
    coreMemory?: string;
    coreMemoryChars?: number;
    coreMemoryTruncated?: boolean;
    dailyFiles?: MemorySnapshotDay[];
    dailyEntryCount?: number;
  };

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
  let memorySnapshot = $state<MemorySnapshot | null>(null);
  let memorySnapshotLoading = $state(false);
  let memoryClearInProgress = $state(false);

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
    await loadMemorySnapshot();
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
      if (!(currentPreferences.memoryEnabled ?? false)) {
        memorySnapshot = null;
      }
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

  async function loadMemorySnapshot() {
    if (!(currentPreferences.memoryEnabled ?? false)) {
      memorySnapshot = null;
      return;
    }

    try {
      memorySnapshotLoading = true;
      const client = await getInitializedUIClient();
      const snapshot = await client.serviceRequest('memory.getSnapshot', {
        days: 7,
        entriesPerDay: 20,
      }) as MemorySnapshot;
      memorySnapshot = snapshot.available ? snapshot : null;
    } catch (error) {
      console.warn('[MemorySettings] Memory snapshot unavailable:', error);
      memorySnapshot = null;
    } finally {
      memorySnapshotLoading = false;
    }
  }

  async function clearAllMemory() {
    if (memoryClearInProgress) return;
    if (!confirm($_t('Clear all stored memory?'))) return;

    try {
      memoryClearInProgress = true;
      const client = await getInitializedUIClient();
      await client.serviceRequest('memory.clearAll', { confirm: true });
      await loadMemorySnapshot();
      saveMessage = 'Memory cleared';
      saveMessageType = 'success';
      onSaved?.({ success: true });
    } catch (error) {
      console.error('[MemorySettings] Failed to clear memory:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to clear memory: ${errorMsg}`;
      saveMessageType = 'error';
      onSaved?.({ success: false, error: errorMsg });
    } finally {
      memoryClearInProgress = false;
    }
  }

  async function handleMemoryEnabledChange(value: boolean) {
    currentPreferences.memoryEnabled = value;

    if (value && isPaidUser) {
      currentPreferences.memoryUseOwnApiKey = false;
    } else if (value && (isFreeUser || !isLoggedIn)) {
      currentPreferences.memoryUseOwnApiKey = true;
    }

    await autoSave();
    await loadMemorySnapshot();
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
    class="bg-transparent border-none cursor-pointer text-sm font-medium py-2 px-0 mb-4 flex items-center gap-1 transition-opacity duration-200 hover:opacity-80
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
            <span class="text-sm font-medium
              {currentTheme === 'modern'
                ? 'font-chat text-chat-text dark:text-chat-text-dark'
                : 'font-terminal text-term-green'}"
            >{$_t("Agent Memory")}</span>
            <span class="text-sm leading-ui
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
                <span class="text-xs leading-ui
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

          <!-- Info: own key mode but no OpenAI key configured — will fall back to main LLM -->
          {#if showMemoryKeyWarning}
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
              <span>{$_t("No OpenAI API key found. Memory will use your current LLM provider and model. For lower cost, add an OpenAI API key to use gpt-4o-mini instead.")}
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

    {#if currentPreferences.memoryEnabled && memorySnapshot}
      <div
        class="rounded-xl px-5 py-4 border
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
            : 'bg-term-bg border-term-dim-green'}"
        data-setting-id="memory-current"
      >
        <div class="flex items-center justify-between gap-4 mb-3">
          <span class="text-sm font-medium
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text dark:text-chat-text-dark'
              : 'font-terminal text-term-green'}"
          >{$_t("Current memory")}</span>
          <button
            class="px-3 py-1.5 rounded-md border text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
              {currentTheme === 'modern'
                ? 'font-chat text-chat-status-error dark:text-chat-status-error-dark border-chat-status-error/40 dark:border-chat-status-error-dark/40 bg-transparent hover:bg-chat-status-error/10 dark:hover:bg-chat-status-error-dark/10'
                : 'font-terminal text-term-red border-term-red/50 bg-transparent hover:bg-term-red/10'}"
            disabled={memoryClearInProgress || memorySnapshotLoading}
            onclick={clearAllMemory}
          >{memoryClearInProgress ? $_t("Clearing...") : $_t("Clear all")}</button>
        </div>

        {#if memorySnapshotLoading}
          <div class="text-sm
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
              : 'font-terminal text-term-dim-green'}"
          >{$_t("Loading memory...")}</div>
        {:else}
          <div class="flex flex-col gap-3 text-sm
            {currentTheme === 'modern'
              ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
              : 'font-terminal text-term-dim-green'}"
          >
            <div>
              <div class="font-medium mb-1
                {currentTheme === 'modern'
                  ? 'text-chat-text dark:text-chat-text-dark'
                  : 'text-term-green'}"
              >{$_t("Core memory")}</div>
              <pre class="m-0 whitespace-pre-wrap max-h-52 overflow-auto rounded-lg p-3 text-xs
                {currentTheme === 'modern'
                  ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
                  : 'bg-term-black text-term-green'}"
              >{memorySnapshot.coreMemory?.trim() || $_t("No core memory stored.")}</pre>
              {#if memorySnapshot.coreMemoryTruncated}
                <div class="mt-1 text-xs">{$_t("Core memory preview is truncated.")}</div>
              {/if}
            </div>

            <div>
              <div class="font-medium mb-1
                {currentTheme === 'modern'
                  ? 'text-chat-text dark:text-chat-text-dark'
                  : 'text-term-green'}"
              >{$_t("Recent daily memory")}</div>
              {#if (memorySnapshot.dailyFiles?.length ?? 0) === 0}
                <div>{$_t("No daily memory stored.")}</div>
              {:else}
                <div class="flex flex-col gap-2">
                  {#each memorySnapshot.dailyFiles ?? [] as day}
                    <div>
                      <div class="text-xs font-medium mb-1">{day.date}</div>
                      <ul class="m-0 pl-4 flex flex-col gap-1">
                        {#each day.entries as entry}
                          <li>
                            <span class="font-medium">{entry.time} · {entry.category}</span>
                            <span> — {entry.text}{entry.truncated ? '...' : ''}</span>
                          </li>
                        {/each}
                      </ul>
                      {#if day.truncated}
                        <div class="mt-1 text-xs">{$_t("More entries hidden.")}</div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- How Memory Works -->
    <div
      class="rounded-xl px-5 py-4 border
        {currentTheme === 'modern'
          ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
          : 'bg-term-bg border-term-dim-green'}"
    >
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text dark:text-chat-text-dark'
            : 'font-terminal text-term-green'}"
        >{$_t("How it works")}</span>
        <div class="text-sm leading-ui flex flex-col gap-1.5
          {currentTheme === 'modern'
            ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
            : 'font-terminal text-term-dim-green'}"
        >
          <p class="m-0">{$_t("The agent automatically extracts and remembers important facts from your conversations — preferences, project details, and personal context.")}</p>
          <p class="m-0">{$_t("Memory files are stored locally on your device. Memory content is sent to the configured LLM provider when the agent saves, searches, or merges facts.")}</p>
          <p class="m-0">{$_t("Core preferences (like 'always use dark mode') are injected into every conversation. Other facts are searchable on demand.")}</p>
          <p class="m-0">{$_t("Memory works with any LLM provider. When an OpenAI API key is available, it uses gpt-4o-mini for lower cost. Otherwise it uses your current model.")}</p>
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
