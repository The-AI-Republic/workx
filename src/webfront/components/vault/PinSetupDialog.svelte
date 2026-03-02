<!--
  PinSetupDialog - PIN creation/change dialog for vault security
  Dispatches: success, cancel
-->

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { t } from '../../lib/i18n';
  import { sendMessage, MessageType } from '../../lib/messaging';

  const dispatch = createEventDispatcher<{ success: void; cancel: void }>();

  let pin = '';
  let pinConfirm = '';
  let error = '';
  let isSubmitting = false;

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
      await sendMessage(MessageType.PIN_SET, { pin, pinConfirm });
      dispatch('success');
    } catch (err) {
      error = (err as Error).message || 'Failed to set PIN';
    } finally {
      isSubmitting = false;
    }
  }

  function handleCancel() {
    dispatch('cancel');
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

<div class="pin-dialog-overlay" on:click|self={handleCancel}>
  <div class="pin-dialog">
    <h3 class="pin-dialog-title">{t("Enable PIN Protection")}</h3>
    <p class="pin-dialog-description">
      {t("Create a 6-digit PIN to protect your API keys. You'll need this PIN after restarting the browser.")}
    </p>

    <form on:submit|preventDefault={handleSubmit}>
      <div class="pin-field">
        <label for="pin-input">{t("PIN")}</label>
        <input
          id="pin-input"
          type="password"
          inputmode="numeric"
          maxlength="6"
          placeholder="------"
          value={pin}
          on:input={handlePinInput}
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
          on:input={handleConfirmInput}
          autocomplete="off"
          disabled={isSubmitting}
        />
      </div>

      {#if error}
        <div class="pin-error">{error}</div>
      {/if}

      <div class="pin-actions">
        <button type="button" class="btn-cancel" on:click={handleCancel} disabled={isSubmitting}>
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
    background: var(--browserx-background, #000);
    border: 1px solid var(--browserx-border, #00cc00);
    border-radius: 0.5rem;
    padding: 1.5rem;
    width: 320px;
    max-width: 90vw;
  }

  .pin-dialog-title {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
    color: var(--browserx-text, #00ff00);
  }

  .pin-dialog-description {
    margin: 0 0 1rem;
    font-size: 0.85rem;
    color: var(--browserx-text-secondary, #00cc00);
    line-height: 1.4;
  }

  .pin-field {
    margin-bottom: 0.75rem;
  }

  .pin-field label {
    display: block;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    color: var(--browserx-text-secondary, #00cc00);
  }

  .pin-field input {
    width: 100%;
    padding: 0.5rem;
    font-size: 1.2rem;
    letter-spacing: 0.3em;
    text-align: center;
    background: var(--browserx-surface, #0a0a0a);
    border: 1px solid var(--browserx-border, #00cc00);
    border-radius: 0.375rem;
    color: var(--browserx-text, #00ff00);
    box-sizing: border-box;
  }

  .pin-field input:focus {
    outline: none;
    border-color: var(--browserx-primary, #00ff00);
  }

  .pin-error {
    color: var(--browserx-error, #ff0000);
    font-size: 0.8rem;
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
    font-size: 0.85rem;
    cursor: pointer;
    border: 1px solid var(--browserx-border, #00cc00);
  }

  .btn-cancel {
    background: transparent;
    color: var(--browserx-text-secondary, #00cc00);
  }

  .btn-submit {
    background: var(--browserx-primary, #00ff00);
    color: var(--browserx-background, #000);
    font-weight: 600;
  }

  .btn-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel:hover:not(:disabled) {
    background: var(--browserx-surface, #0a0a0a);
  }
</style>
