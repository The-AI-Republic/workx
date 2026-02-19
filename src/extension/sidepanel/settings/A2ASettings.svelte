<!--
  A2A Settings - Configure and manage A2A agent connections
  Task: T010 [021-a2a-agent-protocol]
-->

<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type {
    IA2AAgentConfig,
    IA2AAgentConfigCreate,
    IA2AConnection,
    IA2ASkill,
  } from '@/core/a2a/types';
  import { isDebugLoggingEnabled, setDebugLogging } from '@/core/a2a/A2AConfig';
  import { sendMessage, MessageType } from '../lib/messaging';
  import { _t } from '../lib/i18n';

  export let settingsConfig: AgentConfig;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  // State
  let agents: IA2AAgentConfig[] = [];
  let connections: IA2AConnection[] = [];
  let allSkills: Array<{ agentName: string; skill: IA2ASkill }> = [];
  let isDirty = false;
  let isLoading = true;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Add/Edit agent form state
  let showAgentForm = false;
  let editingAgentId: string | null = null;
  let formName = '';
  let formUrl = '';
  let formApiKey = '';
  let formAuthType: 'none' | 'apiKey' | 'bearer' = 'none';
  let formTimeout = 30000;
  let formEnabled = true;
  let formTrusted = false;
  let formError = '';

  // Collapsible sections state
  let agentsExpanded = true;
  let skillsExpanded = false;
  let advancedExpanded = false;

  // Debug logging state
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
      await Promise.all([loadAgents(), loadConnections(), loadSkills(), loadDebugLogging()]);
    } catch (error) {
      console.error('[A2ASettings] Failed to load data:', error);
      saveMessage = 'Failed to load A2A settings';
      saveMessageType = 'error';
    } finally {
      isLoading = false;
    }
  }

  async function loadDebugLogging() {
    try {
      debugLogging = await isDebugLoggingEnabled();
    } catch (error) {
      console.error('[A2ASettings] Failed to load debug logging setting:', error);
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

  async function loadAgents() {
    try {
      const response = await sendMessage<{ success: boolean; data?: IA2AAgentConfig[] }>(
        MessageType.A2A_GET_AGENTS
      );
      if (response?.success) {
        agents = response.data || [];
      }
    } catch (error) {
      console.error('[A2ASettings] Failed to load agents:', error);
    }
  }

  async function loadConnections() {
    try {
      const response = await sendMessage<{ success: boolean; data?: IA2AConnection[] }>(
        MessageType.A2A_GET_CONNECTIONS
      );
      if (response?.success) {
        connections = response.data || [];
      }
    } catch (error) {
      console.error('[A2ASettings] Failed to load connections:', error);
    }
  }

  async function loadSkills() {
    try {
      const response = await sendMessage<{ success: boolean; data?: Array<{ agentName: string; skill: IA2ASkill }> }>(
        MessageType.A2A_GET_ALL_SKILLS
      );
      if (response?.success) {
        allSkills = response.data || [];
      }
    } catch (error) {
      console.error('[A2ASettings] Failed to load skills:', error);
    }
  }

  function getConnectionStatus(agentId: string): IA2AConnection | undefined {
    return connections.find((c) => c.configId === agentId);
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

  function openAddAgentForm() {
    editingAgentId = null;
    formName = '';
    formUrl = '';
    formApiKey = '';
    formAuthType = 'none';
    formTimeout = 30000;
    formEnabled = true;
    formTrusted = false;
    formError = '';
    showAgentForm = true;
  }

  function openEditAgentForm(agent: IA2AAgentConfig) {
    editingAgentId = agent.id;
    formName = agent.name;
    formUrl = agent.url;
    formApiKey = ''; // Don't show existing API key for security
    formAuthType = agent.authType;
    formTimeout = agent.timeout;
    formEnabled = agent.enabled;
    formTrusted = agent.trusted;
    formError = '';
    showAgentForm = true;
  }

  function closeAgentForm() {
    showAgentForm = false;
    editingAgentId = null;
    formError = '';
  }

  async function handleSaveAgent() {
    // Validate form
    if (!formName.trim()) {
      formError = 'Agent name is required';
      return;
    }
    if (!formUrl.trim()) {
      formError = 'Agent URL is required';
      return;
    }

    // Validate name format (alphanumeric + hyphens)
    if (!/^[a-zA-Z0-9-]+$/.test(formName)) {
      formError = 'Agent name can only contain letters, numbers, and hyphens';
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
      if (editingAgentId) {
        // Update existing agent
        const updatePayload: any = {
          name: formName.trim(),
          url: formUrl.trim(),
          authType: formAuthType,
          timeout: formTimeout,
          enabled: formEnabled,
          trusted: formTrusted,
        };
        // Only include API key if provided (to allow keeping existing key)
        if (formApiKey.trim()) {
          updatePayload.apiKey = formApiKey.trim();
        }

        const response = await sendMessage<{ success: boolean; error?: string }>(
          MessageType.A2A_UPDATE_AGENT,
          {
            id: editingAgentId,
            update: updatePayload,
          }
        );

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to update agent');
        }
      } else {
        // Add new agent
        const createPayload: IA2AAgentConfigCreate = {
          name: formName.trim(),
          url: formUrl.trim(),
          authType: formAuthType,
          timeout: formTimeout,
          enabled: formEnabled,
          trusted: formTrusted,
        };
        if (formApiKey.trim()) {
          createPayload.apiKey = formApiKey.trim();
        }

        const response = await sendMessage<{ success: boolean; error?: string }>(
          MessageType.A2A_ADD_AGENT,
          createPayload
        );

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to add agent');
        }
      }

      closeAgentForm();
      await loadAgents();

      saveMessage = editingAgentId ? 'Agent updated successfully' : 'Agent added successfully';
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

  async function handleRemoveAgent(agentId: string) {
    if (!confirm('Are you sure you want to remove this agent?')) {
      return;
    }

    try {
      const response = await sendMessage<{ success: boolean; error?: string }>(
        MessageType.A2A_REMOVE_AGENT,
        { id: agentId }
      );

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to remove agent');
      }

      await loadAgents();
      await loadConnections();
      await loadSkills();

      saveMessage = 'Agent removed successfully';
      saveMessageType = 'success';
      setTimeout(() => {
        saveMessage = '';
        saveMessageType = '';
      }, 3000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      saveMessage = `Failed to remove agent: ${errorMsg}`;
      saveMessageType = 'error';
    }
  }

  async function handleConnect(agentId: string) {
    try {
      const response = await sendMessage<{ success: boolean; error?: string }>(
        MessageType.A2A_CONNECT,
        { id: agentId }
      );

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to connect');
      }

      await loadConnections();
      await loadSkills();

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

  async function handleDisconnect(agentId: string) {
    try {
      const response = await sendMessage<{ success: boolean; error?: string }>(
        MessageType.A2A_DISCONNECT,
        { id: agentId }
      );

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to disconnect');
      }

      await loadConnections();
      await loadSkills();

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

  function toggleSection(section: 'agents' | 'skills' | 'advanced') {
    if (section === 'agents') agentsExpanded = !agentsExpanded;
    else if (section === 'skills') skillsExpanded = !skillsExpanded;
    else if (section === 'advanced') advancedExpanded = !advancedExpanded;
  }
</script>

<div class="a2a-settings">
  <button class="back-button" on:click={handleBack}>← {$_t("Back")}</button>

  <h2 class="settings-title">{$_t("A2A Agents")}</h2>
  <p class="settings-description">
    {$_t("Connect to Agent-to-Agent (A2A) protocol agents to extend capabilities with external agent skills.")}
  </p>

  {#if isLoading}
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <span>{$_t("Loading...")}</span>
    </div>
  {:else}
    <div class="settings-form">
      <!-- Agent List Section -->
      <div class="collapsible-section settings-card">
        <button
          class="section-header"
          on:click={() => toggleSection('agents')}
          aria-expanded={agentsExpanded}
        >
          <svg
            class="expand-icon"
            class:expanded={agentsExpanded}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <polyline points="6,9 12,15 18,9"></polyline>
          </svg>
          <h3 class="section-title">{$_t("Configured Agents")} ({agents.length}/5)</h3>
        </button>

        {#if agentsExpanded}
          <div class="section-content">
            {#if agents.length === 0}
              <div class="empty-state">
                <p>{$_t("No A2A agents configured yet.")}</p>
                <p class="help-text">{$_t("Add an agent to connect to external skills.")}</p>
              </div>
            {:else}
              <div class="agent-list">
                {#each agents as agent (agent.id)}
                  {@const connection = getConnectionStatus(agent.id)}
                  <div class="agent-item">
                    <div class="agent-info">
                      <div class="agent-header">
                        <span class="agent-name">{agent.name}</span>
                        <span class="status-badge {getStatusBadgeClass(connection?.status || 'disconnected')}">
                          {connection?.status || 'disconnected'}
                        </span>
                        {#if agent.trusted}
                          <span class="trusted-badge">{$_t("trusted")}</span>
                        {/if}
                      </div>
                      <span class="agent-url">{agent.url}</span>
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
                      {#if connection?.agentCard}
                        <div class="agent-card-details">
                          <div class="card-field"><span class="card-label">{$_t("Agent")}:</span> {connection.agentCard.name}</div>
                          <div class="card-field"><span class="card-label">{$_t("Description")}:</span> {connection.agentCard.description}</div>
                          <div class="card-field"><span class="card-label">{$_t("Version")}:</span> {connection.agentCard.version}</div>
                          <div class="card-field"><span class="card-label">{$_t("Protocol")}:</span> {connection.agentCard.protocolVersion}</div>
                          {#if connection.skills.length > 0}
                            <div class="card-field"><span class="card-label">{$_t("Skills")}:</span> {connection.skills.length} {$_t("available")}</div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                    <div class="agent-actions">
                      {#if connection?.status === 'connected'}
                        <button
                          class="btn btn-small btn-secondary"
                          on:click={() => handleDisconnect(agent.id)}
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
                          on:click={() => handleConnect(agent.id)}
                        >
                          {$_t("Connect")}
                        </button>
                      {/if}
                      <button
                        class="btn btn-small btn-icon"
                        on:click={() => openEditAgentForm(agent)}
                        title={$_t("Edit")}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                      </button>
                      <button
                        class="btn btn-small btn-icon btn-danger"
                        on:click={() => handleRemoveAgent(agent.id)}
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

            {#if agents.length < 5}
              <button class="btn btn-secondary add-agent-btn" on:click={openAddAgentForm}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                {$_t("Add Agent")}
              </button>
            {:else}
              <p class="limit-message">{$_t("Maximum of 5 agents reached")}</p>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Skills Section -->
      <div class="collapsible-section settings-card">
        <button
          class="section-header"
          on:click={() => toggleSection('skills')}
          aria-expanded={skillsExpanded}
        >
          <svg
            class="expand-icon"
            class:expanded={skillsExpanded}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <polyline points="6,9 12,15 18,9"></polyline>
          </svg>
          <h3 class="section-title">{$_t("Available Skills")} ({allSkills.length})</h3>
        </button>

        {#if skillsExpanded}
          <div class="section-content">
            {#if allSkills.length === 0}
              <div class="empty-state">
                <p>{$_t("No skills available.")}</p>
                <p class="help-text">{$_t("Connect to an A2A agent to discover skills.")}</p>
              </div>
            {:else}
              <div class="skills-list">
                {#each allSkills as skillEntry (skillEntry.skill.id + '_' + skillEntry.agentName)}
                  <div class="skill-item">
                    <div class="skill-info">
                      <div class="skill-header">
                        <span class="skill-name">{skillEntry.skill.name}</span>
                        <span class="skill-agent">{skillEntry.agentName}</span>
                      </div>
                      {#if skillEntry.skill.description}
                        <p class="skill-description">{skillEntry.skill.description}</p>
                      {/if}
                      {#if skillEntry.skill.tags && skillEntry.skill.tags.length > 0}
                        <div class="skill-tags">
                          {#each skillEntry.skill.tags as tag}
                            <span class="skill-tag">{tag}</span>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Advanced Settings Section -->
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
            <div class="form-group">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  checked={debugLogging}
                  on:change={handleDebugLoggingChange}
                  class="form-checkbox"
                />
                <span>{$_t("Enable debug logging")}</span>
              </label>
              <div class="help-text">{$_t("Log A2A protocol messages to browser console for debugging")}</div>
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

  <!-- Add/Edit Agent Modal -->
  {#if showAgentForm}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title" on:click={closeAgentForm} on:keydown={(e) => e.key === 'Escape' && closeAgentForm()}>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="modal-content" on:click|stopPropagation on:keydown|stopPropagation>
        <div class="modal-header">
          <h3 id="modal-title">{editingAgentId ? $_t("Edit Agent") : $_t("Add Agent")}</h3>
          <button class="close-btn" on:click={closeAgentForm}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label for="agent-name" class="form-label">{$_t("Name")}</label>
            <input
              id="agent-name"
              type="text"
              bind:value={formName}
              class="form-input"
              placeholder="research-agent"
              maxlength="50"
            />
            <div class="help-text">{$_t("Alphanumeric characters and hyphens only (1-50 chars)")}</div>
          </div>

          <div class="form-group">
            <label for="agent-url" class="form-label">{$_t("URL")}</label>
            <input
              id="agent-url"
              type="url"
              bind:value={formUrl}
              class="form-input"
              placeholder="https://agent.example.com"
            />
            <div class="help-text">{$_t("The A2A agent endpoint URL (http or https)")}</div>
          </div>

          <div class="form-group">
            <label for="agent-auth-type" class="form-label">{$_t("Auth Type")}</label>
            <select
              id="agent-auth-type"
              bind:value={formAuthType}
              class="form-input form-select"
            >
              <option value="none">{$_t("None")}</option>
              <option value="apiKey">{$_t("API Key")}</option>
              <option value="bearer">{$_t("Bearer Token")}</option>
            </select>
            <div class="help-text">{$_t("Authentication method for the agent")}</div>
          </div>

          {#if formAuthType !== 'none'}
            <div class="form-group">
              <label for="agent-apikey" class="form-label">
                {formAuthType === 'bearer' ? $_t("Bearer Token") : $_t("API Key")}
              </label>
              <input
                id="agent-apikey"
                type="password"
                bind:value={formApiKey}
                class="form-input"
                placeholder={editingAgentId ? $_t("Leave empty to keep existing") : $_t("Enter API key or bearer token")}
              />
              <div class="help-text">{$_t("Authentication credential (stored encrypted)")}</div>
            </div>
          {/if}

          <div class="form-group">
            <label for="agent-timeout" class="form-label">{$_t("Timeout (ms)")}</label>
            <input
              id="agent-timeout"
              type="number"
              bind:value={formTimeout}
              class="form-input"
              min="5000"
              max="180000"
            />
            <div class="help-text">{$_t("Request timeout in milliseconds (5000-180000)")}</div>
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

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={formTrusted}
                class="form-checkbox"
              />
              <span>{$_t("Trusted")}</span>
            </label>
            <div class="help-text">{$_t("Trusted agents are auto-approved for skill invocations")}</div>
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
          <button class="btn btn-secondary" on:click={closeAgentForm}>
            {$_t("Cancel")}
          </button>
          <button
            class="btn btn-primary"
            on:click={handleSaveAgent}
            disabled={isSaving}
          >
            {isSaving ? $_t("Saving...") : editingAgentId ? $_t("Update") : $_t("Add")}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .a2a-settings {
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

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .agent-item {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 0.75rem;
    background: var(--browserx-background);
    border-radius: 0.5rem;
    border: 1px solid var(--browserx-border);
  }

  .agent-info {
    flex: 1;
    min-width: 0;
  }

  .agent-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .agent-name {
    font-weight: 600;
    color: var(--browserx-text);
  }

  .agent-url {
    font-size: 0.8125rem;
    color: var(--browserx-text-secondary);
    word-break: break-all;
  }

  .trusted-badge {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    background: color-mix(in srgb, var(--browserx-primary) 15%, transparent);
    color: var(--browserx-primary);
  }

  .status-badge {
    font-size: 0.6875rem;
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
    font-size: 0.8125rem;
    color: var(--browserx-error);
  }

  .error-message svg {
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .agent-card-details {
    margin-top: 0.5rem;
    padding: 0.625rem;
    background: color-mix(in srgb, var(--browserx-surface) 50%, var(--browserx-background));
    border-radius: 0.375rem;
    border: 1px solid var(--browserx-border);
  }

  .card-field {
    font-size: 0.8125rem;
    color: var(--browserx-text-secondary);
    margin-bottom: 0.25rem;
  }

  .card-field:last-child {
    margin-bottom: 0;
  }

  .card-label {
    font-weight: 600;
    color: var(--browserx-text);
  }

  .agent-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    margin-left: 0.75rem;
  }

  .add-agent-btn {
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

  .skills-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .skill-item {
    padding: 0.75rem;
    background: var(--browserx-background);
    border-radius: 0.5rem;
    border: 1px solid var(--browserx-border);
  }

  .skill-info {
    flex: 1;
    min-width: 0;
  }

  .skill-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .skill-name {
    font-weight: 600;
    color: var(--browserx-text);
  }

  .skill-agent {
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
    color: var(--browserx-primary);
    border-radius: 0.25rem;
  }

  .skill-description {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
  }

  .skill-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.375rem;
  }

  .skill-tag {
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    background: color-mix(in srgb, var(--browserx-text-secondary) 10%, transparent);
    color: var(--browserx-text-secondary);
    border-radius: 0.25rem;
    line-height: 1.3;
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
    font-size: 0.8125rem;
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

  .form-select {
    appearance: auto;
    cursor: pointer;
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
