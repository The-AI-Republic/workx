<script lang="ts">
  import {
    SHORTCUT_ACTION_META,
    formatBinding,
    getBindingForAction,
    type ShortcutActionMeta,
  } from '@/core/shortcuts';
  import { shortcutStore } from './shortcutStore';

  const actions: ShortcutActionMeta[] = Object.values(SHORTCUT_ACTION_META)
    .filter((action) => action.configurable)
    .sort((a, b) => a.defaultContext.localeCompare(b.defaultContext) || a.label.localeCompare(b.label));
</script>

<div class="shortcut-help">
  {#each actions as action (action.action)}
    {@const binding = getBindingForAction(action.action, action.defaultContext, $shortcutStore.bindings)}
    <div class="shortcut-row">
      <div class="shortcut-copy">
        <div class="shortcut-label">{action.label}</div>
        <div class="shortcut-description">{action.description}</div>
      </div>
      <kbd>{formatBinding(binding, $shortcutStore.platform) || 'Unassigned'}</kbd>
    </div>
  {/each}
</div>

<style>
  .shortcut-help {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    border-bottom: 1px solid var(--workx-border, #333);
  }

  .shortcut-copy {
    min-width: 0;
  }

  .shortcut-label {
    font-weight: 600;
  }

  .shortcut-description {
    margin-top: 2px;
    font-size: 12px;
    opacity: 0.72;
  }

  kbd {
    flex-shrink: 0;
    padding: 4px 8px;
    border: 1px solid var(--workx-border, #444);
    border-radius: 4px;
    background: color-mix(in srgb, var(--workx-surface, #111) 90%, white);
    font: inherit;
    font-size: 12px;
  }
</style>
