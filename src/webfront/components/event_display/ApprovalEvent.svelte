<script lang="ts">
  /**
   * ApprovalEvent - Renders interactive approval requests with risk-aware display
   * Offers 4 options: Approve, Always Approve, Deny, and alternative instructions
   */
  import { onDestroy } from 'svelte';
  import type { ProcessedEvent } from '@/types/ui';
  import { t, _t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  let { event }: {
    event: ProcessedEvent;
  } = $props();

  let processing = $state(false);
  let alternativeText = $state('');
  let showAlternativeInput = $state(false);

  // Track 14: editable Plan Review. When the request carries a structured
  // plan, offer an editor; "Approve with edits" rides the existing
  // onRequestChange transport (the SubmitPlanForReview handler parses a
  // JSON plan in the reason as approve-with-edits).
  const planObj = $derived(event.requiresApproval?.plan);
  let showPlanEditor = $state(false);
  let planDraft = $state('');
  let planEditError = $state('');

  function togglePlanEditor() {
    if (!showPlanEditor && planObj) {
      planDraft = JSON.stringify(planObj, null, 2);
      planEditError = '';
    }
    showPlanEditor = !showPlanEditor;
  }

  async function handleApproveWithEdits() {
    if (!event.requiresApproval?.onRequestChange || processing) return;
    let normalized: string;
    try {
      // Re-serialize so the handler always receives compact valid JSON.
      normalized = JSON.stringify(JSON.parse(planDraft));
    } catch {
      planEditError = $_t('Invalid JSON — please fix the plan before approving.');
      return;
    }
    processing = true;
    try {
      event.requiresApproval.onRequestChange(normalized);
    } finally {
      processing = false;
    }
  }

  // Countdown timer
  // countdown=0 means no timeout (balanced mode — wait indefinitely for user)
  let timeRemaining = $state(event.requiresApproval?.countdown ?? 0);
  let timedOut = $state(false);
  const hasCountdown = timeRemaining > 0;
  let countdownInterval: ReturnType<typeof setInterval> | null = null;

  if (hasCountdown) {
    countdownInterval = setInterval(() => {
      if (timeRemaining > 0) {
        timeRemaining--;
      }
      if (timeRemaining <= 0) {
        timedOut = true;
        if (countdownInterval) clearInterval(countdownInterval);
      }
    }, 1000);
  }

  onDestroy(() => {
    if (countdownInterval) clearInterval(countdownInterval);
  });

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
      event.requiresApproval.onApprove();
    } finally {
      processing = false;
    }
  }

  async function handleAlwaysApprove() {
    if (!event.requiresApproval || processing) return;
    processing = true;
    try {
      if (event.requiresApproval.onRemember) {
        // onRemember('session') already sends approve + remember=true
        event.requiresApproval.onRemember('session');
      } else {
        // Fallback: approve without remember if onRemember not available
        event.requiresApproval.onApprove();
      }
    } finally {
      processing = false;
    }
  }

  async function handleDeny() {
    if (!event.requiresApproval || processing) return;
    processing = true;
    try {
      event.requiresApproval.onReject();
    } finally {
      processing = false;
    }
  }

  async function handleSendAlternative() {
    if (!event.requiresApproval?.onRequestChange || processing || !alternativeText.trim()) return;
    processing = true;
    try {
      event.requiresApproval.onRequestChange(alternativeText.trim());
    } finally {
      processing = false;
    }
  }

  function handleAlternativeKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendAlternative();
    }
  }

  let riskLevel = $derived(event.requiresApproval?.riskLevel);
  let borderClass = $derived(getBorderClass(riskLevel));

  // Theme-aware "caution" text for the approval body (was a hardcoded
  // text-yellow-400 that is illegible on the modern-light background) and the
  // alternative/plan editor inputs (were hardcoded dark gray). Action buttons
  // and risk badges keep their semantic colors, which read well in both themes.
  let warnText = $derived($uiTheme === 'modern'
    ? 'text-chat-status-warning dark:text-chat-status-warning-dark'
    : 'text-term-yellow');
  let inputClass = $derived($uiTheme === 'modern'
    ? 'bg-chat-input dark:bg-chat-input-dark border-chat-border dark:border-chat-border-dark text-chat-text dark:text-chat-text-dark placeholder:text-chat-text-muted dark:placeholder:text-chat-text-muted-dark focus:border-chat-primary dark:focus:border-chat-primary-dark'
    : 'bg-term-bg border-term-dim-green text-term-green placeholder:text-term-dim-green focus:border-term-green');
