<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IToolsConfig } from '@/config/types';
  import { _t } from '../lib/i18n';
  import { notifyConfigUpdate } from '../lib/messaging';
  import { invoke } from '@tauri-apps/api/core';

  export let settingsConfig: AgentConfig;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // Form state
  let originalTools: IToolsConfig = {};
  let currentTools: IToolsConfig = {};
  let isDirty = false;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Terminal sandbox settings (persisted via Tauri config_storage)
  let executionMode: 'safe' | 'power' | 'auto' = 'auto';
  let workspaceAccess: 'rw' | 'ro' | 'none' = 'rw';
  let networkMode: 'host' | 'sandbox' = 'host';
  let bindMounts: Array<{ hostPath: string; access: 'rw' | 'ro' }> = [];
  let newBindMountPath = '';
  let newBindMountAccess: 'rw' | 'ro' = 'ro';
  let sandboxStatus: string | null = null;
  let isDesktop = false;

  // Collapsible sections state
  let browserToolsExpanded = true;
  let agentToolsExpanded = true;
  let advancedExpanded = false;
  let terminalSandboxExpanded = false;

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
      saveMessage = 'Failed to load settings';
      saveMessageType = 'error';
    }
  }

  async function loadTerminalSandboxSettings() {
    try {
      await invoke('config_storage_get', { key: 'test' });
      isDesktop = true;
    } catch {
      isDesktop = false;
      return;
    }

    try {
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
      saveMessage = 'Bind mount path must be absolute';
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
    dispatch('back');
  }

  async function handleSave() {
    if (!isDirty) return;

    try {
      isSaving = true;
      await settingsConfig.updateConfig({ tools: currentTools });

      // Notify backend of config update
      notifyConfigUpdate();

      originalTools = { ...currentTools };
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
      console.error('[ToolsSettings] Failed to save settings:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save settings: ${errorMsg}`;
      saveMessageType = 'error';

      dispatch('saved', { success: false, error: errorMsg });
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
</script>

<div class="tools-settings">
  <button class="back-button" on:click={handleBack}>← {$_t("Back")}</button>

  <h2 class="settings-title">{$_t("Tools Settings")}</h2>

  <div class="settings-form">
    <!-- Master Toggle -->
    <div class="settings-card">
      <div class="form-group">
        <label class="checkbox-label master-toggle">
          <input
            type="checkbox"
            bind:checked={currentTools.enable_all_tools}
            on:input={handleInput}
            class="form-checkbox"
          />
          <span>{$_t("Enable All Tools")}</span>
        </label>
        <div class="help-text">{$_t("Master toggle to enable or disable all browser and agent tools")}</div>
      </div>
    </div>

    <!-- Browser Tools Section -->
    <div class="collapsible-section settings-card">
      <button
        class="section-header"
        on:click={() => toggleSection('browser')}
        aria-expanded={browserToolsExpanded}
      >
        <svg
          class="expand-icon"
          class:expanded={browserToolsExpanded}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <polyline points="6,9 12,15 18,9"></polyline>
        </svg>
        <h3 class="section-title">{$_t("Browser Tools")}</h3>
      </button>

      {#if browserToolsExpanded}
        <div class="section-content">
          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.storage_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Storage Tool")}</span>
            </label>
            <div class="help-text">{$_t("Access browser storage (localStorage, sessionStorage, cookies)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.tab_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Tab Tool")}</span>
            </label>
            <div class="help-text">{$_t("Manage browser tabs (open, close, switch, query)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.web_scraping_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Web Scraping Tool")}</span>
            </label>
            <div class="help-text">{$_t("Extract structured data from web pages")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.dom_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("DOM Tool")}</span>
            </label>
            <div class="help-text">{$_t("Query and manipulate the DOM (Document Object Model)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.form_automation_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Form Automation Tool")}</span>
            </label>
            <div class="help-text">{$_t("Fill forms, submit data, interact with form elements")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.navigation_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Navigation Tool")}</span>
            </label>
            <div class="help-text">{$_t("Navigate pages, click links, handle browser navigation")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.network_intercept_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Network Intercept Tool")}</span>
            </label>
            <div class="help-text">{$_t("Intercept and modify network requests/responses")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.data_extraction_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Data Extraction Tool")}</span>
            </label>
            <div class="help-text">{$_t("Extract specific data patterns from pages")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.page_action_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Page Action Tool")}</span>
            </label>
            <div class="help-text">{$_t("Perform page actions (scroll, screenshot, wait)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.page_vision_tool}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Page Vision Tool")}</span>
            </label>
            <div class="help-text">{$_t("Visual analysis of page content and layout")}</div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Agent Execution Tools Section -->
    <div class="collapsible-section settings-card">
      <button
        class="section-header"
        on:click={() => toggleSection('agent')}
        aria-expanded={agentToolsExpanded}
      >
        <svg
          class="expand-icon"
          class:expanded={agentToolsExpanded}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <polyline points="6,9 12,15 18,9"></polyline>
        </svg>
        <h3 class="section-title">{$_t("Agent Execution Tools")}</h3>
      </button>

      {#if agentToolsExpanded}
        <div class="section-content">
          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.execCommand}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Execute Commands")}</span>
            </label>
            <div class="help-text">{$_t("Allow agent to execute system commands (use with caution)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.webSearch}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("Web Search")}</span>
            </label>
            <div class="help-text">{$_t("Enable web search capabilities for the agent")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label disabled-option">
              <input
                type="checkbox"
                bind:checked={currentTools.fileOperations}
                on:input={handleInput}
                disabled
                class="form-checkbox"
              />
              <span>{$_t("File Operations (Not Available)")}</span>
            </label>
            <div class="help-text">{$_t("Allow agent to read, write, and manage files (Coming in future update)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={currentTools.mcpTools}
                on:input={handleInput}
                class="form-checkbox"
              />
              <span>{$_t("MCP Tools")}</span>
            </label>
            <div class="help-text">{$_t("Enable Model Context Protocol tools from connected MCP servers")}</div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Advanced Configuration Section -->
    <div class="collapsible-section settings-card">
      <button
        class="section-header"
        on:click={() => toggleSection('advanced')}
        aria-expanded={advancedExpanded}
      >
        <svg
          class="expand-icon"
          class:expanded={advancedExpanded}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <polyline points="6,9 12,15 18,9"></polyline>
        </svg>
        <h3 class="section-title">{$_t("Advanced Configuration")}</h3>
      </button>

      {#if advancedExpanded}
        <div class="section-content">
          <!-- Timeout Configuration -->
          <div class="form-group">
            <label for="tool-timeout" class="form-label">{$_t("Tool Timeout (ms)")}</label>
            <input
              id="tool-timeout"
              type="number"
              min="100"
              bind:value={currentTools.timeout}
              on:input={handleInput}
              class="form-input"
              placeholder="30000"
            />
            <div class="help-text">{$_t("Maximum time (in milliseconds) a tool can run before timeout (default: 30000)")}</div>
          </div>

          <!-- Legacy Sandbox Policy (non-desktop) -->
          {#if !isDesktop}
            <div class="form-group">
              <label for="sandbox-mode" class="form-label">{$_t("Sandbox Policy")}</label>
              <select
                id="sandbox-mode"
                bind:value={currentTools.sandboxPolicy.mode}
                on:input={handleInput}
                class="form-select"
              >
                <option value="read-only">{$_t("Read-only")}</option>
                <option value="workspace-write">{$_t("Workspace Write")}</option>
                <option value="danger-full-access">{$_t("Full Access (Dangerous)")}</option>
              </select>
              <div class="help-text">{$_t("Security level for tool execution environment")}</div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Terminal Sandbox Settings (Desktop only) -->
    {#if isDesktop}
      <div class="collapsible-section settings-card">
        <button
          class="section-header"
          on:click={() => toggleSection('terminal-sandbox')}
          aria-expanded={terminalSandboxExpanded}
        >
          <svg
            class="expand-icon"
            class:expanded={terminalSandboxExpanded}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <polyline points="6,9 12,15 18,9"></polyline>
          </svg>
          <h3 class="section-title">{$_t("Terminal Sandbox")}</h3>
          {#if sandboxStatus}
            <span class="status-badge">{sandboxStatus}</span>
          {/if}
        </button>

        {#if terminalSandboxExpanded}
          <div class="section-content">
            <!-- Execution Mode -->
            <div class="form-group">
              <label for="execution-mode" class="form-label">{$_t("Execution Mode")}</label>
              <select
                id="execution-mode"
                bind:value={executionMode}
                on:change={handleExecutionModeChange}
                class="form-select"
              >
                <option value="auto">{$_t("Auto (default)")}</option>
                <option value="safe">{$_t("Safe")}</option>
                <option value="power">{$_t("Power")}</option>
              </select>
              <div class="help-text">
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
            <div class="form-group">
              <label for="workspace-access" class="form-label">{$_t("Workspace Access")}</label>
              <select
                id="workspace-access"
                bind:value={workspaceAccess}
                on:change={handleWorkspaceAccessChange}
                class="form-select"
              >
                <option value="rw">{$_t("Read-Write")}</option>
                <option value="ro">{$_t("Read-Only")}</option>
                <option value="none">{$_t("No Access")}</option>
              </select>
              <div class="help-text">{$_t("How the workspace directory is mounted in the sandbox")}</div>
            </div>

            <!-- Network Mode -->
            <div class="form-group">
              <label for="network-mode" class="form-label">{$_t("Network Access")}</label>
              <select
                id="network-mode"
                bind:value={networkMode}
                on:change={handleNetworkModeChange}
                class="form-select"
              >
                <option value="host">{$_t("Allowed")}</option>
                <option value="sandbox">{$_t("Restricted")}</option>
              </select>
              <div class="help-text">{$_t("Whether sandboxed commands can access the network")}</div>
            </div>

            <!-- Bind Mounts -->
            <div class="form-group">
              <label class="form-label">{$_t("Additional Bind Mounts")}</label>
              <div class="help-text" style="margin-bottom: 0.5rem;">{$_t("Extra directories accessible inside the sandbox")}</div>

              {#if bindMounts.length > 0}
                <div class="bind-mount-list">
                  {#each bindMounts as mount, i}
                    <div class="bind-mount-item">
                      <span class="bind-mount-path">{mount.hostPath}</span>
                      <span class="bind-mount-access">{mount.access}</span>
                      <button class="bind-mount-remove" on:click={() => removeBindMount(i)} title="Remove">×</button>
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="bind-mount-add">
                <input
                  type="text"
                  bind:value={newBindMountPath}
                  placeholder="/path/to/directory"
                  class="form-input bind-mount-input"
                />
                <select bind:value={newBindMountAccess} class="form-select bind-mount-access-select">
                  <option value="ro">ro</option>
                  <option value="rw">rw</option>
                </select>
                <button class="btn btn-small" on:click={addBindMount}>{$_t("Add")}</button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Save Button -->
    <div class="button-group">
      <button
        class="btn btn-primary"
        on:click={handleSave}
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
  .tools-settings {
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
    border: 1px solid var(--browserx-border);
  }

  .settings-card:not(.collapsible-section) {
    padding: 1rem 1.25rem;
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

  .form-input {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    background: var(--browserx-surface);
    color: var(--browserx-text);
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
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

  .checkbox-label.master-toggle {
    font-weight: 600;
    font-size: 1rem;
  }

  .checkbox-label.disabled-option {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox-label.disabled-option span {
    color: var(--browserx-text-secondary);
    font-style: italic;
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

  .collapsible-section {
    margin-bottom: 0;
    overflow: hidden;
  }

  .collapsible-section.settings-card {
    border-radius: 0.75rem;
  }

  .section-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--browserx-surface);
    border: none;
    cursor: pointer;
    transition: background 0.2s;
  }

  .section-header:hover {
    background: color-mix(in srgb, var(--browserx-surface) 90%, var(--browserx-text));
  }

  .section-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .expand-icon {
    flex-shrink: 0;
    transition: transform 0.2s;
    stroke-width: 2;
  }

  .expand-icon.expanded {
    transform: rotate(0deg);
  }

  .expand-icon:not(.expanded) {
    transform: rotate(-90deg);
  }

  .section-content {
    padding: 1rem;
    border-top: 1px solid var(--browserx-border);
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
    border: 1px solid var(--browserx-primary);
    background: transparent;
    color: var(--browserx-primary);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 15%, transparent);
  }

  /* ChatGPT theme - filled buttons */
  :global(.settings-modal-container.chatgpt) .btn-primary {
    background: var(--browserx-primary);
    color: white;
    border: none;
  }

  :global(.settings-modal-container.chatgpt) .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 85%, black);
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

  .status-badge {
    margin-left: auto;
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--browserx-text-secondary);
    background: color-mix(in srgb, var(--browserx-text-secondary) 10%, transparent);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }

  .bind-mount-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-bottom: 0.5rem;
  }

  .bind-mount-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    background: color-mix(in srgb, var(--browserx-surface) 90%, var(--browserx-text));
    border-radius: 0.375rem;
    font-size: 0.8125rem;
  }

  .bind-mount-path {
    flex: 1;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bind-mount-access {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--browserx-text-secondary);
    text-transform: uppercase;
  }

  .bind-mount-remove {
    background: none;
    border: none;
    color: var(--browserx-error);
    cursor: pointer;
    font-size: 1.125rem;
    line-height: 1;
    padding: 0 0.25rem;
  }

  .bind-mount-add {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  .bind-mount-input {
    flex: 1;
  }

  .bind-mount-access-select {
    width: 4.5rem;
    flex-shrink: 0;
  }

  .btn-small {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
  }
</style>
