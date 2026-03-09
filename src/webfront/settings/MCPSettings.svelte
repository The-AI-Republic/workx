<!--
  MCP Settings - Configure and manage MCP server connections
  Tasks: T024-T029 [US1]
-->

<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type {
    IMCPServerConfig,
    IMCPServerConfigCreate,
    IMCPConnection,
    IMCPTool,
  } from '@/core/mcp/types';
  import { isDebugLoggingEnabled, setDebugLogging } from '@/core/mcp/MCPConfig';
  import { getInitializedUIClient } from '@/core/messaging';
  import { _t } from '../lib/i18n';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  export let settingsConfig: AgentConfig;
  export let highlightSettingId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // Form state
  let servers: IMCPServerConfig[] = [];
  let connections: IMCPConnection[] = [];
  let allTools: IMCPTool[] = [];
  let isDirty = false;
  let isLoading = true;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Add/Edit server form state
  let showServerForm = false;
  let editingServerId: string | null = null;
  let formName = '';
  let formUrl = '';
  let formApiKey = '';
  let formTimeout = 30000;
  let formEnabled = true;
  let formError = '';

  // Collapsible sections state
  let serversExpanded = true;
  let toolsExpanded = false;
  let advancedExpanded = false;

  $: if (highlightSettingId) {
    highlightSetting(highlightSettingId, async () => {
      serversExpanded = true;
      toolsExpanded = true;
      advancedExpanded = true;
    });
    highlightSettingId = undefined;
  }

  // Debug logging state (T061)
  let debugLogging = false;

  // Polling interval for connection status
  let statusPollInterval: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await loadData();
    // Poll for connection status updates every 5 seconds
    statusPollInterval = setInterval(loadConnections, 5000);
  });

  onDestroy(() => {
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
    }
  });

  async function loadData() {
    isLoading = true;
    try {
      await Promise.all([loadServers(), loadConnections(), loadTools(), loadDebugLogging()]);
    } catch (error) {
      console.error('[MCPSettings] Failed to load data:', error);
      saveMessage = 'Failed to load MCP settings';
      saveMessageType = 'error';
    } finally {
      isLoading = false;
    }
  }

  async function loadDebugLogging() {
    try {
      debugLogging = await isDebugLoggingEnabled();
    } catch (error) {
      console.error('[MCPSettings] Failed to load debug logging setting:', error);
    }
  }

  async function handleDebugLoggingChange(event: Event) {
    const target = event.target as HTMLInputElement;
    debugLogging = target.checked;
    try {
      await setDebugLogging(debugLogging);
      saveMessage = debugLogging ? 'Debug logging enabled' : 'Debug logging disabled';
      saveMessageType = 'success';
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to save debug logging setting: ${errorMsg}`;
      saveMessageType = 'error';
    }
  }

  async function loadServers() {
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; data?: IMCPServerConfig[] }>(
        'mcp.getServers'
      );
      if (response?.success) {
        servers = response.data || [];
      }
    } catch (error) {
      console.error('[MCPSettings] Failed to load servers:', error);
    }
  }

  async function loadConnections() {
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; data?: IMCPConnection[] }>(
        'mcp.getConnections'
      );
      if (response?.success) {
        connections = response.data || [];
      }
    } catch (error) {
      console.error('[MCPSettings] Failed to load connections:', error);
    }
  }

  async function loadTools() {
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; data?: IMCPTool[] }>(
        'mcp.getAllTools'
      );
      if (response?.success) {
        allTools = response.data || [];
      }
    } catch (error) {
      console.error('[MCPSettings] Failed to load tools:', error);
    }
  }

  function getConnectionStatus(serverId: string): IMCPConnection | undefined {
    return connections.find((c) => c.configId === serverId);
  }

  function getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'connected':
        return 'badge-success';
      case 'connecting':
        return 'badge-warning';
      case 'error':
        return 'badge-error';
      default:
        return 'badge-neutral';
    }
  }

  function handleBack() {
    dispatch('back');
  }

  function openAddServerForm() {
    editingServerId = null;
    formName = '';
    formUrl = '';
    formApiKey = '';
    formTimeout = 30000;
    formEnabled = true;
    formError = '';
    showServerForm = true;
  }

  function openEditServerForm(server: IMCPServerConfig) {
    editingServerId = server.id;
    formName = server.name;
    formUrl = server.url;
    formApiKey = ''; // Don't show existing API key for security
    formTimeout = server.timeout;
    formEnabled = server.enabled;
    formError = '';
    showServerForm = true;
  }

  function closeServerForm() {
    showServerForm = false;
    editingServerId = null;
    formError = '';
  }

  async function handleSaveServer() {
    // Validate form
    if (!formName.trim()) {
      formError = 'Server name is required';
      return;
    }
    if (!formUrl.trim()) {
      formError = 'Server URL is required';
      return;
    }

    // Validate name format (alphanumeric + hyphens)
    if (!/^[a-zA-Z0-9-]+$/.test(formName)) {
      formError = 'Server name can only contain letters, numbers, and hyphens';
      return;
    }

    // Validate URL format
    try {
      const url = new URL(formUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        formError = 'URL must use http or https protocol';
        return;
      }
    } catch {
      formError = 'Invalid URL format';
      return;
    }

    isSaving = true;
    formError = '';

    try {
      if (editingServerId) {
        // Update existing server
        const updatePayload: any = {
          name: formName.trim(),
          url: formUrl.trim(),
          timeout: formTimeout,
          enabled: formEnabled,
        };
        // Only include API key if provided (to allow keeping existing key)
        if (formApiKey.trim()) {
          updatePayload.apiKey = formApiKey.trim();
        }

        const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; error?: string }>(
          'mcp.updateServer',
          {
            id: editingServerId,
            update: updatePayload,
          }
        );

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to update server');
        }
      } else {
        // Add new server
        const createPayload: IMCPServerConfigCreate = {
          name: formName.trim(),
          url: formUrl.trim(),
          timeout: formTimeout,
          enabled: formEnabled,
        };
        if (formApiKey.trim()) {
          createPayload.apiKey = formApiKey.trim();
        }

        const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; error?: string }>(
          'mcp.addServer',
          createPayload
        );

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to add server');
        }
      }

      closeServerForm();
      await loadServers();

      saveMessage = editingServerId ? 'Server updated successfully' : 'Server added successfully';
      saveMessageType = 'success';
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      formError = errorMsg;
    } finally {
      isSaving = false;
    }
  }

  async function handleRemoveServer(serverId: string) {
    if (!confirm('Are you sure you want to remove this server?')) {
      return;
    }

    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; error?: string }>(
        'mcp.removeServer',
        { id: serverId }
      );

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to remove server');
      }

      await loadServers();
      await loadConnections();
      await loadTools();

      saveMessage = 'Server removed successfully';
      saveMessageType = 'success';
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to remove server: ${errorMsg}`;
      saveMessageType = 'error';
    }
  }

  async function handleConnect(serverId: string) {
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; error?: string }>(
        'mcp.connect',
        { id: serverId }
      );

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to connect');
      }

      await loadConnections();
      await loadTools();

      saveMessage = 'Connected successfully';
      saveMessageType = 'success';
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to connect: ${errorMsg}`;
      saveMessageType = 'error';
    }
  }

  async function handleDisconnect(serverId: string) {
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; error?: string }>(
        'mcp.disconnect',
        { id: serverId }
      );

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to disconnect');
      }

      await loadConnections();
      await loadTools();

      saveMessage = 'Disconnected successfully';
      saveMessageType = 'success';
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to disconnect: ${errorMsg}`;
      saveMessageType = 'error';
    }
  }

  function toggleSection(section: 'servers' | 'tools' | 'advanced') {
    if (section === 'servers') serversExpanded = !serversExpanded;
    else if (section === 'tools') toolsExpanded = !toolsExpanded;
    else if (section === 'advanced') advancedExpanded = !advancedExpanded;
  }

  function getToolServerName(tool: IMCPTool): string {
    // Tool names are prefixed with "servername:" format
    const colonIndex = tool.name.indexOf(':');
    if (colonIndex > 0) {
      const serverName = tool.name.substring(0, colonIndex);
      return serverName;
    }
    return 'unknown';
  }

  function getToolDisplayName(tool: IMCPTool): string {
    const colonIndex = tool.name.indexOf(':');
    if (colonIndex > 0) {
      return tool.name.substring(colonIndex + 1);
    }
    return tool.name;
  }