</script>

<div class="approval-event border {borderClass} bg-yellow-500/10 rounded p-3">
  <div class="flex items-center gap-2 mb-2">
    <div class="font-semibold {warnText}">
      {event.title}
    </div>
    {#if riskLevel}
      <span class="px-2 py-0.5 rounded-full border {getRiskBadgeClass(riskLevel)}">
        {riskLevel.toUpperCase()}
      </span>
    {/if}
    {#if event.requiresApproval?.riskScore !== undefined}
      <span class={warnText}>
        {$_t("Risk Score:")} {event.requiresApproval.riskScore}/100
      </span>
    {/if}
    {#if hasCountdown && !timedOut}
      <span class={warnText}>{timeRemaining}s {$_t("remaining")}</span>
    {:else if !hasCountdown}
      <span class={warnText}>{$_t("Waiting for approval")}</span>
    {/if}
  </div>

  {#if event.requiresApproval}
    <div class="mb-3 {warnText}">
      {#if event.requiresApproval.type === 'exec'}
        <div class="mb-2">{$_t("Tool name:")} {event.requiresApproval.command}</div>
      {:else if event.requiresApproval.type === 'tool' && event.requiresApproval.toolName}
        <div class="mb-2">
          {$_t("Tool name:")} {event.requiresApproval.toolName}
          {#if event.requiresApproval.command}
            : {event.requiresApproval.command}
          {/if}
        </div>
      {:else if event.requiresApproval.type === 'patch'}
        <div class="mb-2">{$_t("Tool name:")} patch</div>
      {/if}

      {#if event.requiresApproval.riskFactors && event.requiresApproval.riskFactors.length > 0}
        <div class="mb-2 {warnText}">
          {#each event.requiresApproval.riskFactors as factor}
            <div class="flex items-start gap-1">
              <span class="mt-0.5 {warnText}">-</span>
              <span>{factor}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if event.requiresApproval.explanation}
        <div class="italic {warnText}">
          {event.requiresApproval.explanation}
        </div>
      {/if}

      {#if timedOut}
        <div class="text-green-400 font-semibold mt-2">
          {$_t("Auto-approved -- timeout reached")}
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex gap-2 flex-wrap">
        <button
          class="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={processing || timedOut}
          onclick={handleApprove}
        >
          {processing ? t('Processing...') : t('Approve')}
        </button>

        {#if event.requiresApproval.onRemember}
          <button
            class="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={processing || timedOut}
            onclick={handleAlwaysApprove}
          >
            {$_t("Always Approve")}
          </button>
        {/if}

        <button
          class="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={processing || timedOut}
          onclick={handleDeny}
        >
          {$_t("Deny")}
        </button>

        {#if event.requiresApproval.onRequestChange}
          <button
            class="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={processing || timedOut}
            onclick={() => { showAlternativeInput = !showAlternativeInput; }}
          >
            {$_t("Suggest Alternative")}
          </button>
        {/if}

        {#if planObj && event.requiresApproval.onRequestChange}
          <button
            class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={processing || timedOut}
            onclick={togglePlanEditor}
          >
            {showPlanEditor ? $_t("Hide Editor") : $_t("Edit Plan")}
          </button>
        {/if}
      </div>

      {#if showPlanEditor && planObj && event.requiresApproval.onRequestChange}
        <div class="flex flex-col gap-2 mt-1">
          <textarea
            bind:value={planDraft}
            rows="12"
            spellcheck="false"
            class="w-full px-2 py-1.5 border rounded text-xs font-mono focus:outline-none {inputClass}"
            disabled={processing}
          ></textarea>
          {#if planEditError}
            <div class="text-red-400 text-xs">{planEditError}</div>
          {/if}
          <div>
            <button
              class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={processing || !planDraft.trim()}
              onclick={handleApproveWithEdits}
            >
              {$_t("Approve with edits")}
            </button>
          </div>
        </div>
      {/if}

      {#if showAlternativeInput && event.requiresApproval.onRequestChange}
        <div class="flex gap-2 mt-1">
          <input
            type="text"
            bind:value={alternativeText}
            onkeydown={handleAlternativeKeydown}
            placeholder={t("Type alternative instructions...")}
            class="flex-1 px-2 py-1.5 border rounded text-sm focus:outline-none {inputClass}"
            disabled={processing}
          />
          <button
            class="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={processing || !alternativeText.trim()}
            onclick={handleSendAlternative}
          >
            {$_t("Send")}
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
