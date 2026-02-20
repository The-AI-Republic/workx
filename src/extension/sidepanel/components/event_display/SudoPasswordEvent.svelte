<script lang="ts">
  /**
   * SudoPasswordEvent - Inline password input for sudo commands in the chat feed
   *
   * Renders a masked password input with Submit/Cancel buttons.
   * After submission, shows "Password provided" (never the actual password).
   * Sudo prompts ALWAYS require user input — YOLO/auto-approve cannot bypass them.
   */
  import { onMount } from 'svelte';
  import type { ProcessedEvent } from '@/types/ui';
  import { t, _t } from '../../lib/i18n';

  export let event: ProcessedEvent;

  let password = '';
  let submitted = false;
  let cancelled = false;
  let processing = false;
  let inputElement: HTMLInputElement;

  // Auto-focus the password input when rendered
  onMount(() => {
    if (inputElement) {
      inputElement.focus();
    }
  });

  function handleSubmit() {
    if (!event.sudoPasswordRequest || processing || !password) return;
    processing = true;
    submitted = true;
    event.sudoPasswordRequest.onSubmit(password);
    // Clear password from memory
    password = '';
    processing = false;
  }

  function handleCancel() {
    if (!event.sudoPasswordRequest || processing) return;
    processing = true;
    cancelled = true;
    event.sudoPasswordRequest.onCancel();
    password = '';
    processing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && password) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }
</script>

<div class="sudo-event border border-orange-400/30 bg-orange-500/10 rounded p-3">
  <div class="flex items-center gap-2 mb-2">
    <span class="text-lg">&#x1F512;</span>
    <div class="text-orange-400 font-semibold">
      {event.title}
    </div>
  </div>

  {#if event.sudoPasswordRequest}
    <div class="text-orange-300 mb-3 text-sm">
      <div class="mb-1">{$_t("Command:")} <code class="bg-gray-800 px-1.5 py-0.5 rounded text-orange-200">{event.sudoPasswordRequest.command}</code></div>
      {#if event.sudoPasswordRequest.workingDir}
        <div class="text-gray-400">{$_t("Directory:")} {event.sudoPasswordRequest.workingDir}</div>
      {/if}
    </div>

    {#if submitted}
      <div class="text-green-400 text-sm font-medium">
        &#x2713; {$_t("Password provided")}
      </div>
    {:else if cancelled}
      <div class="text-red-400 text-sm font-medium">
        &#x2717; {$_t("Cancelled")}
      </div>
    {:else}
      <div class="flex gap-2 items-center">
        <input
          bind:this={inputElement}
          bind:value={password}
          on:keydown={handleKeydown}
          type="password"
          placeholder={t("Enter sudo password...")}
          class="flex-1 px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-orange-500"
          disabled={processing}
          autocomplete="off"
        />
        <button
          class="px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={processing || !password}
          on:click={handleSubmit}
        >
          {$_t("Submit")}
        </button>
        <button
          class="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={processing}
          on:click={handleCancel}
        >
          {$_t("Cancel")}
        </button>
      </div>
    {/if}
  {/if}
</div>
