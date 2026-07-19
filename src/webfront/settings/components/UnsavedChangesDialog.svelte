<script lang="ts">
  import { t } from '../../lib/i18n';

  let {
    isOpen = false,
    onConfirm,
    onCancel,
  }: {
    isOpen?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  } = $props();

  let dialogElement: HTMLDivElement;

  function handleConfirm() {
    onConfirm?.();
  }

  function handleCancel() {
    onCancel?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleCancel();
    }
  }

  function handleOverlayClick() {
    handleCancel();
  }

  function handleContentClick(e: MouseEvent) {
    e.stopPropagation();
  }

  $effect(() => {
    if (isOpen && dialogElement) {
      dialogElement.focus();
    }
  });
</script>

{#if isOpen}
  <div
    class="dialog-overlay"
    onclick={handleOverlayClick}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
  >
    <div
      class="dialog-content"
      onclick={handleContentClick}
      bind:this={dialogElement}
      tabindex="-1"
    >
      <h3 id="dialog-title">{t("Unsaved Changes")}</h3>
      <p class="dialog-message">
        {t("You have unsaved changes. Do you want to discard them?")}
      </p>
      <div class="dialog-actions">
        <button class="btn btn-danger" onclick={handleConfirm}>
          {t("Discard Changes")}
        </button>
        <button class="btn btn-secondary" onclick={handleCancel}>
          {t("Cancel")}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .dialog-content {
    background: var(--workx-background);
    border-radius: 0.5rem;
    padding: 1.5rem;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    animation: slideIn 0.2s ease-out;
  }

  @keyframes slideIn {
    from {
      transform: translateY(-20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .dialog-content:focus {
    outline: none;
  }

  #dialog-title {
    margin: 0 0 0.75rem 0;
    font-size: var(--text-xl);
    line-height: var(--text-xl--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
  }

  .dialog-message {
    margin: 0 0 1.5rem 0;
    font-size: var(--text-sm);
    color: var(--workx-text-secondary);
    line-height: var(--leading-normal);
  }

  .dialog-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .btn {
    padding: 0.625rem 1.25rem;
    border-radius: 0.375rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  .btn-danger {
    background: var(--workx-error);
    color: white;
  }

  .btn-danger:hover {
    background: color-mix(in srgb, var(--workx-error) 90%, black);
  }

  .btn-secondary {
    background: var(--workx-surface);
    color: var(--workx-text);
    border: 1px solid var(--workx-border);
  }

  .btn-secondary:hover {
    background: color-mix(in srgb, var(--workx-surface) 80%, var(--workx-text));
  }
</style>
