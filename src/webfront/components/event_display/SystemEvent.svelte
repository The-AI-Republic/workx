<script lang="ts">
  /**
   * SystemEvent - Renders system notifications and metadata
   */
  import type { ProcessedEvent } from '@/types/ui';
  import type { ProcessedEventAction } from '@/types/ui';
  import { getInitializedUIClient } from '@/core/messaging';
  import { push } from 'svelte-spa-router';

  let { event }: { event: ProcessedEvent } = $props();
  let actionState: Record<string, 'idle' | 'pending' | 'success' | 'error'> = $state({});
  let actionMessage = $state('');

  async function runAction(action: ProcessedEventAction, clickEvent: MouseEvent) {
    clickEvent.stopPropagation();
    actionMessage = '';
    if (action.kind === 'navigate' && action.href) {
      push(action.href);
      return;
    }
    if (!action.service) return;
    actionState = { ...actionState, [action.id]: 'pending' };
    try {
      const client = await getInitializedUIClient();
      await client.serviceRequest(action.service, action.params);
      actionState = { ...actionState, [action.id]: 'success' };
      actionMessage = action.successMessage ?? 'Done.';
    } catch (error) {
      actionState = { ...actionState, [action.id]: 'error' };
      const message = error instanceof Error ? error.message : 'Action failed.';
      actionMessage = /revision|conflict|changed/i.test(message)
        ? (action.conflictMessage ?? message)
        : message;
    }
  }
</script>

<div class="system-event">
  <div class="text-sm text-gray-500 whitespace-pre-wrap font-mono">
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2)}
  </div>
  {#if event.actions?.length}
    <div class="event-actions" aria-label="Event actions">
      {#each event.actions as action (action.id)}
        <button
          type="button"
          disabled={actionState[action.id] === 'pending' || actionState[action.id] === 'success'}
          aria-busy={actionState[action.id] === 'pending'}
          onclick={(clickEvent) => runAction(action, clickEvent)}
        >
          {actionState[action.id] === 'pending' ? `${action.label}…` : action.label}
        </button>
      {/each}
    </div>
  {/if}
  {#if actionMessage}
    <p
      class:error={Object.values(actionState).includes('error')}
      class="action-message"
      role="status"
    >
      {actionMessage}
    </p>
  {/if}
</div>

<style>
  .event-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.65rem;
  }

  button {
    border: 1px solid currentColor;
    border-radius: 0.35rem;
    padding: 0.3rem 0.6rem;
    background: transparent;
    color: inherit;
  }

  button:disabled {
    opacity: 0.6;
  }

  .action-message {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
  }

  .action-message.error {
    color: #ef4444;
  }
</style>
