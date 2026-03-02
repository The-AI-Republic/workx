<!--
  Approval Settings - Configure approval mode, rules, trusted/blocked domains
-->

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { IApprovalConfig, ApprovalMode } from '@/core/approval/types';
  import { DEFAULT_APPROVAL_CONFIG } from '@/core/approval/types';
  import { t, _t } from '../lib/i18n';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';

  export let settingsConfig: AgentConfig;
  export let isDirty = false;
  export let highlightSettingId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  let config: IApprovalConfig = { ...DEFAULT_APPROVAL_CONFIG };
  let isLoading = true;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Domain input state
  let newTrustedDomain = '';
  let newBlockedDomain = '';

  $: if (highlightSettingId) {
    highlightSetting(highlightSettingId);
    highlightSettingId = undefined;
  }

  const APPROVAL_MODES: ApprovalMode[] = ['balanced', 'high_speed', 'yolo'];

  const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
    balanced: t('Ask for medium-risk and above (risk > 30). Recommended for most users.'),
    high_speed: t('Ask only for high-risk actions (risk > 60). For experienced users.'),
    yolo: t('Auto-approve everything. Deny rules still apply. Use at your own risk.'),
  };

  function formatModeLabel(mode: ApprovalMode): string {
    return mode.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  onMount(async () => {
    await loadConfig();
  });

  async function loadConfig() {
    try {
      isLoading = true;
      // Load from storage
      const stored = await loadFromStorage();
      if (stored) {
        config = { ...DEFAULT_APPROVAL_CONFIG, ...stored };
      }
    } catch (error) {
      console.error('[ApprovalSettings] Failed to load config:', error);
    } finally {
      isLoading = false;
    }
  }

  async function loadFromStorage(): Promise<IApprovalConfig | null> {
    try {
      const result = await chrome.storage.local.get('agent_config');
      return result['agent_config']?.approval || null;
    } catch {
      return null;
    }
  }

  async function handleSave() {
    try {
      isSaving = true;
      // Use UPDATE_APPROVAL_CONFIG message to save to storage AND update ApprovalGate in-memory
      await new Promise<void>((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'UPDATE_APPROVAL_CONFIG', config },
          (response: any) => {
            if (response?.success) resolve();
            else reject(new Error(response?.error || 'Failed to update config'));
          }
        );
      });
      isDirty = false;
      saveMessage = t('Settings saved successfully');
      saveMessageType = 'success';
      dispatch('saved', { success: true });
    } catch (error) {
      saveMessage = t('Failed to save: $1$', { substitutions: [error instanceof Error ? error.message : 'Unknown error'] });
      saveMessageType = 'error';
    } finally {
      isSaving = false;
      setTimeout(() => { saveMessage = ''; saveMessageType = ''; }, 3000);
    }
  }

  function handleModeChange(mode: ApprovalMode) {
    config.mode = mode;
    isDirty = true;
  }

  function addTrustedDomain() {
    const domain = newTrustedDomain.trim().toLowerCase();
    if (!domain || config.trustedDomains.includes(domain)) return;
    config.trustedDomains = [...config.trustedDomains, domain];
    newTrustedDomain = '';
    isDirty = true;
  }

  function removeTrustedDomain(domain: string) {
    config.trustedDomains = config.trustedDomains.filter(d => d !== domain);
    isDirty = true;
  }

  function addBlockedDomain() {
    const domain = newBlockedDomain.trim().toLowerCase();
    if (!domain || config.blockedDomains.includes(domain)) return;
    config.blockedDomains = [...config.blockedDomains, domain];
    newBlockedDomain = '';
    isDirty = true;
  }

  function removeBlockedDomain(domain: string) {
    config.blockedDomains = config.blockedDomains.filter(d => d !== domain);
    isDirty = true;
  }
</script>

