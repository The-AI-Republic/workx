<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import {
    SHORTCUT_ACTION_META,
    DEFAULT_SHORTCUT_BINDINGS,
    formatBinding,
    getBindingForAction,
    getEffectiveShortcutBindings,
    normalizeShortcutPreferences,
    validateShortcutBlocks,
    type ShortcutAction,
    type ShortcutBindingBlock,
    type ShortcutPlatform,
    type ShortcutUserConfig,
  } from '@/core/shortcuts';
  import { t } from '../lib/i18n';
  import { reloadShortcutStore } from '../shortcuts/shortcutStore';
  import { detectShortcutPlatform } from '@/core/shortcuts/platformAdapters';

  let {
    settingsConfig,
    isDirty = $bindable(false),
    onBack,
    onSaved,
  }: {
    settingsConfig: AgentConfig;
    isDirty?: boolean;
    onBack?: () => void;
    onSaved?: (detail: { success: boolean; error?: string }) => void;
  } = $props();

  let platform: ShortcutPlatform = detectShortcutPlatform();
  let shortcutsValue: unknown = $state(undefined);
  let editValues: Record<string, string> = $state({});
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | '' = $state('');

  const actions = Object.values(SHORTCUT_ACTION_META)
    .filter((action) => action.configurable)
    .sort((a, b) => a.defaultContext.localeCompare(b.defaultContext) || a.label.localeCompare(b.label));

  let effective = $derived(getEffectiveShortcutBindings(shortcutsValue, { platform }));

  function loadShortcuts() {
    shortcutsValue = settingsConfig.getConfig().preferences?.shortcuts ?? {};
    const loaded = getEffectiveShortcutBindings(shortcutsValue, { platform });
    const nextValues: Record<string, string> = {};
    for (const action of actions) {
      const binding = getBindingForAction(action.action, action.defaultContext, loaded.bindings);
      nextValues[action.action] = binding?.original ?? '';
    }
    editValues = nextValues;
  }

  onMount(() => {
    loadShortcuts();
  });

  function getVersionedConfig(): ShortcutUserConfig {
    const normalized = normalizeShortcutPreferences(shortcutsValue);
    return normalized.config
      ? {
          version: 1,
          bindings: normalized.config.bindings.map((block) => ({
            context: block.context,
            bindings: { ...block.bindings },
          })),
        }
      : { version: 1, bindings: [] };
  }

  function removeAction(config: ShortcutUserConfig, action: ShortcutAction): void {
    for (const block of config.bindings) {
      for (const [key, value] of Object.entries(block.bindings)) {
        if (value === action) {
          delete block.bindings[key];
        }
      }
    }
    config.bindings = config.bindings.filter((block) => Object.keys(block.bindings).length > 0);
  }

  function getDefaultKeysForAction(action: ShortcutAction): string[] {
    const keys: string[] = [];
    for (const block of DEFAULT_SHORTCUT_BINDINGS) {
      for (const [key, value] of Object.entries(block.bindings)) {
        if (value === action) keys.push(key);
      }
    }
    return keys;
  }

  function ensureBlock(config: ShortcutUserConfig, context: ShortcutBindingBlock['context']): ShortcutBindingBlock {
    let block = config.bindings.find((item) => item.context === context);
    if (!block) {
      block = { context, bindings: {} };
      config.bindings.push(block);
    }
    return block;
  }

  async function saveAction(action: ShortcutAction) {
    const meta = SHORTCUT_ACTION_META[action];
    const key = editValues[action]?.trim();
    const next = getVersionedConfig();
    removeAction(next, action);
    const block = ensureBlock(next, meta.defaultContext);
    for (const defaultKey of getDefaultKeysForAction(action)) {
      if (defaultKey !== key) {
        block.bindings[defaultKey] = null;
      }
    }
    if (key) {
      block.bindings[key] = action;
    }

    const issues = validateShortcutBlocks(next.bindings, { platform, source: 'user' });
    const error = issues.find((issue) => issue.severity === 'error');
    if (error) {
      saveMessage = error.message;
      saveMessageType = 'error';
      return;
    }

    await saveConfig(next);
  }

  async function resetAction(action: ShortcutAction) {
    const next = getVersionedConfig();
    removeAction(next, action);
    await saveConfig(next.bindings.length > 0 ? next : { version: 1, bindings: [] });
  }

  async function resetAll() {
    await saveConfig({ version: 1, bindings: [] });
  }

  async function saveConfig(shortcuts: ShortcutUserConfig) {
    try {
      const config = settingsConfig.getConfig();
      settingsConfig.updateConfig({
        preferences: { ...config.preferences, shortcuts },
      });
      shortcutsValue = shortcuts;
      isDirty = false;
      await reloadShortcutStore();
      loadShortcuts();
      saveMessage = t('Keyboard shortcuts saved');
      saveMessageType = 'success';
      onSaved?.({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      saveMessage = message;
      saveMessageType = 'error';
      onSaved?.({ success: false, error: message });
    }
  }

  function markDirty(action: ShortcutAction, value: string) {
    editValues = { ...editValues, [action]: value };
    isDirty = true;
  }
</script>

<div class="settings-section">
  <div class="settings-section-header">
    <button class="back-button" onclick={onBack}>{t('Back')}</button>
    <h3>{t('Keyboard Shortcuts')}</h3>
    <button class="reset-button" onclick={resetAll}>{t('Reset all')}</button>
  </div>

  {#if saveMessage}
    <div class="save-message {saveMessageType}">{saveMessage}</div>
  {/if}

  <div class="shortcut-list">
    {#each actions as action (action.action)}
      {@const binding = getBindingForAction(action.action, action.defaultContext, effective.bindings)}
      <div class="shortcut-row">
        <div class="shortcut-copy">
          <div class="shortcut-label">{action.label}</div>
          <div class="shortcut-description">{action.description}</div>
          <div class="shortcut-current">{t('Current')}: {formatBinding(binding, platform) || t('Unassigned')}</div>
        </div>
        <div class="shortcut-controls">
          <input
            value={editValues[action.action] ?? ''}
            oninput={(event) => markDirty(action.action, (event.currentTarget as HTMLInputElement).value)}
            aria-label={t('Shortcut for $1$', { substitutions: [action.label] })}
          />
          <button onclick={() => saveAction(action.action)}>{t('Save')}</button>
          <button onclick={() => resetAction(action.action)}>{t('Reset')}</button>
        </div>
      </div>
    {/each}
  </div>

  {#if effective.warnings.length > 0}
    <div class="warnings">
      {#each effective.warnings as warning}
        <div class="warning">{warning.message}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .settings-section {
    padding: 1.5rem;
  }

  .settings-section-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .settings-section-header h3 {
    flex: 1;
    margin: 0;
  }

  button,
  input {
    font: inherit;
  }

  .back-button,
  .reset-button,
  .shortcut-controls button {
    border: 1px solid var(--browserx-border);
    background: var(--browserx-surface);
    color: var(--browserx-text);
    border-radius: 4px;
    padding: 0.45rem 0.65rem;
    cursor: pointer;
  }

  .save-message {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border-radius: 4px;
  }

  .save-message.success {
    color: #16a34a;
  }

  .save-message.error {
    color: #dc2626;
  }

  .shortcut-list {
    display: flex;
    flex-direction: column;
  }

  .shortcut-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
    gap: 1rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--browserx-border);
  }

  .shortcut-label {
    font-weight: 600;
  }

  .shortcut-description,
  .shortcut-current,
  .warning {
    font-size: 0.85rem;
    opacity: 0.75;
    margin-top: 0.25rem;
  }

  .shortcut-controls {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.5rem;
    align-items: center;
  }

  .shortcut-controls input {
    min-width: 0;
    border: 1px solid var(--browserx-border);
    background: var(--browserx-bg);
    color: var(--browserx-text);
    border-radius: 4px;
    padding: 0.45rem 0.55rem;
  }

  .warnings {
    margin-top: 1rem;
  }

  @media (max-width: 720px) {
    .shortcut-row {
      grid-template-columns: 1fr;
    }
  }
</style>
