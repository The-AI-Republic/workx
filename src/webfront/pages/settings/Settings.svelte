<!--
  Settings - Svelte component for managing user settings
  Handles navigation between different settings views
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { AgentConfig } from '@/config/AgentConfig.js';
  import SettingsMenu from '../../settings/components/SettingsMenu.svelte';
  import UnsavedChangesDialog from '../../settings/components/UnsavedChangesDialog.svelte';
  import ModelSettings from '../../settings/ModelSettings.svelte';
  import AdvancedModelConfig from '../../settings/AdvancedModelConfig.svelte';
  import GeneralSettings from '../../settings/GeneralSettings.svelte';
  import StorageSettings from '../../settings/StorageSettings.svelte';
  import ToolsSettings from '../../settings/ToolsSettings.svelte';
  import ExtensionSettings from '../../settings/ExtensionSettings.svelte';
  import MCPSettings from '../../settings/MCPSettings.svelte';
  import ApprovalSettings from '../../settings/ApprovalSettings.svelte';
  import { t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  // Navigation state - includes 'advanced-model-config' for 3rd level menu
  type NavigationView = 'menu' | 'model-config' | 'advanced-model-config' | 'general' | 'storage' | 'tools' | 'mcp-servers' | 'extension' | 'approval';
  let currentView: NavigationView = 'menu';
  let hasUnsavedChanges = false;
  let showUnsavedDialog = false;
  let pendingNavigation: NavigationView | null = null;

  // Highlight setting after navigation from search
  let highlightSettingId: string | undefined = undefined;

  // Advanced config context (for 3rd level menu)
  let advancedConfigModelId = '';
  let advancedConfigProviderId = '';

  // Settings component has its own AgentConfig instance (not shared with agent)
  let settingsConfig: AgentConfig | null = null;
  let isInitializing = true;

  // Theme from store
  let currentTheme: string;
  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Load existing settings on mount
  onMount(async () => {
    await loadSettings();
    return () => {
      unsubTheme();
    };
  });

  /**
   * Load settings from chrome.storage.local with isolated AgentConfig
   */
  async function loadSettings() {
    try {
    isInitializing = true;
    const configInstance = new (AgentConfig as any)();

    if (!configInstance) {
      throw new Error('Failed to initialize AgentConfig');
    }
    await configInstance.initialize();

    // Only expose the instance to children once it is fully initialized
    settingsConfig = configInstance;

    // Debug: log loaded selectedModelKey
    const config = configInstance.getConfig();
      console.log('[Settings] Loaded config, selectedModelKey:', config.selectedModelKey);
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error);
    } finally {
      isInitializing = false;
    }
  }

  /**
   * Close settings - navigate back to chat
   */
  function closeSettings() {
    push('/');
  }

  /**
   * Navigation functions
   */
  function navigateTo(view: NavigationView) {
    if (hasUnsavedChanges && view === 'menu') {
      pendingNavigation = view;
      showUnsavedDialog = true;
    } else {
      currentView = view;
      hasUnsavedChanges = false;
    }
  }

  function handleCategorySelected(event: CustomEvent<{ categoryId: string; scrollToId?: string }>) {
    highlightSettingId = event.detail.scrollToId;
    navigateTo(event.detail.categoryId as NavigationView);
  }

  function handleBack() {
    highlightSettingId = undefined;
    navigateTo('menu');
  }

  function handleBackFromAdvanced() {
    navigateTo('model-config');
  }

  function handleNavigateToAdvanced(event: CustomEvent<{ modelId: string; providerId: string }>) {
    advancedConfigModelId = event.detail.modelId;
    advancedConfigProviderId = event.detail.providerId;
    navigateTo('advanced-model-config');
  }

  function handleDialogConfirm() {
    showUnsavedDialog = false;
    if (pendingNavigation) {
      currentView = pendingNavigation;
      hasUnsavedChanges = false;
      pendingNavigation = null;
    }
  }

  function handleDialogCancel() {
    showUnsavedDialog = false;
    pendingNavigation = null;
  }
</script>

