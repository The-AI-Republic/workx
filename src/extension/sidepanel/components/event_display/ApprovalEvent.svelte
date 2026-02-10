<script lang="ts">
  /**
   * ApprovalEvent - Renders interactive approval requests
   */
  import type { ProcessedEvent } from '@/types/ui';

  export let event: ProcessedEvent;

  let processing = false;

  async function handleApprove() {
    if (!event.requiresApproval || processing) return;
    processing = true;
    try {
      event.requiresApproval.onApprove();
    } finally {
      processing = false;
    }
  }

  async function handleReject() {
    if (!event.requiresApproval || processing) return;
    processing = true;
    try {
      event.requiresApproval.onReject();
    } finally {
      processing = false;
    }
  }

  async function handleRequestChange() {
    if (!event.requiresApproval?.onRequestChange || processing) return;
    processing = true;
    try {
      event.requiresApproval.onRequestChange();
    } finally {
      processing = false;
    }
  }
</script>

<div class="approval-event border border-yellow-400/30 bg-yellow-500/10 rounded p-3">
  <div class="text-yellow-400 font-semibold text-sm mb-2">
    {event.title}
  </div>

  {#if event.requiresApproval}
    <div class="text-gray-300 text-sm mb-3">
      {#if event.requiresApproval.type === 'exec'}
        <div class="font-mono bg-black/30 p-2 rounded mb-2">
          {event.requiresApproval.command}
        </div>
      {:else if event.requiresApproval.type === 'patch'}
        <div class="text-sm mb-2">
          Patch for files
        </div>
      {/if}

      {#if event.requiresApproval.explanation}
        <div class="text-gray-400 text-xs italic">
          {event.requiresApproval.explanation}
        </div>
      {/if}
    </div>

    <div class="flex gap-2">
      <button
        class="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={processing}
        on:click={handleApprove}
      >
        {processing ? 'Processing...' : 'Approve'}
      </button>

      <button
        class="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={processing}
        on:click={handleReject}
      >
        Reject
      </button>

      {#if event.requiresApproval.onRequestChange}
        <button
          class="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={processing}
          on:click={handleRequestChange}
        >
          Request Change
        </button>
      {/if}
    </div>
  {/if}
</div>
