<!--
  Skills - Standalone page for creating, managing, and configuring agent skills
  Feature 028: Agent Skills
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import type { SkillMeta, InvocationMode } from '@/core/skills/types';
  import { sendMessage, MessageType } from '../../lib/messaging';
  import { t, _t } from '../../lib/i18n';
  import { uiTheme, type UITheme } from '../../stores/themeStore';

  let currentTheme: UITheme = 'terminal';
  const unsubTheme = uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // State
  let skills: SkillMeta[] = [];
  let isLoading = true;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Create form state
  let showCreateForm = false;
  let formName = '';
  let formDescription = '';
  let formBody = '';
  let formMode: InvocationMode = 'manual';
  let formError = '';
  let isSaving = false;

  // Import form state
  let showImportForm = false;
  let importUrl = '';
  let isImporting = false;

  onMount(async () => {
    await loadSkills();
    return () => {
      unsubTheme();
    };
  });

  async function loadSkills() {
    isLoading = true;
    try {
      const response = await sendMessage<SkillMeta[]>(MessageType.SKILLS_LIST);
      skills = Array.isArray(response) ? response : [];
    } catch (error) {
      console.error('[Skills] Failed to load skills:', error);
      saveMessage = 'Failed to load skills';
      saveMessageType = 'error';
    } finally {
      isLoading = false;
    }
  }

  function openCreateForm() {
    formName = '';
    formDescription = '';
    formBody = '';
    formMode = 'manual';
    formError = '';
    showCreateForm = true;
  }

  function closeCreateForm() {
    showCreateForm = false;
    formError = '';
  }

  async function handleCreate() {
    formError = '';

    if (!formName.trim()) {
      formError = 'Name is required';
      return;
    }
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(formName)) {
      formError = 'Name must be lowercase alphanumeric with hyphens (e.g., my-skill)';
      return;
    }
    if (!formDescription.trim()) {
      formError = 'Description is required';
      return;
    }
    if (!formBody.trim()) {
      formError = 'Body content is required';
      return;
    }

    isSaving = true;
    try {
      const now = new Date().toISOString();
      await sendMessage(MessageType.SKILLS_SAVE, {
        name: formName.trim(),
        description: formDescription.trim(),
        body: formBody,
        invocationMode: formMode,
        trusted: true,
        source: 'user',
        createdAt: now,
        updatedAt: now,
      });
      closeCreateForm();
      await loadSkills();
      showNotification('Skill created successfully', 'success');
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Failed to create skill';
    } finally {
      isSaving = false;
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(t('Are you sure you want to delete the skill "/$1$"?', { substitutions: [name] }))) {
      return;
    }
    try {
      await sendMessage(MessageType.SKILLS_DELETE, { name });
      await loadSkills();
      showNotification('Skill deleted', 'success');
    } catch (error) {
      showNotification('Failed to delete skill', 'error');
    }
  }

  async function handleModeChange(name: string, modeValue: string) {
    const mode = modeValue as InvocationMode;
    try {
      await sendMessage(MessageType.SKILLS_UPDATE_MODE, { name, mode });
      await loadSkills();
    } catch (error) {
      showNotification('Failed to update mode', 'error');
    }
  }

  async function handleTrust(name: string) {
    try {
      await sendMessage(MessageType.SKILLS_TRUST, { name });
      await loadSkills();
      showNotification('Skill trusted', 'success');
    } catch (error) {
      showNotification('Failed to trust skill', 'error');
    }
  }

  async function handleExport(name: string) {
    try {
      const response = await sendMessage<{ success: boolean; content: string }>(
        MessageType.SKILLS_EXPORT,
        { name }
      );
      if (response?.content) {
        await navigator.clipboard.writeText(response.content);
        showNotification('SKILL.md copied to clipboard', 'success');
      }
    } catch (error) {
      showNotification('Failed to export skill', 'error');
    }
  }

  function openImportForm() {
    importUrl = '';
    showImportForm = true;
  }

  function closeImportForm() {
    showImportForm = false;
  }

  async function handleImport() {
    if (!importUrl.trim()) return;

    isImporting = true;
    try {
      await sendMessage(MessageType.SKILLS_IMPORT, { url: importUrl.trim() });
      closeImportForm();
      await loadSkills();
      showNotification('Skill imported (untrusted)', 'success');
    } catch (error) {
      showNotification(
        error instanceof Error ? error.message : 'Failed to import skill',
        'error'
      );
    } finally {
      isImporting = false;
    }
  }

  function showNotification(message: string, type: 'success' | 'error') {
    saveMessage = message;
    saveMessageType = type;
    setTimeout(() => {
      saveMessage = '';
      saveMessageType = '';
    }, 3000);
  }

  function getModeLabel(mode: InvocationMode): string {
    switch (mode) {
      case 'manual': return 'Manual (/ only)';
      case 'auto': return 'Auto (LLM only)';
      case 'hybrid': return 'Hybrid (both)';
      default: return mode;
    }
  }

  function handleClose() {
    push('/');
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleClose();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="skills-page" class:chatgpt={currentTheme === 'chatgpt'}>
  <div class="skills-container">
    <!-- Header -->
    <div class="skills-header">
      <h2 class="skills-title">{$_t('Skills')}</h2>
      <button class="close-button" on:click={handleClose} aria-label={t("Close skills")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="skills-content">
      <!-- Notification -->
      {#if saveMessage}
        <div class="notification {saveMessageType}">{saveMessage}</div>
      {/if}

      <!-- Actions -->
      <div class="actions-bar">
        <button class="btn btn-primary" on:click={openCreateForm}>{$_t('Create Skill')}</button>
        <button class="btn btn-secondary" on:click={openImportForm}>{$_t('Import from URL')}</button>
      </div>

      <!-- Create Form -->
      {#if showCreateForm}
        <div class="form-card">
          <h3>{$_t('Create New Skill')}</h3>

          {#if formError}
            <div class="form-error">{formError}</div>
          {/if}

          <label class="form-label">
            {$_t('Name')}
            <input
              type="text"
              class="form-input"
              bind:value={formName}
              placeholder="my-skill-name"
            />
          </label>

          <label class="form-label">
            {$_t('Description')}
            <input
              type="text"
              class="form-input"
              bind:value={formDescription}
              placeholder="What this skill does"
            />
          </label>

          <label class="form-label">
            {$_t('Invocation Mode')}
            <select class="form-input" bind:value={formMode}>
              <option value="manual">Manual (/ command only)</option>
              <option value="auto">Auto (LLM only)</option>
              <option value="hybrid">Hybrid (both)</option>
            </select>
          </label>

          <label class="form-label">
            {$_t('Body (Markdown)')}
            <textarea
              class="form-textarea"
              bind:value={formBody}
              placeholder="Skill instructions in markdown..."
              rows="8"
            ></textarea>
          </label>

          <div class="form-actions">
            <button class="btn btn-secondary" on:click={closeCreateForm}>{$_t('Cancel')}</button>
            <button class="btn btn-primary" on:click={handleCreate} disabled={isSaving}>
              {isSaving ? $_t('Creating...') : $_t('Create')}
            </button>
          </div>
        </div>
      {/if}

      <!-- Import Form -->
      {#if showImportForm}
        <div class="form-card">
          <h3>{$_t('Import Skill from URL')}</h3>

          <label class="form-label">
            {$_t('SKILL.md URL')}
            <input
              type="url"
              class="form-input"
              bind:value={importUrl}
              placeholder="https://example.com/SKILL.md"
            />
          </label>

          <p class="form-hint">{$_t('Imported skills are untrusted by default and cannot auto-invoke.')}</p>

          <div class="form-actions">
            <button class="btn btn-secondary" on:click={closeImportForm}>{$_t('Cancel')}</button>
            <button class="btn btn-primary" on:click={handleImport} disabled={isImporting}>
              {isImporting ? $_t('Importing...') : $_t('Import')}
            </button>
          </div>
        </div>
      {/if}

      <!-- Skills List -->
      {#if isLoading}
        <div class="loading">
          <div class="loading-spinner"></div>
          <span>{$_t('Loading skills...')}</span>
        </div>
      {:else if skills.length === 0}
        <div class="empty-state">
          <p>{$_t('No skills configured yet.')}</p>
          <p class="empty-hint">{$_t('Create a skill to add custom / commands or auto-invocable agent behaviors.')}</p>
        </div>
      {:else}
        <div class="skills-list">
          {#each skills as skill (skill.name)}
            <div class="skill-card">
              <div class="skill-header-row">
                <div class="skill-info">
                  <span class="skill-name">/{skill.name}</span>
                  <span class="skill-description">{skill.description}</span>
                </div>
                <div class="skill-badges">
                  {#if !skill.trusted}
                    <span class="badge badge-warning">{$_t('Untrusted')}</span>
                  {/if}
                  <span class="badge badge-mode">{getModeLabel(skill.invocationMode)}</span>
                  <span class="badge badge-source">{skill.source}</span>
                </div>
              </div>

              <div class="skill-actions">
                <select
                  class="mode-select"
                  value={skill.invocationMode}
                  on:change={(e) => handleModeChange(skill.name, e.currentTarget.value)}
                >
                  <option value="manual">Manual</option>
                  <option value="auto">Auto</option>
                  <option value="hybrid">Hybrid</option>
                </select>

                {#if !skill.trusted}
                  <button class="btn btn-small btn-trust" on:click={() => handleTrust(skill.name)}>
                    {$_t('Trust')}
                  </button>
                {/if}

                <button class="btn btn-small" on:click={() => handleExport(skill.name)}>
                  {$_t('Export')}
                </button>

                <button class="btn btn-small btn-danger" on:click={() => handleDelete(skill.name)}>
                  {$_t('Delete')}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .skills-page {
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

  /* ChatGPT theme */
  .skills-page.chatgpt {
    --browserx-primary: var(--chat-primary, #60a5fa);
    --browserx-secondary: var(--chat-primary, #60a5fa);
    --browserx-background: var(--chat-bg, #ffffff);
    --browserx-surface: var(--chat-card-bg, #f7f7f8);
    --browserx-text: var(--chat-text, #0d0d0d);
    --browserx-text-secondary: var(--chat-text-secondary, #6e6e80);
    --browserx-border: var(--chat-border, #e5e5e5);
    --browserx-error: var(--chat-error, #ef4444);
    --browserx-success: #10b981;
    --browserx-warning: #f59e0b;
    background: rgba(0, 0, 0, 0.3);
    color-scheme: light;
  }

  .skills-container {
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

  .skills-page.chatgpt .skills-container {
    border-radius: 1rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }

  .skills-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--browserx-border);
  }

  .skills-title {
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

  .skills-content {
    padding: 1rem 1.5rem;
    overflow-y: auto;
    flex: 1;
  }

  /* Notification */
  .notification {
    padding: 0.75rem 1rem;
    border-radius: 0.375rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .notification.success {
    background: color-mix(in srgb, var(--browserx-success) 15%, transparent);
    color: var(--browserx-success);
    border: 1px solid color-mix(in srgb, var(--browserx-success) 30%, transparent);
  }

  .notification.error {
    background: color-mix(in srgb, var(--browserx-error) 15%, transparent);
    color: var(--browserx-error);
    border: 1px solid color-mix(in srgb, var(--browserx-error) 30%, transparent);
  }

  /* Actions */
  .actions-bar {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    cursor: pointer;
    border: 1px solid var(--browserx-border);
    transition: all 0.2s;
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
    opacity: 0.9;
  }

  .btn-secondary {
    background: var(--browserx-surface);
    color: var(--browserx-text);
  }

  .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-surface) 80%, var(--browserx-text));
  }

  .btn-small {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: var(--browserx-surface);
    color: var(--browserx-text-secondary);
  }

  .btn-small:hover {
    color: var(--browserx-text);
  }

  .btn-danger:hover {
    color: var(--browserx-error);
    border-color: var(--browserx-error);
  }

  .btn-trust {
    color: var(--browserx-success);
    border-color: var(--browserx-success);
  }

  /* Form */
  .form-card {
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
    padding: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .form-card h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .form-error {
    background: color-mix(in srgb, var(--browserx-error) 15%, transparent);
    color: var(--browserx-error);
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .form-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text-secondary);
    margin-bottom: 1rem;
  }

  .form-input,
  .form-textarea {
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem;
    margin-top: 0.25rem;
    font-size: 0.875rem;
    background: var(--browserx-background);
    color: var(--browserx-text);
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    box-sizing: border-box;
  }

  /* Let <select> use system rendering so dropdown options are visible in dark themes */
  select.form-input {
    background: revert;
    color: revert;
    color-scheme: inherit;
  }

  .form-input:focus,
  .form-textarea:focus {
    outline: none;
    border-color: var(--browserx-primary);
  }

  .form-textarea {
    font-family: monospace;
    resize: vertical;
  }

  .form-hint {
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
    margin: 0.5rem 0 1rem;
  }

  .form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  /* Skills List */
  .skills-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .skill-card {
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .skill-header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.75rem;
    gap: 0.5rem;
  }

  .skill-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .skill-name {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--browserx-text);
    font-family: monospace;
  }

  .skill-description {
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
  }

  .skill-badges {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .badge {
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.625rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .badge-warning {
    background: color-mix(in srgb, var(--browserx-warning) 15%, transparent);
    color: var(--browserx-warning);
  }

  .badge-mode {
    background: color-mix(in srgb, var(--browserx-primary) 15%, transparent);
    color: var(--browserx-primary);
  }

  .badge-source {
    background: color-mix(in srgb, var(--browserx-text-secondary) 15%, transparent);
    color: var(--browserx-text-secondary);
  }

  .skill-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .mode-select {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    color-scheme: inherit;
  }

  /* Loading & Empty */
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
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
    to { transform: rotate(360deg); }
  }

  .empty-state {
    text-align: center;
    padding: 3rem;
    color: var(--browserx-text-secondary);
  }

  .empty-state p {
    margin: 0.25rem 0;
  }

  .empty-hint {
    font-size: 0.875rem;
  }
</style>