<div class="settings-page" class:chatgpt={currentTheme === 'chatgpt'}>
  <div class="settings-container">
    <div class="settings-header">
      <h2 class="settings-title">{t("Settings")}</h2>
      <button class="close-button" on:click={closeSettings} aria-label={t("Close settings")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="settings-content">
      {#if currentView === 'menu'}
        <SettingsMenu on:categorySelected={handleCategorySelected} />
      {:else if isInitializing || !settingsConfig}
        <!-- Wait for AgentConfig to be fully initialized before rendering settings components -->
        <div class="settings-loading">
          <div class="loading-spinner"></div>
          <span>{t("Loading settings...")}</span>
        </div>
      {:else if currentView === 'model-config'}
        <ModelSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          on:authUpdated={() => {}}
          on:navigateToAdvanced={handleNavigateToAdvanced}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'advanced-model-config'}
        <AdvancedModelConfig
          {settingsConfig}
          modelId={advancedConfigModelId}
          providerId={advancedConfigProviderId}
          on:back={handleBackFromAdvanced}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'general'}
        <GeneralSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'storage'}
        <StorageSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'tools'}
        <ToolsSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'mcp-servers'}
        <MCPSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'extension'}
        <ExtensionSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'approval'}
        <ApprovalSettings
          {settingsConfig}
          {highlightSettingId}
          on:back={handleBack}
          on:saved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {/if}
    </div>

    <!-- Unsaved Changes Dialog -->
    <UnsavedChangesDialog
      isOpen={showUnsavedDialog}
      on:confirm={handleDialogConfirm}
      on:cancel={handleDialogCancel}
    />
  </div>
</div>

<style>
  .settings-page {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    /* Terminal theme (default) */
    --browserx-primary: #00ff00;
    --browserx-secondary: #00cc00;
    --browserx-background: #000000;
    --browserx-surface: #0a0a0a;
    --browserx-text: #00ff00;
    --browserx-text-secondary: #00cc00;
    --browserx-border: #00cc00;
    --browserx-error: #ff0000;
    --browserx-success: #00ff00;
    --browserx-warning: #ffff00;
    color-scheme: dark;
  }

  /* ChatGPT theme — light */
  .settings-page.chatgpt {
    --browserx-primary: var(--color-chat-primary, #60a5fa);
    --browserx-secondary: var(--color-chat-primary, #60a5fa);
    --browserx-background: var(--color-chat-bg, #ffffff);
    --browserx-surface: var(--color-chat-surface, #f7f7f8);
    --browserx-text: var(--color-chat-text, #0d0d0d);
    --browserx-text-secondary: var(--color-chat-text-secondary, #6e6e80);
    --browserx-border: var(--color-chat-border, #e5e5e5);
    --browserx-error: var(--color-chat-error, #ef4444);
    --browserx-success: #10b981;
    --browserx-warning: #f59e0b;
    background: rgba(0, 0, 0, 0.3);
    color-scheme: light;
  }

  /* ChatGPT theme — dark */
  @media (prefers-color-scheme: dark) {
    .settings-page.chatgpt {
      --browserx-primary: var(--color-chat-primary-dark, #60a5fa);
      --browserx-secondary: var(--color-chat-primary-dark, #60a5fa);
      --browserx-background: var(--color-chat-bg-dark, #212121);
      --browserx-surface: var(--color-chat-surface-dark, #2f2f2f);
      --browserx-text: var(--color-chat-text-dark, #ececec);
      --browserx-text-secondary: var(--color-chat-text-secondary-dark, #b4b4b4);
      --browserx-border: var(--color-chat-border-dark, #3e3e3e);
      --browserx-error: var(--color-chat-error-dark, #f87171);
      --browserx-success: #34d399;
      --browserx-warning: #fbbf24;
      color-scheme: dark;
    }
  }

  .settings-container {
    max-width: 42rem;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    background: var(--browserx-background);
    border: 1px solid var(--browserx-border);
    color: var(--browserx-text);
  }

  .settings-page.chatgpt .settings-container {
    border-radius: 1rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }

  .settings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--browserx-border);
  }

  .settings-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .close-button {
    background: none;
    border: none;
    color: var(--browserx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.375rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .close-button:hover {
    color: var(--browserx-text);
    background: var(--browserx-surface);
  }

  .settings-content {
    flex: 1;
    overflow-y: auto;
  }

  .settings-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 3rem;
    color: var(--browserx-text-secondary);
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--browserx-border);
    border-top-color: var(--browserx-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
