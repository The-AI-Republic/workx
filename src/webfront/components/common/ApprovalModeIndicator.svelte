<!--
  ApprovalModeIndicator - Traffic-light button showing current approval mode
  with popup selector for switching between modes.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t, _t } from '../../lib/i18n';
  import type { ApprovalMode, IApprovalConfig } from '@/core/approval/types';
  import { STORAGE_KEYS } from '@/config/defaults';
  import { getInitializedUIClient } from '@/core/messaging';

  let currentTheme: UITheme = 'terminal';
  let currentMode: ApprovalMode = 'balanced';
  let showPopup = false;

  const MODE_OPTIONS: { mode: ApprovalMode; label: string; description: string; color: string }[] = [
    { mode: 'balanced', label: t('Balanced'), description: t('Medium-risk and above'), color: '#22c55e' },
    { mode: 'high_speed', label: t('High Speed'), description: t('Only high-risk actions'), color: '#eab308' },
    { mode: 'yolo', label: t('YOLO'), description: t('Auto-approve everything'), color: '#ef4444' },
  ];

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  onMount(async () => {
    await loadMode();
  });

  async function loadMode() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
      const agentConfig = result[STORAGE_KEYS.CONFIG] as Record<string, any> | undefined;
      const config = agentConfig?.approval as IApprovalConfig | undefined;
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
      const client = await getInitializedUIClient();
      await client.serviceRequest('approval.updateConfig', { mode });
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
  <div slot="trigger" class="flex items-center">
    <Tooltip content="{$_t('Approval Mode')}: {currentLabel}" disabled={showPopup}>
      <button
        class="relative p-2 rounded-full flex items-center justify-center cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-transparent border-none rounded-lg hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-term-bg border border-term-dim-green text-term-dim-green hover:scale-110 hover:bg-term-dim-green/10 active:scale-95'}"
        on:click={togglePopup}
        aria-label="{$_t('Approval Mode')}: {currentLabel}"
        aria-haspopup="true"
        aria-expanded={showPopup}
      >
        <span class="w-4 h-4 rounded-full block transition-colors duration-200" style="background-color: {currentColor};"></span>
      </button>
    </Tooltip>
  </div>

  <div slot="content" class="min-w-[240px]">
    {#each MODE_OPTIONS as option}
      <button
        class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border-none rounded-md cursor-pointer text-sm text-left transition-colors duration-150
          {currentTheme === 'modern'
            ? 'font-chat text-chat-tooltip-text dark:text-chat-tooltip-text-dark hover:bg-white/[0.08] ' + (currentMode === option.mode ? 'bg-white/[0.12]' : '')
            : 'font-mono text-term-bright-green hover:bg-term-green/10 ' + (currentMode === option.mode ? 'bg-term-green/15' : '')}"
        on:click={() => selectMode(option.mode)}
      >
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {option.color};"></span>
        <div class="flex gap-1.5 items-baseline">
          <span class="font-semibold whitespace-nowrap">{option.label}</span>
          <span class="whitespace-nowrap text-sm
            {currentTheme === 'modern'
              ? 'text-white/50'
              : 'text-term-dim-green'}">— {option.description}</span>
        </div>
      </button>
    {/each}
  </div>
</PopupCard>
