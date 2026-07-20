<!--
  PinSetupDialog - PIN creation/change dialog for vault security
-->

<script lang="ts">
  import { t } from '../../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';

  let { onSuccess, onCancel }: {
    onSuccess?: () => void;
    onCancel?: () => void;
  } = $props();

  let pin = $state('');
  let pinConfirm = $state('');
  let error = $state('');
  let isSubmitting = $state(false);

  function validatePin(value: string): string {
    if (value.length !== 6) return 'PIN must be exactly 6 digits';
    if (!/^\d{6}$/.test(value)) return 'PIN must contain only digits';
    return '';
  }

  async function handleSubmit() {
    error = '';

    const pinError = validatePin(pin);
    if (pinError) {
      error = pinError;
      return;
    }

    if (pin !== pinConfirm) {
      error = 'PINs do not match';
      return;
    }

    isSubmitting = true;
    try {
      await (await getInitializedUIClient()).serviceRequest('vault.pin.set', { pin, pinConfirm });
      onSuccess?.();
    } catch (err) {
      error = (err as Error).message || 'Failed to set PIN';
    } finally {
      isSubmitting = false;
    }
  }

  function handleCancel() {
    onCancel?.();
  }

  function handlePinInput(event: Event) {
    const input = event.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    pin = input.value;
  }

  function handleConfirmInput(event: Event) {
    const input = event.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    pinConfirm = input.value;
  }
</script>

<div class="pin-dialog-overlay" onclick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
  <div class="pin-dialog">
    <h3 class="pin-dialog-title">{t("Enable PIN Protection")}</h3>
    <p class="pin-dialog-description">
      {t("Create a 6-digit PIN to protect your API keys. You'll need this PIN after restarting the browser.")}
    </p>

    <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      <div class="pin-field">
        <label for="pin-input">{t("PIN")}</label>
        <input
          id="pin-input"
          type="password"
          inputmode="numeric"
          maxlength="6"
          placeholder="------"
          value={pin}
          oninput={handlePinInput}
          autocomplete="off"
          disabled={isSubmitting}
        />
      </div>

      <div class="pin-field">
        <label for="pin-confirm">{t("Confirm PIN")}</label>
        <input
          id="pin-confirm"
          type="password"
          inputmode="numeric"
          maxlength="6"
          placeholder="------"
          value={pinConfirm}
          oninput={handleConfirmInput}
          autocomplete="off"
          disabled={isSubmitting}
        />
      </div>

      {#if error}
        <div class="pin-error">{error}</div>
      {/if}

      <div class="pin-actions">
        <button type="button" class="btn-cancel" onclick={handleCancel} disabled={isSubmitting}>
          {t("Cancel")}
        </button>
        <button type="submit" class="btn-submit" disabled={isSubmitting || pin.length !== 6}>
          {isSubmitting ? t("Setting up...") : t("Enable PIN")}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .pin-dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .pin-dialog {
    background: var(--workx-background, #000);
    border: 1px solid var(--workx-border, #00cc00);
    border-radius: 0.5rem;
    padding: 1.5rem;
    width: 320px;
    max-width: 90vw;
  }

  .pin-dialog-title {
    margin: 0 0 0.5rem;
    font-size: var(--text-lg);
    line-height: var(--text-lg--line-height);
    color: var(--workx-text, #00ff00);
  }

  .pin-dialog-description {
    margin: 0 0 1rem;
    font-size: var(--text-sm);
    color: var(--workx-text-secondary, #00cc00);
    line-height: var(--leading-ui);
  }

  .pin-field {
    margin-bottom: 0.75rem;
  }

  .pin-field label {
    display: block;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    margin-bottom: 0.25rem;
    color: var(--workx-text-secondary, #00cc00);
  }

  .pin-field input {
    width: 100%;
    padding: 0.5rem;
    font-size: var(--text-xl);
    line-height: var(--text-xl--line-height);
    letter-spacing: var(--tracking-pin);
    text-align: center;
    background: var(--workx-surface, #0a0a0a);
    border: 1px solid var(--workx-border, #00cc00);
    border-radius: 0.375rem;
    color: var(--workx-text, #00ff00);
    box-sizing: border-box;
  }

  .pin-field input:focus {
    outline: none;
    border-color: var(--workx-primary, #00ff00);
  }

  .pin-error {
    color: var(--workx-error, #ff0000);
    font-size: var(--text-meta);
    line-height: var(--text-meta--line-height);
    margin-bottom: 0.75rem;
  }

  .pin-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .btn-cancel, .btn-submit {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    cursor: pointer;
    border: 1px solid var(--workx-border, #00cc00);
  }

  .btn-cancel {
    background: transparent;
    color: var(--workx-text-secondary, #00cc00);
  }

  .btn-submit {
    background: var(--workx-primary, #00ff00);
    color: var(--workx-background, #000);
    font-weight: var(--font-weight-semibold);
  }

  .btn-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel:hover:not(:disabled) {
    background: var(--workx-surface, #0a0a0a);
  }
</style>
