<!--
  Skills - Standalone page for creating, managing, and configuring agent skills
  Feature 028: Agent Skills
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import type { SkillMeta, InvocationMode } from '@/core/skills/types';
  import { getInitializedUIClient } from '@/core/messaging';
  import { refreshSkillCommands } from '../../commands/builtinCommands';
  import { t, _t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  let currentTheme = $derived($uiTheme);

  // State
  let skills: SkillMeta[] = $state([]);
  let isLoading: boolean = $state(true);
  let saveMessage: string = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  // Create form state
  let showCreateForm: boolean = $state(false);
  let formName: string = $state('');
  let formDescription: string = $state('');
  let formBody: string = $state('');
  let formMode: InvocationMode = $state('manual');
  let formError: string = $state('');
  let isSaving: boolean = $state(false);

  // Import form state
  let showImportForm: boolean = $state(false);
  let importUrl: string = $state('');
  let isImporting: boolean = $state(false);

  onMount(async () => {
    await loadSkills();
  });

  async function loadSkills() {
    isLoading = true;
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<SkillMeta[]>('skills.list');
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
      await (await getInitializedUIClient()).serviceRequest('skills.save', {
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
      await refreshSkillCommands();
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
      await (await getInitializedUIClient()).serviceRequest('skills.delete', { name });
      await loadSkills();
      await refreshSkillCommands();
      showNotification('Skill deleted', 'success');
    } catch (error) {
      showNotification('Failed to delete skill', 'error');
    }
  }

  async function handleModeChange(name: string, modeValue: string) {
    const mode = modeValue as InvocationMode;
    try {
      await (await getInitializedUIClient()).serviceRequest('skills.updateMode', { name, mode });
      await loadSkills();
      await refreshSkillCommands();
    } catch (error) {
      showNotification('Failed to update mode', 'error');
    }
  }

  async function handleTrust(name: string) {
    try {
      await (await getInitializedUIClient()).serviceRequest('skills.trust', { name });
      await loadSkills();
      await refreshSkillCommands();
      showNotification('Skill trusted', 'success');
    } catch (error) {
      showNotification('Failed to trust skill', 'error');
    }
  }

  async function handleExport(name: string) {
    try {
      const response = await (await getInitializedUIClient()).serviceRequest<{ success: boolean; content: string }>(
        'skills.export',
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
      await (await getInitializedUIClient()).serviceRequest('skills.import', { url: importUrl.trim() });
      closeImportForm();
      await loadSkills();
      await refreshSkillCommands();
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

<svelte:window onkeydown={handleKeydown} />

<div class="h-full flex items-center justify-center {currentTheme === 'modern' ? 'bg-black/30' : 'bg-black/50'}">
  <div class="w-full max-w-[42rem] max-h-[80vh] overflow-y-auto rounded-lg flex flex-col
    {currentTheme === 'modern'
      ? 'rounded-2xl shadow-2xl bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border-none'
      : 'border border-term-dim-green bg-term-bg text-term-green'}">
    <!-- Header -->
    <div class="flex justify-between items-center px-6 py-4 border-b
      {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
      <h2 class="m-0 text-xl font-semibold
        {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}">{$_t('Skills')}</h2>
      <button
        class="bg-none border-none cursor-pointer p-1 rounded-md flex items-center justify-center transition-all duration-200
          {currentTheme === 'modern'
            ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark hover:text-chat-text dark:hover:text-chat-text-dark hover:bg-chat-surface dark:hover:bg-chat-surface-dark'
            : 'text-term-dim-green hover:text-term-green hover:bg-[#0a0a0a]'}"
        onclick={handleClose}
        aria-label={t("Close skills")}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="px-6 py-4 overflow-y-auto flex-1">
      {#if saveMessage}
        <div class="px-4 py-3 rounded-md mb-4 text-sm
          {saveMessageType === 'success'
            ? (currentTheme === 'modern'
                ? 'bg-bx-success/15 dark:bg-bx-success-dark/15 text-bx-success dark:text-bx-success-dark border border-bx-success/30 dark:border-bx-success-dark/30'
                : 'bg-term-green/15 text-term-green border border-term-green/30')
            : (currentTheme === 'modern'
                ? 'bg-chat-error/15 dark:bg-chat-error-dark/15 text-chat-error dark:text-chat-error-dark border border-chat-error/30 dark:border-chat-error-dark/30'
                : 'bg-term-red/15 text-term-red border border-term-red/30')}">{saveMessage}</div>
      {/if}

      <div class="flex gap-2 mb-6">
        <button
          class="px-4 py-2 rounded-md text-sm cursor-pointer border transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-chat-primary dark:bg-chat-primary-dark text-white border-chat-primary dark:border-chat-primary-dark hover:opacity-90'
              : 'bg-term-green text-white border-term-green hover:opacity-90'}"
          onclick={openCreateForm}
        >{$_t('Create Skill')}</button>
        <button
          class="px-4 py-2 rounded-md text-sm cursor-pointer border transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark hover:opacity-80'
              : 'bg-[#0a0a0a] text-term-green border-term-dim-green hover:opacity-80'}"
          onclick={openImportForm}
        >{$_t('Import from URL')}</button>
      </div>

      {#if showCreateForm}
        <div class="rounded-lg p-5 mb-6 border
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
            : 'bg-[#0a0a0a] border-term-dim-green'}">
          <h3 class="m-0 mb-4 text-base font-semibold
            {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}">{$_t('Create New Skill')}</h3>

          {#if formError}
            <div class="px-3 py-2 rounded-md text-sm mb-4
              {currentTheme === 'modern'
                ? 'bg-chat-error/15 dark:bg-chat-error-dark/15 text-chat-error dark:text-chat-error-dark'
                : 'bg-term-red/15 text-term-red'}">{formError}</div>
          {/if}

          <label class="block text-sm font-medium mb-4
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
            {$_t('Name')}
            <input
              type="text"
              class="block w-full px-3 py-2 mt-1 text-sm rounded-md border box-border
                {currentTheme === 'modern'
                  ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark'
                  : 'bg-term-bg text-term-green border-term-dim-green focus:outline-none focus:border-term-green'}"
              bind:value={formName}
              placeholder="my-skill-name"
            />
          </label>

          <label class="block text-sm font-medium mb-4
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
            {$_t('Description')}
            <input
              type="text"
              class="block w-full px-3 py-2 mt-1 text-sm rounded-md border box-border
                {currentTheme === 'modern'
                  ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark'
                  : 'bg-term-bg text-term-green border-term-dim-green focus:outline-none focus:border-term-green'}"
              bind:value={formDescription}
              placeholder="What this skill does"
            />
          </label>

          <label class="block text-sm font-medium mb-4
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
            {$_t('Invocation Mode')}
            <select class="block w-full px-3 py-2 mt-1 text-sm rounded-md border box-border color-scheme-inherit
              {currentTheme === 'modern'
                ? 'border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark'
                : 'border-term-dim-green focus:outline-none focus:border-term-green'}"
              bind:value={formMode}
            >
              <option value="manual">Manual (/ command only)</option>
              <option value="auto">Auto (LLM only)</option>
              <option value="hybrid">Hybrid (both)</option>
            </select>
          </label>

          <label class="block text-sm font-medium mb-4
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
            {$_t('Body (Markdown)')}
            <textarea
              class="block w-full px-3 py-2 mt-1 text-sm rounded-md border box-border font-mono resize-y
                {currentTheme === 'modern'
                  ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark'
                  : 'bg-term-bg text-term-green border-term-dim-green focus:outline-none focus:border-term-green'}"
              bind:value={formBody}
              placeholder="Skill instructions in markdown..."
              rows="8"
            ></textarea>
          </label>

          <div class="flex gap-2 justify-end">
            <button
              class="px-4 py-2 rounded-md text-sm cursor-pointer border transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark hover:opacity-80'
                  : 'bg-[#0a0a0a] text-term-green border-term-dim-green hover:opacity-80'}"
              onclick={closeCreateForm}
            >{$_t('Cancel')}</button>
            <button
              class="px-4 py-2 rounded-md text-sm cursor-pointer border transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-primary dark:bg-chat-primary-dark text-white border-chat-primary dark:border-chat-primary-dark hover:opacity-90'
                  : 'bg-term-green text-white border-term-green hover:opacity-90'}"
              onclick={handleCreate}
              disabled={isSaving}
            >
              {isSaving ? $_t('Creating...') : $_t('Create')}
            </button>
          </div>
        </div>
      {/if}

      {#if showImportForm}
        <div class="rounded-lg p-5 mb-6 border
          {currentTheme === 'modern'
            ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
            : 'bg-[#0a0a0a] border-term-dim-green'}">
          <h3 class="m-0 mb-4 text-base font-semibold
            {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}">{$_t('Import Skill from URL')}</h3>

          <label class="block text-sm font-medium mb-4
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
            {$_t('SKILL.md URL')}
            <input
              type="url"
              class="block w-full px-3 py-2 mt-1 text-sm rounded-md border box-border
                {currentTheme === 'modern'
                  ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark focus:outline-none focus:border-chat-primary dark:focus:border-chat-primary-dark'
                  : 'bg-term-bg text-term-green border-term-dim-green focus:outline-none focus:border-term-green'}"
              bind:value={importUrl}
              placeholder="https://example.com/SKILL.md"
            />
          </label>

          <p class="text-sm mt-2 mb-4
            {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{$_t('Imported skills are untrusted by default and cannot auto-invoke.')}</p>

          <div class="flex gap-2 justify-end">
            <button
              class="px-4 py-2 rounded-md text-sm cursor-pointer border transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark border-chat-border dark:border-chat-border-dark hover:opacity-80'
                  : 'bg-[#0a0a0a] text-term-green border-term-dim-green hover:opacity-80'}"
              onclick={closeImportForm}
            >{$_t('Cancel')}</button>
            <button
              class="px-4 py-2 rounded-md text-sm cursor-pointer border transition-all duration-200
                {currentTheme === 'modern'
                  ? 'bg-chat-primary dark:bg-chat-primary-dark text-white border-chat-primary dark:border-chat-primary-dark hover:opacity-90'
                  : 'bg-term-green text-white border-term-green hover:opacity-90'}"
              onclick={handleImport}
              disabled={isImporting}
            >
              {isImporting ? $_t('Importing...') : $_t('Import')}
            </button>
          </div>
        </div>
      {/if}

      {#if isLoading}
        <div class="flex flex-col items-center gap-3 py-12
          {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
          <div class="w-6 h-6 rounded-full animate-spin border-2
            {currentTheme === 'modern'
              ? 'border-chat-border dark:border-chat-border-dark border-t-chat-primary dark:border-t-chat-primary-dark'
              : 'border-term-dim-green border-t-term-green'}"></div>
          <span>{$_t('Loading skills...')}</span>
        </div>
      {:else if skills.length === 0}
        <div class="text-center py-12 {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">
          <p class="my-1">{$_t('No skills configured yet.')}</p>
          <p class="my-1 text-sm">{$_t('Create a skill to add custom / commands or auto-invocable agent behaviors.')}</p>
        </div>
      {:else}
        <div class="flex flex-col gap-3">
          {#each skills as skill (skill.name)}
            <div class="rounded-lg p-4 border
              {currentTheme === 'modern'
                ? 'bg-chat-surface dark:bg-chat-surface-dark border-chat-border dark:border-chat-border-dark'
                : 'bg-[#0a0a0a] border-term-dim-green'}">
              <div class="flex justify-between items-start mb-3 gap-2">
                <div class="flex flex-col gap-1 min-w-0">
                  <span class="font-semibold text-sm font-mono
                    {currentTheme === 'modern' ? 'text-chat-text dark:text-chat-text-dark' : 'text-term-green'}">/{skill.name}</span>
                  <span class="text-sm {currentTheme === 'modern' ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark' : 'text-term-dim-green'}">{skill.description}</span>
                </div>
                <div class="flex gap-1 shrink-0">
                  {#if !skill.trusted}
                    <span class="px-2 py-0.5 rounded-full text-sm font-medium uppercase tracking-wide
                      {currentTheme === 'modern'
                        ? 'bg-bx-warning/15 dark:bg-bx-warning-dark/15 text-bx-warning dark:text-bx-warning-dark'
                        : 'bg-term-yellow/15 text-term-yellow'}">{$_t('Untrusted')}</span>
                  {/if}
                  <span class="px-2 py-0.5 rounded-full text-sm font-medium uppercase tracking-wide
                    {currentTheme === 'modern'
                      ? 'bg-chat-primary/15 dark:bg-chat-primary-dark/15 text-chat-primary dark:text-chat-primary-dark'
                      : 'bg-term-green/15 text-term-green'}">{getModeLabel(skill.invocationMode)}</span>
                  <span class="px-2 py-0.5 rounded-full text-sm font-medium uppercase tracking-wide
                    {currentTheme === 'modern'
                      ? 'bg-chat-text-secondary/15 dark:bg-chat-text-secondary-dark/15 text-chat-text-secondary dark:text-chat-text-secondary-dark'
                      : 'bg-term-dim-green/15 text-term-dim-green'}">{skill.source}</span>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <select
                  class="px-2 py-1 text-sm rounded-md border color-scheme-inherit
                    {currentTheme === 'modern'
                      ? 'border-chat-border dark:border-chat-border-dark'
                      : 'border-term-dim-green'}"
                  value={skill.invocationMode}
                  onchange={(e) => handleModeChange(skill.name, (e.target as HTMLSelectElement).value)}
                >
                  <option value="manual">Manual</option>
                  <option value="auto">Auto</option>
                  <option value="hybrid">Hybrid</option>
                </select>

                {#if !skill.trusted}
                  <button
                    class="px-2 py-1 text-sm rounded-md border cursor-pointer transition-all duration-200
                      {currentTheme === 'modern'
                        ? 'bg-chat-surface dark:bg-chat-surface-dark text-bx-success dark:text-bx-success-dark border-bx-success dark:border-bx-success-dark hover:text-chat-text dark:hover:text-chat-text-dark'
                        : 'bg-[#0a0a0a] text-term-green border-term-green hover:text-term-bright-green'}"
                    onclick={() => handleTrust(skill.name)}
                  >
                    {$_t('Trust')}
                  </button>
                {/if}

                <button
                  class="px-2 py-1 text-sm rounded-md border cursor-pointer transition-all duration-200
                    {currentTheme === 'modern'
                      ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text-secondary dark:text-chat-text-secondary-dark border-chat-border dark:border-chat-border-dark hover:text-chat-text dark:hover:text-chat-text-dark'
                      : 'bg-[#0a0a0a] text-term-dim-green border-term-dim-green hover:text-term-green'}"
                  onclick={() => handleExport(skill.name)}
                >
                  {$_t('Export')}
                </button>

                <button
                  class="px-2 py-1 text-sm rounded-md border cursor-pointer transition-all duration-200
                    {currentTheme === 'modern'
                      ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text-secondary dark:text-chat-text-secondary-dark border-chat-border dark:border-chat-border-dark hover:text-chat-error dark:hover:text-chat-error-dark hover:border-chat-error dark:hover:border-chat-error-dark'
                      : 'bg-[#0a0a0a] text-term-dim-green border-term-dim-green hover:text-term-red hover:border-term-red'}"
                  onclick={() => handleDelete(skill.name)}
                >
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
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .animate-spin {
    animation: spin 0.8s linear infinite;
  }

  .color-scheme-inherit {
    background: revert;
    color: revert;
    color-scheme: inherit;
  }
</style>
