<script lang="ts">
  import { getInitializedUIClient } from '@/core/messaging';
  import type { ThreadIndexEntry } from '@/core/thread/ThreadIndexStore';
  import { DEFAULT_MODE, MODES, type AgentMode } from '@/prompts/PromptComposer';
  import { activeThread, threadStore } from '../../stores/threadStore';
  import { platform } from '../../stores/platformStore';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  const availableModes = Object.values(MODES).filter((mode) =>
    !mode.agentTypes
      || mode.agentTypes.includes('workx-desktop')
      || mode.agentTypes.includes('workx-server'),
  );

  let currentTheme = $derived($uiTheme);

  async function setSessionMode(mode: AgentMode): Promise<void> {
    const thread = $activeThread;
    if (!thread || (thread.agentMode === mode && !thread.pendingMode)) return;
    try {
      threadStore.setThreadPendingMode(thread.sessionId, mode);
      const client = await getInitializedUIClient();
      const response = await client.serviceRequest<{ entry: ThreadIndexEntry }>('session.setMode', {
        sessionId: thread.sessionId,
        mode,
      });
      // The service response is backend-owned state, not an optimistic flip.
      // An idle/suspended switch returns the committed mode immediately; a
      // running session returns its old entry and keeps the pending indicator
      // until ModeChanged{applied:true} arrives at the idle edge.
      if (response.entry.agentMode === mode) {
        threadStore.setThreadMode(thread.sessionId, mode);
      }
    } catch (error) {
      threadStore.setThreadPendingMode(thread.sessionId, null);
      console.error('Failed to set session mode:', error);
    }
  }
</script>

{#if platform.platformName !== 'extension' && $activeThread}
  {@const activeMode = $activeThread.agentMode ?? DEFAULT_MODE}
  {@const pendingMode = $activeThread.pendingMode ?? null}
  <div class="px-1 pb-1">
    <div
      class="grid grid-cols-2 rounded-lg p-1
        {currentTheme === 'modern'
          ? 'bg-chat-button-hover/70 dark:bg-chat-button-hover-dark/70'
          : 'border border-term-dim-green/40 bg-term-green/5'}"
      role="group"
      aria-label={$_t('Agent mode')}
    >
      {#each availableModes as modeSpec (modeSpec.id)}
        {@const isActive = activeMode === modeSpec.id && !pendingMode}
        {@const isPending = pendingMode === modeSpec.id}
        <button
          type="button"
          onclick={() => void setSessionMode(modeSpec.id)}
          title={isPending ? $_t('Switching after current task…') : $_t('Switch agent mode')}
          aria-pressed={isActive}
          class="rounded-md border-none px-2 py-1.5 text-xs font-[inherit] cursor-pointer transition-colors
            {isActive
              ? (currentTheme === 'modern'
                  ? 'bg-chat-surface dark:bg-chat-surface-dark text-chat-text dark:text-chat-text-dark shadow-sm font-semibold'
                  : 'bg-term-green/15 text-term-green font-semibold')
              : (currentTheme === 'modern'
                  ? 'bg-transparent text-chat-text-muted dark:text-chat-text-muted-dark hover:text-chat-text dark:hover:text-chat-text-dark'
                  : 'bg-transparent text-term-dim-green hover:text-term-green')}
            {isPending ? 'animate-pulse' : ''}"
        >
          {modeSpec.label}{#if isPending}…{/if}
        </button>
      {/each}
    </div>
  </div>
{/if}
