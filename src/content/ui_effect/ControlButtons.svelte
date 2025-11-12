<script lang="ts">
  /**
   * Control Buttons Component
   *
   * "Take Over" and "Stop Agent" buttons positioned at bottom-center of overlay.
   *
   * Buttons:
   * - Take Over: Removes overlay, allows user to interact with page
   * - Stop Agent: Terminates agent session completely
   *
   * @component
   */

  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{
    takeover: void;
    stopagent: void;
  }>();

  function handleTakeOver() {
    dispatch('takeover');
  }

  function handleStopAgent() {
    dispatch('stopagent');
  }
</script>

<div class="control-buttons" data-testid="control-buttons">
  <button
    class="control-button control-button--takeover"
    data-testid="takeover-button"
    on:click={handleTakeOver}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M8 5V8L10 10"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    Take Over
  </button>

  <button
    class="control-button control-button--stop"
    data-testid="stop-agent-button"
    on:click={handleStopAgent}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="3"
        width="10"
        height="10"
        rx="1"
        fill="currentColor"
      />
    </svg>
    Stop Agent
  </button>
</div>

<style>
  .control-buttons {
    /* Layout */
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: center;

    /* Prevent interaction blocking */
    pointer-events: all;

    /* Animation */
    animation: slideUp 300ms ease-out;
  }

  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .control-button {
    /* Layout */
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;

    /* Typography */
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    text-align: center;

    /* Visual appearance */
    border: 2px solid rgba(255, 255, 255, 0.8);
    border-radius: 8px;
    background-color: rgba(255, 255, 255, 0.95);
    color: #1a1a1a;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);

    /* Interaction */
    cursor: pointer;
    user-select: none;

    /* Performance */
    will-change: transform, background-color, border-color;
    transition: all 150ms ease-out;
  }

  .control-button:hover {
    background-color: rgba(255, 255, 255, 1);
    border-color: rgba(255, 255, 255, 1);
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
  }

  .control-button:active {
    transform: translateY(0);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  .control-button--takeover {
    color: #0066cc;
  }

  .control-button--takeover:hover {
    background-color: #e6f2ff;
    border-color: #0066cc;
  }

  .control-button--stop {
    color: #cc0000;
  }

  .control-button--stop:hover {
    background-color: #ffe6e6;
    border-color: #cc0000;
  }

  /* Focus styles for accessibility */
  .control-button:focus-visible {
    outline: 3px solid rgba(0, 102, 204, 0.5);
    outline-offset: 2px;
  }
</style>
