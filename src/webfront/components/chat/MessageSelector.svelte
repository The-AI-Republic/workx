<script lang="ts">
  /**
   * Track 15 — Conversation Rewind turn selector.
   *
   * Command-invoked overlay (no persistent trigger button, so this is a
   * self-contained modal rather than a PopupCard which positions relative to
   * a trigger). Two steps: pick a user turn, then pick a rewind mode. On
   * confirm it calls the `session.rewind` service and hands the forked
   * conversation back to the host via `onRewound`.
   */
  import { getInitializedUIClient } from '@/core/messaging';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  interface RewindTurn { sequence: number; preview: string; text: string }

  let {
    show = false,
    onClose = () => {},
    onRewound = (_r: { sessionId: string; history?: unknown[]; rewoundText?: string }) => {},
  }: {
    show?: boolean;
    onClose?: () => void;
    onRewound?: (r: { sessionId: string; history?: unknown[]; rewoundText?: string }) => void;
  } = $props();

  let currentTheme = $derived($uiTheme);

  type Step = 'loading' | 'list' | 'mode' | 'busy' | 'error';
  let step: Step = $state('loading');
  let turns: RewindTurn[] = $state([]);
  let selected: RewindTurn | null = $state(null);
  let errorMsg: string = $state('');

  // Reload turns each time the overlay opens; reset when it closes.
  let wasShown = false;
  $effect(() => {
    if (show && !wasShown) {
      wasShown = true;
      void loadTurns();
    } else if (!show && wasShown) {
      wasShown = false;
      reset();
    }
  });

  function reset() {
    step = 'loading';
    turns = [];
    selected = null;
    errorMsg = '';
  }

  async function loadTurns() {
    step = 'loading';
    try {
      const client = await getInitializedUIClient();
      const res = await client.serviceRequest<{ turns?: RewindTurn[] }>('session.turns');
      turns = res?.turns ?? [];
      step = turns.length > 0 ? 'list' : 'error';
      if (turns.length === 0) errorMsg = $_t('Nothing to rewind to yet.');
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      step = 'error';
    }
  }

  function pickTurn(turn: RewindTurn) {
    selected = turn;
    step = 'mode';
  }

  async function doRewind(mode: 'conversation' | 'summarize_up_to') {
    if (!selected) return;
    step = 'busy';
    try {
      const client = await getInitializedUIClient();
      const result = await client.serviceRequest<{
        sessionId: string;
        history?: unknown[];
        rewoundText?: string;
      }>(
        'session.rewind',
        { targetSequence: selected.sequence, mode },
        // `summarize_up_to` runs a synchronous model compaction server-side;
        // the default 30s cap would falsely reject a successful summarize and
        // orphan the already-created fork. Give it a generous ceiling (the
        // server still bounds the model call itself).
        { timeoutMs: mode === 'summarize_up_to' ? 180_000 : 60_000 },
      );
      onRewound(result);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      step = 'error';
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    onclick={handleBackdrop}
    onkeydown={handleKey}
    role="dialog"
    aria-modal="true"
    aria-label={$_t('Rewind conversation')}
    tabindex="-1"
  >
    <div
      class="w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden rounded-lg shadow-xl
        {currentTheme === 'modern'
          ? 'bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark border border-chat-border dark:border-chat-border-dark'
          : 'bg-black text-term-green border border-term-dim-green'}"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b
        {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark' : 'border-term-dim-green'}">
        <h2 class="text-sm font-semibold">
          {step === 'mode' ? $_t('Choose rewind mode') : $_t('Rewind to a previous turn')}
        </h2>
        <button
          class="text-lg leading-none px-2 cursor-pointer opacity-70 hover:opacity-100"
          onclick={onClose}
          aria-label={$_t('Close')}
        >×</button>
      </div>

      <div class="overflow-y-auto p-3 text-sm">
        {#if step === 'loading' || step === 'busy'}
          <p class="opacity-70 py-6 text-center">
            {step === 'busy' ? $_t('Rewinding…') : $_t('Loading turns…')}
          </p>
        {:else if step === 'error'}
          <p class="py-6 text-center text-red-500">{errorMsg}</p>
        {:else if step === 'list'}
          <ul class="flex flex-col gap-1">
            {#each turns as turn (turn.sequence)}
              <li>
                <button
                  class="w-full text-left px-3 py-2 rounded cursor-pointer transition-colors
                    {currentTheme === 'modern'
                      ? 'hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
                      : 'hover:bg-term-dim-green/20'}"
                  onclick={() => pickTurn(turn)}
                  title={turn.text}
                >
                  <span class="opacity-50 mr-2">#{turn.sequence}</span>
                  {turn.preview || $_t('(empty message)')}
                </button>
              </li>
            {/each}
          </ul>
        {:else if step === 'mode'}
          <p class="mb-3 opacity-70 break-words">
            {$_t('Rewinding to:')} <span class="opacity-100">{selected?.preview}</span>
          </p>
          <div class="flex flex-col gap-2">
            <button
              class="px-3 py-2 rounded text-left cursor-pointer border
                {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark' : 'border-term-dim-green hover:bg-term-dim-green/20'}"
              onclick={() => doRewind('conversation')}
            >
              <div class="font-medium">{$_t('Rewind conversation')}</div>
              <div class="opacity-60 text-xs">{$_t('Fork a new branch from this turn. Everything after is dropped.')}</div>
            </button>
            <button
              class="px-3 py-2 rounded text-left cursor-pointer border
                {currentTheme === 'modern' ? 'border-chat-border dark:border-chat-border-dark hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark' : 'border-term-dim-green hover:bg-term-dim-green/20'}"
              onclick={() => doRewind('summarize_up_to')}
            >
              <div class="font-medium">{$_t('Summarize earlier turns')}</div>
              <div class="opacity-60 text-xs">{$_t('Replace everything up to this turn with a single summary.')}</div>
            </button>
            <button
              class="px-3 py-2 rounded text-left cursor-pointer opacity-70 hover:opacity-100"
              onclick={onClose}
            >
              {$_t('Never mind')}
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