<div class="approval-settings">
  <div class="settings-nav">
    <button class="back-button" on:click={() => dispatch('back')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"></path>
      </svg>
      {$_t("Back")}
    </button>
    <h3 class="section-title">{$_t("Approval & Safety")}</h3>
  </div>

  {#if isLoading}
    <div class="loading">{$_t("Loading settings...")}</div>
  {:else}
    <div class="settings-body">
      <!-- Approval Mode -->
      <section class="setting-section" data-setting-id="approval-mode">
        <h4 class="subsection-title">{$_t("Approval Mode")}</h4>
        <p class="subsection-description">{$_t("Controls how aggressively the agent asks for approval.")}</p>

        <div class="mode-options">
          {#each APPROVAL_MODES as mode}
            <label class="mode-option" class:selected={config.mode === mode}>
              <input
                type="radio"
                name="approval-mode"
                value={mode}
                checked={config.mode === mode}
                on:change={() => handleModeChange(mode)}
              />
              <div class="mode-content">
                <span class="mode-label">{formatModeLabel(mode)}</span>
                <span class="mode-desc">{MODE_DESCRIPTIONS[mode]}</span>
              </div>
            </label>
          {/each}
        </div>
      </section>

      <!-- Trusted Domains -->
      <section class="setting-section" data-setting-id="trusted-domains">
        <h4 class="subsection-title">{$_t("Trusted Domains")}</h4>
        <p class="subsection-description">{$_t("All actions are auto-approved on these domains.")}</p>

        <div class="domain-input-row">
          <input
            type="text"
            bind:value={newTrustedDomain}
            placeholder="example.com"
            class="domain-input"
            on:keydown={(e) => e.key === 'Enter' && addTrustedDomain()}
          />
          <button class="add-button" on:click={addTrustedDomain}>{$_t("Add")}</button>
        </div>

        {#if config.trustedDomains.length > 0}
          <div class="domain-list">
            {#each config.trustedDomains as domain}
              <div class="domain-tag trusted">
                <span>{domain}</span>
                <button class="remove-tag" on:click={() => removeTrustedDomain(domain)}>x</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Blocked Domains -->
      <section class="setting-section" data-setting-id="blocked-domains">
        <h4 class="subsection-title">{$_t("Blocked Domains")}</h4>
        <p class="subsection-description">{$_t("All actions are denied on these domains.")}</p>

        <div class="domain-input-row">
          <input
            type="text"
            bind:value={newBlockedDomain}
            placeholder="dangerous-site.com"
            class="domain-input"
            on:keydown={(e) => e.key === 'Enter' && addBlockedDomain()}
          />
          <button class="add-button" on:click={addBlockedDomain}>{$_t("Add")}</button>
        </div>

        {#if config.blockedDomains.length > 0}
          <div class="domain-list">
            {#each config.blockedDomains as domain}
              <div class="domain-tag blocked">
                <span>{domain}</span>
                <button class="remove-tag" on:click={() => removeBlockedDomain(domain)}>x</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Save Button -->
      <div class="save-section">
        <button
          class="save-button"
          disabled={!isDirty || isSaving}
          on:click={handleSave}
        >
          {isSaving ? $_t('Saving...') : $_t('Save Changes')}
        </button>
        {#if saveMessage}
          <span class="save-message" class:success={saveMessageType === 'success'} class:error={saveMessageType === 'error'}>
            {saveMessage}
          </span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .approval-settings {
    padding: 1.5rem;
  }

  .settings-nav {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .back-button {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    background: none;
    border: none;
    color: var(--browserx-primary);
    cursor: pointer;
    font-size: 0.875rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    transition: background 0.2s;
  }

  .back-button:hover {
    background: var(--browserx-surface);
  }

  .section-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .settings-body {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .setting-section {
    padding: 1rem;
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
  }

  .subsection-title {
    margin: 0 0 0.25rem 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .subsection-description {
    margin: 0 0 0.75rem 0;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
  }

  .mode-options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .mode-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .mode-option:hover {
    border-color: var(--browserx-primary);
  }

  .mode-option.selected {
    border-color: var(--browserx-primary);
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .mode-option input[type="radio"] {
    margin-top: 0.125rem;
  }

  .mode-content {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .mode-label {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--browserx-text);
  }

  .mode-desc {
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
  }

  .domain-input-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .domain-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    background: var(--browserx-background);
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    color: var(--browserx-text);
  }

  .domain-input::placeholder {
    color: var(--browserx-text-secondary);
  }

  .add-button {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    background: var(--browserx-primary);
    color: white;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .add-button:hover {
    opacity: 0.9;
  }

  .domain-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .domain-tag {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
    border-radius: 0.25rem;
  }

  .domain-tag.trusted {
    background: rgba(34, 197, 94, 0.15);
    color: rgb(74, 222, 128);
  }

  .domain-tag.blocked {
    background: rgba(239, 68, 68, 0.15);
    color: rgb(248, 113, 113);
  }

  .remove-tag {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 0.875rem;
    padding: 0;
    opacity: 0.6;
    transition: opacity 0.2s;
  }

  .remove-tag:hover {
    opacity: 1;
  }

  .save-section {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .save-button {
    padding: 0.625rem 1.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    background: var(--browserx-primary);
    color: white;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .save-message {
    font-size: 0.875rem;
  }

  .save-message.success {
    color: rgb(74, 222, 128);
  }

  .save-message.error {
    color: rgb(248, 113, 113);
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    color: var(--browserx-text-secondary);
  }
</style>
