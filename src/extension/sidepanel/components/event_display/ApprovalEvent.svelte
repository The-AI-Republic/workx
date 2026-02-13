<script lang="ts">
  /**
   * ApprovalEvent - Renders interactive approval requests with risk-aware display
   */
  import type { ProcessedEvent } from '@/types/ui';

  export let event: ProcessedEvent;

  let processing = false;
  let rememberForSession = false;

  // Risk level color mapping
  function getRiskColor(level?: string): string {
    switch (level) {
      case 'none': return 'green';
      case 'low': return 'green';
      case 'medium': return 'yellow';
      case 'high': return 'orange';
      case 'critical': return 'red';
      default: return 'yellow';
    }
  }

  function getRiskBadgeClass(level?: string): string {
    switch (level) {
      case 'none':
      case 'low': return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'medium': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'high': return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
      case 'critical': return 'bg-red-500/20 text-red-400 border-red-500/30';
      default: return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    }
  }

  function getBorderClass(level?: string): string {
    switch (level) {
      case 'none':
      case 'low': return 'border-green-400/30';
      case 'medium': return 'border-yellow-400/30';
      case 'high': return 'border-orange-400/30';
      case 'critical': return 'border-red-400/30';
      default: return 'border-yellow-400/30';
    }
  }

  async function handleApprove() {
    if (!event.requiresApproval || processing) return;
    processing = true;
    try {
      if (rememberForSession && event.requiresApproval.onRemember) {
        event.requiresApproval.onRemember('session');
      }
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

  $: riskLevel = event.requiresApproval?.riskLevel;
  $: borderClass = getBorderClass(riskLevel);
</script>

<div class="approval-event border {borderClass} bg-yellow-500/10 rounded p-3">
  <div class="flex items-center gap-2 mb-2">
    <div class="text-yellow-400 font-semibold text-sm">
      {event.title}
    </div>
    {#if riskLevel}
      <span class="text-xs px-2 py-0.5 rounded-full border {getRiskBadgeClass(riskLevel)}">
        {riskLevel.toUpperCase()}
      </span>
    {/if}
    {#if event.requiresApproval?.riskScore !== undefined}
      <span class="text-xs text-gray-500">
        Score: {event.requiresApproval.riskScore}/100
      </span>
    {/if}
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
      {:else if event.requiresApproval.type === 'tool' && event.requiresApproval.toolName}
        <div class="font-mono bg-black/30 p-2 rounded mb-2">
          {event.requiresApproval.toolName}
          {#if event.requiresApproval.command}
            : {event.requiresApproval.command}
          {/if}
        </div>
      {/if}

      {#if event.requiresApproval.riskFactors && event.requiresApproval.riskFactors.length > 0}
        <div class="text-xs text-gray-400 mb-2">
          {#each event.requiresApproval.riskFactors as factor}
            <div class="flex items-start gap-1">
              <span class="text-gray-500 mt-0.5">-</span>
              <span>{factor}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if event.requiresApproval.explanation}
        <div class="text-gray-400 text-xs italic">
          {event.requiresApproval.explanation}
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-2">
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

      {#if event.requiresApproval.onRemember}
        <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={rememberForSession}
            class="rounded border-gray-600"
          />
          Remember for this session
        </label>
      {/if}
    </div>
  {/if}
</div>
