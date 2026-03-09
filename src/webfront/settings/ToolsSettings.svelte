<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IToolsConfig } from '@/config/types';
  import { t, _t } from '../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import { uiTheme } from '../stores/themeStore';
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
  let originalTools: IToolsConfig = $state({});
  let currentTools: IToolsConfig = $state({});
  let isSaving = $state(false);
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  // Terminal sandbox settings (persisted via Tauri config_storage)
  let executionMode: 'safe' | 'power' | 'auto' = $state('auto');
  let workspaceAccess: 'rw' | 'ro' | 'none' = $state('rw');
  let networkMode: 'host' | 'sandbox' = $state('host');
  let bindMounts: Array<{ hostPath: string; access: 'rw' | 'ro' }> = $state([]);
  let newBindMountPath = $state('');
  let newBindMountAccess: 'rw' | 'ro' = $state('ro');
  let sandboxStatus: string | null = $state(null);
  let isDesktop = $state(false);

  // Collapsible sections state
  let browserToolsExpanded = $state(true);
  let agentToolsExpanded = $state(true);
  let advancedExpanded = $state(false);
  let terminalSandboxExpanded = $state(false);

  $effect(() => {
    if (highlightSettingId) {
      highlightSetting(highlightSettingId, async () => {
        browserToolsExpanded = true;
        agentToolsExpanded = true;
        advancedExpanded = true;
        terminalSandboxExpanded = true;
      });
      highlightSettingId = undefined;
    }
  });

  onMount(async () => {
    await loadSettings();
    await loadTerminalSandboxSettings();
  });

  async function loadSettings() {
    try {
      const config = settingsConfig.getConfig();
      originalTools = config.tools ? { ...config.tools } : {};
      currentTools = config.tools ? { ...config.tools } : {};

      // Ensure sandboxPolicy exists with default value
      if (!currentTools.sandboxPolicy) {
        currentTools.sandboxPolicy = { mode: 'read-only' };
      }
    } catch (error) {
      console.error('[ToolsSettings] Failed to load settings:', error);
      saveMessage = t('Failed to load settings');
      saveMessageType = 'error';
    }
  }

  async function loadTerminalSandboxSettings() {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('config_storage_get', { key: 'test' });
      isDesktop = true;
    } catch {
      isDesktop = false;
      return;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const mode = await invoke<string | null>('config_storage_get', { key: 'terminal.executionMode' });
      if (mode === 'safe' || mode === 'power' || mode === 'auto') executionMode = mode;

      const access = await invoke<string | null>('config_storage_get', { key: 'terminal.sandbox.workspaceAccess' });
      if (access === 'rw' || access === 'ro' || access === 'none') workspaceAccess = access;

      const network = await invoke<string | null>('config_storage_get', { key: 'terminal.sandbox.networkMode' });
      if (network === 'host' || network === 'sandbox') networkMode = network;

      const mountsJson = await invoke<string | null>('config_storage_get', { key: 'terminal.sandbox.bindMounts' });
      if (mountsJson) {
        try {
          const parsed = JSON.parse(mountsJson);
          if (Array.isArray(parsed)) bindMounts = parsed;
        } catch { /* keep defaults */ }
      }

      const status = await invoke<{ status: string; runtime: string }>('sandbox_check_status');
      sandboxStatus = `${status.status} (${status.runtime})`;
    } catch (error) {
      console.warn('[ToolsSettings] Failed to load terminal sandbox settings:', error);
    }
  }

  async function saveTerminalSandboxSetting(key: string, value: string) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('config_storage_set', { key, value });
    } catch (error) {
      console.error('[ToolsSettings] Failed to save sandbox setting:', error);
    }
  }

  async function handleExecutionModeChange() {
    await saveTerminalSandboxSetting('terminal.executionMode', executionMode);
  }

  async function handleWorkspaceAccessChange() {
    await saveTerminalSandboxSetting('terminal.sandbox.workspaceAccess', workspaceAccess);
  }

  async function handleNetworkModeChange() {
    await saveTerminalSandboxSetting('terminal.sandbox.networkMode', networkMode);
  }

  async function addBindMount() {
    if (!newBindMountPath.trim()) return;
    const path = newBindMountPath.trim();
    if (!path.startsWith('/') && !path.match(/^[A-Z]:\\/)) {
      saveMessage = t('Bind mount path must be absolute');
      saveMessageType = 'error';
      setTimeout(() => { saveMessage = ''; saveMessageType = ''; }, 3000);
      return;
    }
    bindMounts = [...bindMounts, { hostPath: path, access: newBindMountAccess }];
    newBindMountPath = '';
    newBindMountAccess = 'ro';
    await saveTerminalSandboxSetting('terminal.sandbox.bindMounts', JSON.stringify(bindMounts));
  }

  async function removeBindMount(index: number) {
    bindMounts = bindMounts.filter((_, i) => i !== index);
    await saveTerminalSandboxSetting('terminal.sandbox.bindMounts', JSON.stringify(bindMounts));
  }

  function handleInput() {
    isDirty = true;
  }

  function handleBack() {
    onBack?.();
  }

  async function handleSave() {
    if (!isDirty) return;

    try {
      isSaving = true;
      await settingsConfig.updateConfig({ tools: currentTools });

      // Notify backend of config update
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(e => console.warn('[messaging] config update failed:', e));

      originalTools = { ...currentTools };
      isDirty = false;
      saveMessage = t('Settings saved successfully');
      saveMessageType = 'success';

      onSaved?.({ success: true });

      // Clear message after 3 seconds
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      console.error('[ToolsSettings] Failed to save settings:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = t('Failed to save settings: $1$', { substitutions: [errorMsg] });
      saveMessageType = 'error';

      onSaved?.({ success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }

  function toggleSection(section: 'browser' | 'agent' | 'advanced' | 'terminal-sandbox') {
    if (section === 'browser') browserToolsExpanded = !browserToolsExpanded;
    else if (section === 'agent') agentToolsExpanded = !agentToolsExpanded;
    else if (section === 'advanced') advancedExpanded = !advancedExpanded;
    else if (section === 'terminal-sandbox') terminalSandboxExpanded = !terminalSandboxExpanded;
  }

  let isModern = $derived(currentTheme === 'modern');

  /* Reusable class helpers */
  let cardClasses = $derived(isModern
    ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
    : 'bg-term-bg border-term-dim-green');

  let textClasses = $derived(isModern
    ? 'font-chat text-chat-text dark:text-chat-text-dark'
    : 'font-terminal text-term-green');

  let textSecondaryClasses = $derived(isModern
    ? 'font-chat text-chat-text-secondary dark:text-chat-text-secondary-dark'
    : 'font-terminal text-term-dim-green');

  let selectClasses = $derived(isModern
    ? 'font-chat bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark focus:ring-3 focus:ring-chat-primary/10 dark:focus:ring-chat-primary-dark/10'
    : 'font-terminal bg-term-bg text-term-green border border-term-dim-green focus:outline-none focus:border-term-bright-green focus:ring-3 focus:ring-term-green/10');

  let inputClasses = $derived(selectClasses);

  let primaryClasses = $derived(isModern
    ? 'font-chat text-chat-primary dark:text-chat-primary-dark'
    : 'font-terminal text-term-green');

  let checkboxAccent = $derived(isModern
    ? 'accent-chat-primary dark:accent-chat-primary-dark'
    : 'accent-term-green');
</script>

<div class="p-6">
  <button
    class="bg-transparent border-none cursor-pointer text-[15px] font-medium py-2 px-0 mb-4 flex items-center gap-1 transition-opacity duration-200 hover:opacity-80
      {primaryClasses}"
    onclick={handleBack}
  >← {$_t("Back")}</button>

  <h2 class="m-0 mb-6 text-2xl font-semibold {textClasses}">{$_t("Tools Settings")}</h2>

  <div class="max-w-[600px] flex flex-col gap-3">
    <!-- Master Toggle -->
    <div
      class="rounded-xl px-5 py-4 border {cardClasses}"
      data-setting-id="enable-all-tools"
    >
      <div>
        <label class="flex items-center gap-2 cursor-pointer text-base font-semibold {textClasses}">
          <input
            type="checkbox"
            bind:checked={currentTools.enable_all_tools}
            oninput={handleInput}
            class="w-[18px] h-[18px] cursor-pointer {checkboxAccent}"
          />
          <span>{$_t("Enable All Tools")}</span>
        </label>
        <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Master toggle to enable or disable all browser and agent tools")}</div>
      </div>
    </div>

    <!-- Browser Tools Section -->
    <div class="rounded-xl border overflow-hidden {cardClasses}">
      <button
        class="w-full flex items-center gap-3 p-4 border-none cursor-pointer transition-colors duration-200
          {isModern
            ? 'bg-chat-surface dark:bg-chat-surface-dark hover:bg-chat-card-hover dark:hover:bg-chat-card-hover-dark'
            : 'bg-term-bg hover:bg-term-green/5'}"
        onclick={() => toggleSection('browser')}
        aria-expanded={browserToolsExpanded}
      >
        <svg
          class="shrink-0 transition-transform duration-200 stroke-2
            {browserToolsExpanded ? 'rotate-0' : '-rotate-90'}
            {textClasses}"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <polyline points="6,9 12,15 18,9"></polyline>
        </svg>
        <h3 class="m-0 text-base font-semibold {textClasses}">{$_t("Browser Tools")}</h3>
      </button>

      {#if browserToolsExpanded}
        <div class="p-4 border-t {isModern ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
          {#each [
            { id: 'storage-tool', bind: 'storage_tool', label: $_t("Storage Tool"), help: $_t("Access browser storage (localStorage, sessionStorage, cookies)") },
            { id: 'tab-tool', bind: 'tab_tool', label: $_t("Tab Tool"), help: $_t("Manage browser tabs (open, close, switch, query)") },
            { id: 'web-scraping-tool', bind: 'web_scraping_tool', label: $_t("Web Scraping Tool"), help: $_t("Extract structured data from web pages") },
            { id: 'dom-tool', bind: 'dom_tool', label: $_t("DOM Tool"), help: $_t("Query and manipulate the DOM (Document Object Model)") },
            { id: 'form-automation-tool', bind: 'form_automation_tool', label: $_t("Form Automation Tool"), help: $_t("Fill forms, submit data, interact with form elements") },
            { id: 'navigation-tool', bind: 'navigation_tool', label: $_t("Navigation Tool"), help: $_t("Navigate pages, click links, handle browser navigation") },
            { id: 'network-intercept-tool', bind: 'network_intercept_tool', label: $_t("Network Intercept Tool"), help: $_t("Intercept and modify network requests/responses") },
            { id: 'data-extraction-tool', bind: 'data_extraction_tool', label: $_t("Data Extraction Tool"), help: $_t("Extract specific data patterns from pages") },
            { id: 'page-action-tool', bind: 'page_action_tool', label: $_t("Page Action Tool"), help: $_t("Perform page actions (scroll, screenshot, wait)") },
            { id: 'page-vision-tool', bind: 'page_vision_tool', label: $_t("Page Vision Tool"), help: $_t("Visual analysis of page content and layout") }
          ] as tool}
            <div class="{tool !== undefined ? 'mb-6 last:mb-0' : ''}" data-setting-id={tool.id}>
              <label class="flex items-center gap-2 cursor-pointer text-[15px] {textClasses}">
                <input
                  type="checkbox"
                  bind:checked={currentTools[tool.bind]}
                  oninput={handleInput}
                  class="w-[18px] h-[18px] cursor-pointer {checkboxAccent}"
                />
                <span>{tool.label}</span>
              </label>
              <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{tool.help}</div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Agent Execution Tools Section -->
    <div class="rounded-xl border overflow-hidden {cardClasses}">
      <button
        class="w-full flex items-center gap-3 p-4 border-none cursor-pointer transition-colors duration-200
          {isModern
            ? 'bg-chat-surface dark:bg-chat-surface-dark hover:bg-chat-card-hover dark:hover:bg-chat-card-hover-dark'
            : 'bg-term-bg hover:bg-term-green/5'}"
        onclick={() => toggleSection('agent')}
        aria-expanded={agentToolsExpanded}
      >
        <svg
          class="shrink-0 transition-transform duration-200 stroke-2
            {agentToolsExpanded ? 'rotate-0' : '-rotate-90'}
            {textClasses}"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <polyline points="6,9 12,15 18,9"></polyline>
        </svg>
        <h3 class="m-0 text-base font-semibold {textClasses}">{$_t("Agent Execution Tools")}</h3>
      </button>

      {#if agentToolsExpanded}
        <div class="p-4 border-t {isModern ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
          <div class="mb-6" data-setting-id="exec-command">
            <label class="flex items-center gap-2 cursor-pointer text-[15px] {textClasses}">
              <input
                type="checkbox"
                bind:checked={currentTools.execCommand}
                oninput={handleInput}
                class="w-[18px] h-[18px] cursor-pointer {checkboxAccent}"
              />
              <span>{$_t("Execute Commands")}</span>
            </label>
            <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Allow agent to execute system commands (use with caution)")}</div>
          </div>

          <div class="mb-6" data-setting-id="web-search">
            <label class="flex items-center gap-2 cursor-pointer text-[15px] {textClasses}">
              <input
                type="checkbox"
                bind:checked={currentTools.webSearch}
                oninput={handleInput}
                class="w-[18px] h-[18px] cursor-pointer {checkboxAccent}"
              />
              <span>{$_t("Web Search")}</span>
            </label>
            <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Enable web search capabilities for the agent")}</div>
          </div>

          <div class="mb-6" data-setting-id="file-operations">
            <label class="flex items-center gap-2 cursor-pointer text-[15px] opacity-50 cursor-not-allowed {textClasses}">
              <input
                type="checkbox"
                bind:checked={currentTools.fileOperations}
                oninput={handleInput}
                disabled
                class="w-[18px] h-[18px] cursor-not-allowed {checkboxAccent}"
              />
              <span class="italic {textSecondaryClasses}">{$_t("File Operations (Not Available)")}</span>
            </label>
            <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Allow agent to read, write, and manage files (Coming in future update)")}</div>
          </div>

          <div data-setting-id="mcp-tools">
            <label class="flex items-center gap-2 cursor-pointer text-[15px] {textClasses}">
              <input
                type="checkbox"
                bind:checked={currentTools.mcpTools}
                oninput={handleInput}
                class="w-[18px] h-[18px] cursor-pointer {checkboxAccent}"
              />
              <span>{$_t("MCP Tools")}</span>
            </label>
            <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Enable Model Context Protocol tools from connected MCP servers")}</div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Advanced Configuration Section -->
    <div class="rounded-xl border overflow-hidden {cardClasses}">
      <button
        class="w-full flex items-center gap-3 p-4 border-none cursor-pointer transition-colors duration-200
          {isModern
            ? 'bg-chat-surface dark:bg-chat-surface-dark hover:bg-chat-card-hover dark:hover:bg-chat-card-hover-dark'
            : 'bg-term-bg hover:bg-term-green/5'}"
        onclick={() => toggleSection('advanced')}
        aria-expanded={advancedExpanded}
      >
        <svg
          class="shrink-0 transition-transform duration-200 stroke-2
            {advancedExpanded ? 'rotate-0' : '-rotate-90'}
            {textClasses}"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <polyline points="6,9 12,15 18,9"></polyline>
        </svg>
        <h3 class="m-0 text-base font-semibold {textClasses}">{$_t("Advanced Configuration")}</h3>
      </button>

      {#if advancedExpanded}
        <div class="p-4 border-t {isModern ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
          <!-- Timeout Configuration -->
          <div class="mb-6">
            <label for="tool-timeout" class="block mb-2 text-sm font-medium {textClasses}">{$_t("Tool Timeout (ms)")}</label>
            <input
              id="tool-timeout"
              type="number"
              min="100"
              bind:value={currentTools.timeout}
              oninput={handleInput}
              class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {inputClasses}"
              placeholder="30000"
            />
            <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Maximum time (in milliseconds) a tool can run before timeout (default: 30000)")}</div>
          </div>

          <!-- Legacy Sandbox Policy (non-desktop) -->
          {#if !isDesktop}
            <div>
              <label for="sandbox-mode" class="block mb-2 text-sm font-medium {textClasses}">{$_t("Sandbox Policy")}</label>
              <select
                id="sandbox-mode"
                bind:value={currentTools.sandboxPolicy.mode}
                oninput={handleInput}
                class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {selectClasses}"
              >
                <option value="read-only">{$_t("Read-only")}</option>
                <option value="workspace-write">{$_t("Workspace Write")}</option>
                <option value="danger-full-access">{$_t("Full Access (Dangerous)")}</option>
              </select>
              <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Security level for tool execution environment")}</div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Terminal Sandbox Settings (Desktop only) -->
    {#if isDesktop}
      <div class="rounded-xl border overflow-hidden {cardClasses}">
        <button
          class="w-full flex items-center gap-3 p-4 border-none cursor-pointer transition-colors duration-200
            {isModern
              ? 'bg-chat-surface dark:bg-chat-surface-dark hover:bg-chat-card-hover dark:hover:bg-chat-card-hover-dark'
              : 'bg-term-bg hover:bg-term-green/5'}"
          onclick={() => toggleSection('terminal-sandbox')}
          aria-expanded={terminalSandboxExpanded}
        >
          <svg
            class="shrink-0 transition-transform duration-200 stroke-2
              {terminalSandboxExpanded ? 'rotate-0' : '-rotate-90'}
              {textClasses}"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <polyline points="6,9 12,15 18,9"></polyline>
          </svg>
          <h3 class="m-0 text-base font-semibold {textClasses}">{$_t("Terminal Sandbox")}</h3>
          {#if sandboxStatus}
            <span class="ml-auto text-sm font-normal px-2 py-0.5 rounded
              {isModern
                ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark bg-chat-text-secondary/10 dark:bg-chat-text-secondary-dark/10'
                : 'text-term-dim-green bg-term-dim-green/10'}"
            >{sandboxStatus}</span>
          {/if}
        </button>

        {#if terminalSandboxExpanded}
          <div class="p-4 border-t {isModern ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
            <!-- Execution Mode -->
            <div class="mb-6">
              <label for="execution-mode" class="block mb-2 text-sm font-medium {textClasses}">{$_t("Execution Mode")}</label>
              <select
                id="execution-mode"
                bind:value={executionMode}
                onchange={handleExecutionModeChange}
                class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {selectClasses}"
              >
                <option value="auto">{$_t("Auto (default)")}</option>
                <option value="safe">{$_t("Safe")}</option>
                <option value="power">{$_t("Power")}</option>
              </select>
              <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">
                {#if executionMode === 'safe'}
                  {$_t("All commands run inside an OS-native sandbox. Writes restricted to workspace directory.")}
                {:else if executionMode === 'power'}
                  {$_t("Commands run directly on the host. Security filter still applies.")}
                {:else}
                  {$_t("The AI decides per-command whether to use sandbox based on risk assessment.")}
                {/if}
              </div>
            </div>

            <!-- Workspace Access -->
            <div class="mb-6">
              <label for="workspace-access" class="block mb-2 text-sm font-medium {textClasses}">{$_t("Workspace Access")}</label>
              <select
                id="workspace-access"
                bind:value={workspaceAccess}
                onchange={handleWorkspaceAccessChange}
                class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {selectClasses}"
              >
                <option value="rw">{$_t("Read-Write")}</option>
                <option value="ro">{$_t("Read-Only")}</option>
                <option value="none">{$_t("No Access")}</option>
              </select>
              <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("How the workspace directory is mounted in the sandbox")}</div>
            </div>

            <!-- Network Mode -->
            <div class="mb-6">
              <label for="network-mode" class="block mb-2 text-sm font-medium {textClasses}">{$_t("Network Access")}</label>
              <select
                id="network-mode"
                bind:value={networkMode}
                onchange={handleNetworkModeChange}
                class="w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {selectClasses}"
              >
                <option value="host">{$_t("Allowed")}</option>
                <option value="sandbox">{$_t("Restricted")}</option>
              </select>
              <div class="mt-1.5 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Whether sandboxed commands can access the network")}</div>
            </div>

            <!-- Bind Mounts -->
            <div data-setting-id="bind-mounts">
              <label class="block mb-2 text-sm font-medium {textClasses}">{$_t("Additional Bind Mounts")}</label>
              <div class="mb-2 text-sm leading-relaxed {textSecondaryClasses}">{$_t("Extra directories accessible inside the sandbox")}</div>

              {#if bindMounts.length > 0}
                <div class="flex flex-col gap-1.5 mb-2">
                  {#each bindMounts as mount, i}
                    <div class="flex items-center gap-2 py-1.5 px-2 rounded-md text-sm
                      {isModern
                        ? 'bg-chat-card-hover dark:bg-chat-card-hover-dark'
                        : 'bg-term-green/5'}"
                    >
                      <span class="flex-1 font-mono overflow-hidden text-ellipsis whitespace-nowrap {textClasses}">{mount.hostPath}</span>
                      <span class="text-sm font-medium uppercase {textSecondaryClasses}">{mount.access}</span>
                      <button
                        class="bg-transparent border-none cursor-pointer text-lg leading-none px-1
                          {isModern
                            ? 'text-chat-status-error dark:text-chat-status-error-dark'
                            : 'text-term-red'}"
                        onclick={() => removeBindMount(i)}
                        title="Remove"
                      >&times;</button>
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="flex gap-1.5 items-center">
                <input
                  type="text"
                  bind:value={newBindMountPath}
                  placeholder="/path/to/directory"
                  class="flex-1 w-full py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {inputClasses}"
                />
                <select bind:value={newBindMountAccess} class="w-[4.5rem] shrink-0 py-2.5 px-2.5 rounded-md text-sm transition-all duration-200 {selectClasses}">
                  <option value="ro">ro</option>
                  <option value="rw">rw</option>
                </select>
                <button
                  class="py-1.5 px-3 rounded-lg text-sm font-medium cursor-pointer transition-all duration-200 border
                    {isModern
                      ? 'font-chat border-chat-primary dark:border-chat-primary-dark text-chat-primary dark:text-chat-primary-dark bg-transparent hover:bg-chat-primary/15 dark:hover:bg-chat-primary-dark/15'
                      : 'font-terminal border-term-green text-term-green bg-transparent hover:bg-term-green/15'}"
                  onclick={addBindMount}
                >{$_t("Add")}</button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Save Button -->
    <div class="mt-8">
      <button
        class="py-3 px-6 rounded-lg text-sm font-medium cursor-pointer transition-all duration-200 border
          disabled:opacity-50 disabled:cursor-not-allowed
          {isModern
            ? 'font-chat border-chat-primary dark:border-chat-primary-dark text-chat-primary dark:text-chat-primary-dark bg-transparent hover:bg-chat-primary/15 dark:hover:bg-chat-primary-dark/15'
            : 'font-terminal border-term-green text-term-green bg-transparent hover:bg-term-green/15'}"
        onclick={handleSave}
        disabled={!isDirty || isSaving}
      >
        {isSaving ? $_t('Saving...') : $_t('Save Settings')}
      </button>
    </div>

    <!-- Save Message -->
    {#if saveMessage}
      <div class="flex items-center gap-2 p-3 rounded-lg text-sm mt-4
        {saveMessageType === 'success'
          ? (isModern
            ? 'text-chat-status-success dark:text-chat-status-success-dark bg-chat-status-success/10 dark:bg-chat-status-success-dark/10'
            : 'text-term-green bg-term-green/10')
          : (isModern
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
