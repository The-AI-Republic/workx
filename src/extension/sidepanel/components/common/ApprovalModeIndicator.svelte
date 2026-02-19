<!--
  ApprovalModeIndicator - Traffic-light button showing current approval mode
  with popup selector for switching between modes.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import type { ApprovalMode, IApprovalConfig } from '@/core/approval/types';
  import { STORAGE_KEYS } from '@/config/defaults';

  let currentTheme: UITheme = 'terminal';
  let currentMode: ApprovalMode = 'balanced';
  let showPopup = false;

  const MODE_OPTIONS: { mode: ApprovalMode; label: string; description: string; color: string }[] = [
    { mode: 'balanced', label: 'Balanced', description: 'Medium-risk and above', color: '#22c55e' },
    { mode: 'high_speed', label: 'High Speed', description: 'Only high-risk actions', color: '#eab308' },
    { mode: 'yolo', label: 'YOLO', description: 'Auto-approve everything', color: '#ef4444' },
  ];

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onMount(async () => {
    await loadMode();
  });

  async function loadMode() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.APPROVAL_CONFIG);
      const config = result[STORAGE_KEYS.APPROVAL_CONFIG] as IApprovalConfig | undefined;
      if (config?.mode) {
        currentMode = config.mode;
      }
    } catch {
      // Use default
    }
  }

  async function selectMode(mode: ApprovalMode) {
    currentMode = mode;
    showPopup = false;

    try {
      chrome.runtime.sendMessage({ type: 'UPDATE_APPROVAL_CONFIG', config: { mode } });
    } catch (error) {
      console.error('[ApprovalModeIndicator] Failed to send config update:', error);
    }
  }

  function togglePopup(event: MouseEvent) {
    event.stopPropagation();
    showPopup = !showPopup;
  }

  $: currentColor = MODE_OPTIONS.find(o => o.mode === currentMode)?.color || '#22c55e';
  $: currentLabel = MODE_OPTIONS.find(o => o.mode === currentMode)?.label || 'Balanced';
</script>

<PopupCard
  title=""
  show={showPopup}
  onClose={() => showPopup = false}
>
  <div slot="trigger" class="indicator-trigger {currentTheme}">
    <Tooltip content="{$_t('Approval Mode')}: {currentLabel}" disabled={showPopup}>
      <button
        class="indicator-button"
        on:click={togglePopup}
        aria-label="{$_t('Approval Mode')}: {currentLabel}"
        aria-haspopup="true"
        aria-expanded={showPopup}
      >
        <span class="indicator-dot" style="background-color: {currentColor};"></span>
      </button>
    </Tooltip>
  </div>

  <div slot="content" class="mode-content {currentTheme}">
    {#each MODE_OPTIONS as option}
      <button
        class="mode-option"
        class:selected={currentMode === option.mode}
        on:click={() => selectMode(option.mode)}
      >
        <span class="option-dot" style="background-color: {option.color};"></span>
        <div class="option-text">
          <span class="option-label">{option.label}</span>
          <span class="option-desc">— {option.description}</span>
        </div>
      </button>
    {/each}
  </div>
</PopupCard>

<style>
  /* Trigger — Terminal Theme (default) */
  .indicator-trigger {
    display: flex;
    align-items: center;
  }

  .indicator-button {
    position: relative;
    padding: 0.5rem;
    border-radius: 9999px;
    background: #000000;
    border: 1px solid #00cc00;
    color: #00cc00;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .indicator-button:hover {
    transform: scale(1.1);
    background: rgba(0, 204, 0, 0.1);
  }

  .indicator-button:active {
    transform: scale(0.95);
  }

  .indicator-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: block;
    transition: background-color 0.2s ease;
  }

  /* Content — Terminal Theme (default) */
  .mode-content {
    min-width: 240px;
  }

  .mode-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-term-bright-green, #00ff00);
    font-size: 0.8125rem;
    text-align: left;
    transition: background 0.15s ease;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .mode-option:hover {
    background: rgba(0, 255, 0, 0.1);
  }

  .mode-option.selected {
    background: rgba(0, 255, 0, 0.15);
  }

  .option-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .option-text {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }

  .option-label {
    font-weight: 600;
    white-space: nowrap;
  }

  .option-desc {
    color: var(--color-term-dim-green, #00cc00);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  /* Trigger — ChatGPT Theme */
  .indicator-trigger.chatgpt .indicator-button {
    background: transparent;
    border: none;
    border-radius: 0.5rem;
  }

  .indicator-trigger.chatgpt .indicator-button:hover {
    background: var(--chat-button-hover, #ececec);
    transform: none;
  }

  /* Content — ChatGPT Theme */
  .mode-content.chatgpt .mode-option {
    color: var(--chat-tooltip-text, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .mode-content.chatgpt .mode-option:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .mode-content.chatgpt .mode-option.selected {
    background: rgba(255, 255, 255, 0.12);
  }

  .mode-content.chatgpt .option-desc {
    color: rgba(255, 255, 255, 0.5);
  }
</style>
