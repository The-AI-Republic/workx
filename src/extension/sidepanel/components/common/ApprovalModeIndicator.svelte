<!--
  ApprovalModeIndicator - Traffic-light button showing current approval mode
  with popup selector for switching between modes.
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Tooltip from './Tooltip.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';
  import type { ApprovalMode, IApprovalConfig } from '@/core/approval/types';
  import { DEFAULT_APPROVAL_CONFIG } from '@/core/approval/types';

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

    // Listen for storage changes to stay in sync
    chrome.storage.onChanged.addListener(handleStorageChange);
  });

  onDestroy(() => {
    chrome.storage.onChanged.removeListener(handleStorageChange);
  });

  function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) {
    if (areaName === 'local' && changes['approval_config']) {
      const newConfig = changes['approval_config'].newValue as IApprovalConfig | undefined;
      if (newConfig?.mode) {
        currentMode = newConfig.mode;
      }
    }
  }

  async function loadMode() {
    try {
      const result = await chrome.storage.local.get('approval_config');
      const config = result['approval_config'] as IApprovalConfig | undefined;
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
      const result = await chrome.storage.local.get('approval_config');
      const existing = (result['approval_config'] as IApprovalConfig) || { ...DEFAULT_APPROVAL_CONFIG };
      existing.mode = mode;
      await chrome.storage.local.set({ 'approval_config': existing });
    } catch (error) {
      console.error('[ApprovalModeIndicator] Failed to save mode:', error);
    }
  }

  function togglePopup() {
    showPopup = !showPopup;
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.approval-indicator-container')) {
      showPopup = false;
    }
  }

  $: currentColor = MODE_OPTIONS.find(o => o.mode === currentMode)?.color || '#22c55e';
  $: currentLabel = MODE_OPTIONS.find(o => o.mode === currentMode)?.label || 'Balanced';
</script>

<svelte:window on:click={handleClickOutside} />

<div class="approval-indicator-container {currentTheme}">
  <Tooltip content="{$_t('Approval Mode')}: {currentLabel}">
    <button
      class="indicator-button"
      on:click|stopPropagation={togglePopup}
      aria-label="{$_t('Approval Mode')}: {currentLabel}"
    >
      <span class="indicator-dot" style="background-color: {currentColor};"></span>
    </button>
  </Tooltip>

  {#if showPopup}
    <div class="mode-popup" on:click|stopPropagation>
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
  {/if}
</div>

<style>
  .approval-indicator-container {
    position: relative;
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

  .mode-popup {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: #1a1a2e;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 4px;
    min-width: 260px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 100;
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
    color: #e0e0e0;
    font-size: 0.8125rem;
    text-align: left;
    transition: background 0.15s ease;
  }

  .mode-option:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .mode-option.selected {
    background: rgba(255, 255, 255, 0.12);
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
    color: #888;
    font-size: 0.75rem;
    white-space: nowrap;
  }

  /* ChatGPT Theme */
  .approval-indicator-container.chatgpt .indicator-button {
    background: transparent;
    border: none;
    border-radius: 0.5rem;
  }

  .approval-indicator-container.chatgpt .indicator-button:hover {
    background: var(--chat-button-hover, #ececec);
    transform: none;
  }

  .approval-indicator-container.chatgpt .mode-popup {
    background: #ffffff;
    border: 1px solid #e5e5e5;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }

  .approval-indicator-container.chatgpt .mode-option {
    color: #0d0d0d;
  }

  .approval-indicator-container.chatgpt .mode-option:hover {
    background: #f5f5f5;
  }

  .approval-indicator-container.chatgpt .mode-option.selected {
    background: #ececec;
  }

  .approval-indicator-container.chatgpt .option-desc {
    color: #8e8ea0;
  }
</style>
