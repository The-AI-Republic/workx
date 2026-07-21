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
  import SecuritySettings from '../../settings/SecuritySettings.svelte';
  import MemorySettings from '../../settings/MemorySettings.svelte';
  import KeyboardShortcutsSettings from '../../settings/KeyboardShortcutsSettings.svelte';
  import DataSourcesSettings from '../../settings/DataSourcesSettings.svelte';
  import ComponentsSettings from '../../settings/ComponentsSettings.svelte';
  import AppsSettings from '../../settings/AppsSettings.svelte';
  import { t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  // Navigation state - includes 'advanced-model-config' for 3rd level menu
  type NavigationView =
    | 'menu'
    | 'model-config'
    | 'advanced-model-config'
    | 'general'
    | 'memory'
    | 'storage'
    | 'tools'
    | 'data-sources'
    | 'components'
    | 'apps'
    | 'mcp-servers'
    | 'extension'
    | 'approval'
    | 'security'
    | 'keyboard-shortcuts';
  let currentView: NavigationView = $state('menu');
  let hasUnsavedChanges: boolean = $state(false);
  let showUnsavedDialog: boolean = $state(false);
  let pendingNavigation: NavigationView | null = $state(null);

  // Highlight setting after navigation from search
  let highlightSettingId: string | undefined = $state(undefined);

  // Advanced config context (for 3rd level menu)
  let advancedConfigModelId: string = $state('');
  let advancedConfigProviderId: string = $state('');
  let initialDataSourceId: string | undefined = $state(undefined);
  let initialDataSourceTab: 'details' | 'context' = $state('details');

  // The webfront has one AgentConfig cache. The agent runtime lives in a
  // separate process and receives committed updates through messaging.
  let settingsConfig: AgentConfig | null = $state(null);
  let isInitializing: boolean = $state(true);

  // Theme from store
  let currentTheme = $derived($uiTheme);

  // Load existing settings on mount
  onMount(async () => {
    applyValidatedDeepLink();
    await loadSettings();
  });

  function applyValidatedDeepLink() {
    const hashQuery = window.location.hash.includes('?')
      ? window.location.hash.slice(window.location.hash.indexOf('?') + 1)
      : '';
    const query = new URLSearchParams(window.location.search || hashQuery);
    if (query.get('view') === 'apps') {
      currentView = 'apps';
      return;
    }
    if (query.get('view') !== 'data-sources') return;
    currentView = 'data-sources';
    const sourceId = query.get('source');
    if (
      sourceId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId)
    ) {
      initialDataSourceId = sourceId;
    }
    initialDataSourceTab = query.get('tab') === 'context' ? 'context' : 'details';
  }

  /** Load the webfront's shared, initialized configuration service. */
  async function loadSettings() {
    try {
      isInitializing = true;
      settingsConfig = await AgentConfig.getInstance();
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

  function handleCategorySelected(value: { categoryId: string; scrollToId?: string }) {
    highlightSettingId = value.scrollToId;
    navigateTo(value.categoryId as NavigationView);
  }

  function handleBack() {
    highlightSettingId = undefined;
    navigateTo('menu');
  }

  function handleBackFromAdvanced() {
    navigateTo('model-config');
  }

  function handleNavigateToAdvanced(value: { modelId: string; providerId: string }) {
    advancedConfigModelId = value.modelId;
    advancedConfigProviderId = value.providerId;
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

<div class="settings-page" class:modern={currentTheme === 'modern'}>
  <div class="settings-container">
    <div class="settings-header">
      <h2 class="settings-title">{t('Settings')}</h2>
      <button class="close-button" onclick={closeSettings} aria-label={t('Close settings')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="settings-content">
      {#if currentView === 'menu'}
        <SettingsMenu onCategorySelected={handleCategorySelected} />
      {:else if isInitializing || !settingsConfig}
        <!-- Wait for AgentConfig to be fully initialized before rendering settings components -->
        <div class="settings-loading">
          <div class="loading-spinner"></div>
          <span>{t('Loading settings...')}</span>
        </div>
      {:else if currentView === 'model-config'}
        <ModelSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          onAuthUpdated={() => {}}
          onNavigateToAdvanced={handleNavigateToAdvanced}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'advanced-model-config'}
        <AdvancedModelConfig
          {settingsConfig}
          modelId={advancedConfigModelId}
          providerId={advancedConfigProviderId}
          onBack={handleBackFromAdvanced}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'general'}
        <GeneralSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'memory'}
        <MemorySettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          onNavigateTo={(view) => navigateTo(view as NavigationView)}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'storage'}
        <StorageSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'tools'}
        <ToolsSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'data-sources'}
        <DataSourcesSettings
          onBack={handleBack}
          initialSourceId={initialDataSourceId}
          initialTab={initialDataSourceTab}
        />
      {:else if currentView === 'components'}
        <ComponentsSettings onBack={handleBack} />
      {:else if currentView === 'apps'}
        <AppsSettings onBack={handleBack} />
      {:else if currentView === 'mcp-servers'}
        <MCPSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'extension'}
        <ExtensionSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'approval'}
        <ApprovalSettings
          {settingsConfig}
          {highlightSettingId}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {:else if currentView === 'security'}
        <SecuritySettings onBack={handleBack} onSaved={() => {}} bind:isDirty={hasUnsavedChanges} />
      {:else if currentView === 'keyboard-shortcuts'}
        <KeyboardShortcutsSettings
          {settingsConfig}
          onBack={handleBack}
          onSaved={() => {}}
          bind:isDirty={hasUnsavedChanges}
        />
      {/if}
    </div>

    <!-- Unsaved Changes Dialog -->
    <UnsavedChangesDialog
      isOpen={showUnsavedDialog}
      onConfirm={handleDialogConfirm}
      onCancel={handleDialogCancel}
    />
  </div>