</script>

<div class="mcp-settings">
  <button class="back-button" on:click={handleBack}>← {$_t("Back")}</button>

  <h2 class="settings-title">{$_t("MCP Servers")}</h2>
  <p class="settings-description">
    {$_t("Connect to Model Context Protocol (MCP) servers to extend the agent with external tools.")}
  </p>

  {#if isLoading}
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <span>{$_t("Loading...")}</span>
    </div>
  {:else}
    <div class="settings-form">
      <!-- Server List Section -->
      <div class="collapsible-section settings-card" data-setting-id="mcp-configured-servers">
        <button
          class="section-header"
          on:click={() => toggleSection('servers')}
          aria-expanded={serversExpanded}
        >
          <svg
            class="expand-icon"
            class:expanded={serversExpanded}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <polyline points="6,9 12,15 18,9"></polyline>
          </svg>
          <h3 class="section-title">{$_t("Configured Servers")} ({servers.length}/5)</h3>
        </button>

        {#if serversExpanded}
          <div class="section-content">
            {#if servers.length === 0}
              <div class="empty-state">
                <p>{$_t("No MCP servers configured yet.")}</p>
                <p class="help-text">{$_t("Add a server to connect to external tools.")}</p>
              </div>
            {:else}
              <div class="server-list">
                {#each servers as server (server.id)}
                  {@const connection = getConnectionStatus(server.id)}
                  <div class="server-item">
                    <div class="server-info">
                      <div class="server-header">
                        <span class="server-name">{server.name}</span>
                        <span class="status-badge {getStatusBadgeClass(connection?.status || 'disconnected')}">
                          {connection?.status || 'disconnected'}
                        </span>
                      </div>
                      <span class="server-url">{server.url}</span>
                      {#if connection?.lastError}
                        <div class="error-message">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="8" x2="12" y2="12"></line>
                            <line x1="12" y1="16" x2="12.01" y2="16"></line>
                          </svg>
                          {connection.lastError}
                        </div>
                      {/if}
                    </div>
                    <div class="server-actions">
                      {#if connection?.status === 'connected'}
                        <button
                          class="btn btn-small btn-secondary"
                          on:click={() => handleDisconnect(server.id)}
                        >
                          {$_t("Disconnect")}
                        </button>
                      {:else if connection?.status === 'connecting'}
                        <button class="btn btn-small btn-secondary" disabled>
                          {$_t("Connecting...")}
                        </button>
                      {:else}
                        <button
                          class="btn btn-small btn-primary"
                          on:click={() => handleConnect(server.id)}
                        >
                          {$_t("Connect")}
                        </button>
                      {/if}
                      <button
                        class="btn btn-small btn-icon"
                        on:click={() => openEditServerForm(server)}
                        title={$_t("Edit")}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                      </button>
                      <button
                        class="btn btn-small btn-icon btn-danger"
                        on:click={() => handleRemoveServer(server.id)}
                        title={$_t("Remove")}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if servers.length < 5}
              <button class="btn btn-secondary add-server-btn" on:click={openAddServerForm}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                {$_t("Add Server")}
              </button>
            {:else}
              <p class="limit-message">{$_t("Maximum of 5 servers reached")}</p>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Tools Section -->
      <div class="collapsible-section settings-card" data-setting-id="mcp-available-tools">
        <button
          class="section-header"
          on:click={() => toggleSection('tools')}
          aria-expanded={toolsExpanded}
        >
          <svg
            class="expand-icon"
            class:expanded={toolsExpanded}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <polyline points="6,9 12,15 18,9"></polyline>
          </svg>
          <h3 class="section-title">{$_t("Available Tools")} ({allTools.length})</h3>
        </button>

        {#if toolsExpanded}
          <div class="section-content">
            {#if allTools.length === 0}
              <div class="empty-state">
                <p>{$_t("No tools available.")}</p>
                <p class="help-text">{$_t("Connect to an MCP server to discover tools.")}</p>
              </div>
            {:else}
              <div class="tools-list">
                {#each allTools as tool (tool.name)}
                  <div class="tool-item">
                    <div class="tool-info">
                      <div class="tool-header">
                        <span class="tool-name">{getToolDisplayName(tool)}</span>
                        <span class="tool-server">{getToolServerName(tool)}</span>
                      </div>
                      {#if tool.description}
                        <p class="tool-description">{tool.description}</p>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Advanced Settings Section (T061) -->
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
          <h3 class="section-title">{$_t("Advanced Settings")}</h3>
        </button>

        {#if advancedExpanded}
          <div class="section-content">
            <div class="form-group" data-setting-id="mcp-debug-logging">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  checked={debugLogging}
                  on:change={handleDebugLoggingChange}
                  class="form-checkbox"
                />
                <span>{$_t("Enable debug logging")}</span>
              </label>
              <div class="help-text">{$_t("Log MCP protocol messages to browser console for debugging")}</div>
            </div>
          </div>
        {/if}
      </div>
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
  {/if}

  <!-- Add/Edit Server Modal -->
  {#if showServerForm}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title" on:click={closeServerForm} on:keydown={(e) => e.key === 'Escape' && closeServerForm()}>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="modal-content" on:click|stopPropagation on:keydown|stopPropagation>
        <div class="modal-header">
          <h3 id="modal-title">{editingServerId ? $_t("Edit Server") : $_t("Add Server")}</h3>
          <button class="close-btn" on:click={closeServerForm}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label for="server-name" class="form-label">{$_t("Name")}</label>
            <input
              id="server-name"
              type="text"
              bind:value={formName}
              class="form-input"
              placeholder="github"
              maxlength="50"
            />
            <div class="help-text">{$_t("Alphanumeric characters and hyphens only (1-50 chars)")}</div>
          </div>

          <div class="form-group">
            <label for="server-url" class="form-label">{$_t("URL")}</label>
            <input
              id="server-url"
              type="url"
              bind:value={formUrl}
              class="form-input"
              placeholder="https://mcp.example.com"
            />
            <div class="help-text">{$_t("The MCP server endpoint URL (http or https)")}</div>
          </div>

          <div class="form-group">
            <label for="server-apikey" class="form-label">{$_t("API Key")} ({$_t("optional")})</label>
            <input
              id="server-apikey"
              type="password"
              bind:value={formApiKey}
              class="form-input"
              placeholder={editingServerId ? $_t("Leave empty to keep existing") : $_t("Enter API key if required")}
            />
            <div class="help-text">{$_t("API key for authentication (stored encrypted)")}</div>
          </div>

          <div class="form-group">
            <label for="server-timeout" class="form-label">{$_t("Timeout (ms)")}</label>
            <input
              id="server-timeout"
              type="number"
              bind:value={formTimeout}
              class="form-input"
              min="5000"
              max="120000"
            />
            <div class="help-text">{$_t("Request timeout in milliseconds (5000-120000)")}</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={formEnabled}
                class="form-checkbox"
              />
              <span>{$_t("Enabled")}</span>
            </label>
            <div class="help-text">{$_t("Enable auto-connect when browserx starts")}</div>
          </div>

          {#if formError}
            <div class="form-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
              {formError}
            </div>
          {/if}
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" on:click={closeServerForm}>
            {$_t("Cancel")}
          </button>
          <button
            class="btn btn-primary"
            on:click={handleSaveServer}
            disabled={isSaving}
          >
            {isSaving ? $_t("Saving...") : editingServerId ? $_t("Update") : $_t("Add")}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .mcp-settings {
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
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .settings-description {
    margin: 0 0 1.5rem 0;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    line-height: 1.5;
  }

  .settings-form {
    max-width: 600px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .loading-container {
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

  .settings-card {
    background: var(--browserx-surface);
    border-radius: 0.75rem;
    border: 1px solid var(--browserx-border);
  }

  .collapsible-section {
    overflow: hidden;
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

  .empty-state {
    text-align: center;
    padding: 1.5rem;
    color: var(--browserx-text-secondary);
  }

  .empty-state p {
    margin: 0 0 0.5rem 0;
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .server-item {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 0.75rem;
    background: var(--browserx-background);
    border-radius: 0.5rem;
    border: 1px solid var(--browserx-border);
  }

  .server-info {
    flex: 1;
    min-width: 0;
  }

  .server-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .server-name {
    font-weight: 600;
    color: var(--browserx-text);
  }

  .server-url {
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    word-break: break-all;
  }

  .status-badge {
    font-size: 0.875rem;
    font-weight: 500;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .badge-success {
    background: color-mix(in srgb, var(--browserx-success) 15%, transparent);
    color: var(--browserx-success);
  }

  .badge-warning {
    background: color-mix(in srgb, var(--browserx-warning, #f59e0b) 15%, transparent);
    color: var(--browserx-warning, #f59e0b);
  }

  .badge-error {
    background: color-mix(in srgb, var(--browserx-error) 15%, transparent);
    color: var(--browserx-error);
  }

  .badge-neutral {
    background: color-mix(in srgb, var(--browserx-text-secondary) 15%, transparent);
    color: var(--browserx-text-secondary);
  }

  .error-message {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
    border-radius: 0.375rem;
    font-size: 0.875rem;
    color: var(--browserx-error);
  }

  .error-message svg {
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .server-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    margin-left: 0.75rem;
  }

  .add-server-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    margin-top: 0.5rem;
  }

  .limit-message {
    text-align: center;
    color: var(--browserx-text-secondary);
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }

  .tools-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .tool-item {
    padding: 0.75rem;
    background: var(--browserx-background);
    border-radius: 0.5rem;
    border: 1px solid var(--browserx-border);
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .tool-name {
    font-weight: 600;
    color: var(--browserx-text);
  }

  .tool-server {
    font-size: 0.875rem;
    padding: 0.125rem 0.375rem;
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
    color: var(--browserx-primary);
    border-radius: 0.25rem;
  }

  .tool-description {
    margin: 0;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
  }

  /* Buttons */
  .btn {
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid transparent;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--browserx-primary);
    color: white;
    border-color: var(--browserx-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 85%, black);
  }

  .btn-secondary {
    background: transparent;
    color: var(--browserx-primary);
    border-color: var(--browserx-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .btn-small {
    padding: 0.375rem 0.75rem;
    font-size: 0.875rem;
  }

  .btn-icon {
    padding: 0.375rem;
    background: transparent;
    border: none;
    color: var(--browserx-text-secondary);
  }

  .btn-icon:hover:not(:disabled) {
    color: var(--browserx-text);
    background: var(--browserx-border);
  }

  .btn-danger:hover:not(:disabled) {
    color: var(--browserx-error);
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
  }

  /* Form styles */
  .form-group {
    margin-bottom: 1rem;
  }

  .form-group:last-child {
    margin-bottom: 0;
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
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
  }

  .form-error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
    border-radius: 0.5rem;
    font-size: 0.875rem;
    color: var(--browserx-error);
    margin-top: 1rem;
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal-content {
    background: var(--browserx-background);
    border-radius: 0.75rem;
    width: 100%;
    max-width: 420px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--browserx-border);
  }

  .modal-header h3 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .close-btn {
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

  .close-btn:hover {
    color: var(--browserx-text);
    background: var(--browserx-surface);
  }

  .modal-body {
    padding: 1.25rem;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    border-top: 1px solid var(--browserx-border);
  }

  /* Messages */
  .message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    margin-top: 1rem;
    max-width: 600px;
  }

  .message.success {
    color: var(--browserx-success);
    background: color-mix(in srgb, var(--browserx-success) 10%, transparent);
  }

  .message.error {
    color: var(--browserx-error);
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
  }
</style>