</div>

<style>
  .settings-page {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Override AppShell's .content-area > * { overflow: hidden } which has equal
       specificity but appears later in the compiled CSS. The settings page needs
       visible overflow so the centered modal container isn't clipped. */
    overflow: visible !important;
    background: rgba(0, 0, 0, 0.5);
    /* Terminal theme (default) */
    --workx-primary: #00ff00;
    --workx-secondary: #00cc00;
    --workx-background: #000000;
    --workx-surface: #0a0a0a;
    --workx-text: #00ff00;
    --workx-text-secondary: #00cc00;
    --workx-border: #00cc00;
    --workx-error: #ff0000;
    --workx-success: #00ff00;
    --workx-warning: #ffff00;
    color-scheme: dark;
  }

  /* Modern Chat theme — light */
  .settings-page.modern {
    --workx-primary: var(--color-chat-primary, #2563eb);
    --workx-secondary: var(--color-chat-primary, #2563eb);
    --workx-background: var(--color-chat-bg, #ffffff);
    --workx-surface: var(--color-chat-surface, #f7f7f8);
    --workx-text: var(--color-chat-text, #0d0d0d);
    --workx-text-secondary: var(--color-chat-text-secondary, #6e6e80);
    --workx-border: var(--color-chat-border, #e5e5e5);
    --workx-error: var(--color-chat-error, #dc2626);
    --workx-success: var(--color-chat-status-success, #047857);
    --workx-warning: var(--color-chat-status-warning, #b45309);
    background: rgba(0, 0, 0, 0.3);
    color-scheme: light;
  }

  /* Modern Chat theme — dark */
  :global(.dark) .settings-page.modern {
    --workx-primary: var(--color-chat-primary-dark, #60a5fa);
    --workx-secondary: var(--color-chat-primary-dark, #60a5fa);
    --workx-background: var(--color-chat-bg-dark, #212121);
    --workx-surface: var(--color-chat-surface-dark, #2f2f2f);
    --workx-text: var(--color-chat-text-dark, #ececec);
    --workx-text-secondary: var(--color-chat-text-secondary-dark, #b4b4b4);
    --workx-border: var(--color-chat-border-dark, #3e3e3e);
    --workx-error: var(--color-chat-error-dark, #f87171);
    --workx-success: var(--color-chat-status-success-dark, #34d399);
    --workx-warning: var(--color-chat-status-warning-dark, #fbbf24);
    color-scheme: dark;
  }

  .settings-container {
    max-width: 42rem;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    background: var(--workx-background);
    border: 1px solid var(--workx-border);
    color: var(--workx-text);
  }

  .settings-page.modern .settings-container {
    border-radius: 1rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }

  .settings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--workx-border);
  }

  .settings-title {
    margin: 0;
    font-size: var(--text-xl);
    line-height: var(--text-xl--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
  }

  .close-button {
    background: none;
    border: none;
    color: var(--workx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.375rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .close-button:hover {
    color: var(--workx-text);
    background: var(--workx-surface);
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
    color: var(--workx-text-secondary);
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--workx-border);
    border-top-color: var(--workx-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
