<!--
  SecuritySettings - PIN enable/disable/change UI for vault security
  Dispatches: back, saved
-->

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '../lib/i18n';
  import { sendMessage, MessageType } from '../lib/messaging';
  import PinSetupDialog from '../components/vault/PinSetupDialog.svelte';
  import { vaultStore, refreshVaultStatus } from '../stores/vaultStore';

  export let isDirty = false;

  const dispatch = createEventDispatcher<{ back: void; saved: void }>();

  let showPinSetup = false;
  let showChangePinForm = false;
  let showRemovePinForm = false;

  // Change PIN form state
  let currentPinInput = '';
  let newPinInput = '';
  let newPinConfirmInput = '';
  let changePinError = '';
  let changePinSubmitting = false;

  // Remove PIN form state
  let removePinInput = '';
  let removePinError = '';
  let removePinSubmitting = false;

  let statusMessage = '';

  onMount(async () => {
    await refreshVaultStatus();
  });

  function handleBack() {
    dispatch('back');
  }

  async function handlePinSetupSuccess() {
    showPinSetup = false;
    statusMessage = 'PIN protection enabled';
    await refreshVaultStatus();
    setTimeout(() => (statusMessage = ''), 3000);
  }

  function handlePinSetupCancel() {
    showPinSetup = false;
  }

  async function handleChangePinSubmit() {
    changePinError = '';
    if (!/^\d{6}$/.test(newPinInput)) {
      changePinError = 'New PIN must be exactly 6 digits';
      return;
    }
    if (newPinInput !== newPinConfirmInput) {
      changePinError = 'New PINs do not match';
      return;
    }

    changePinSubmitting = true;
    try {
      await sendMessage(MessageType.PIN_CHANGE, {
        currentPin: currentPinInput,
        newPin: newPinInput,
        newPinConfirm: newPinConfirmInput,
      });
      showChangePinForm = false;
      currentPinInput = '';
      newPinInput = '';
      newPinConfirmInput = '';
      statusMessage = 'PIN changed successfully';
      setTimeout(() => (statusMessage = ''), 3000);
    } catch (err) {
      changePinError = (err as Error).message || 'Failed to change PIN';
    } finally {
      changePinSubmitting = false;
    }
  }

  async function handleRemovePinSubmit() {
    removePinError = '';
    if (!removePinInput) {
      removePinError = 'Enter your current PIN';
      return;
    }

    removePinSubmitting = true;
    try {
      await sendMessage(MessageType.PIN_REMOVE, { pin: removePinInput });
      showRemovePinForm = false;
      removePinInput = '';
      statusMessage = 'PIN protection removed';
      await refreshVaultStatus();
      setTimeout(() => (statusMessage = ''), 3000);
    } catch (err) {
      removePinError = (err as Error).message || 'Failed to remove PIN';
    } finally {
      removePinSubmitting = false;
    }
  }

  function filterNumeric(event: Event) {
    const input = event.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  }
</script>

<div class="settings-view">
  <div class="settings-view-header">
    <button class="back-button" on:click={handleBack} aria-label={t("Back")}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
    </button>
    <h3 class="settings-view-title">{t("Security")}</h3>
  </div>

  <div class="settings-section">
    <h4 class="section-title">{t("Credential Encryption")}</h4>
    <p class="section-description">
      {t("All API keys are encrypted at rest using AES-256-GCM. Enable PIN protection for additional security.")}
    </p>

    {#if statusMessage}
      <div class="status-message">{statusMessage}</div>
    {/if}

    <div class="setting-item">
      <div class="setting-info">
        <span class="setting-label">{t("PIN Protection")}</span>
        <span class="setting-value">
          {$vaultStore.isPinEnabled ? t("Enabled") : t("Disabled")}
        </span>
      </div>

      {#if !$vaultStore.isPinEnabled}
        <button class="btn-action" on:click={() => (showPinSetup = true)}>
          {t("Enable PIN")}
        </button>
      {:else}
        <div class="pin-actions">
          <button class="btn-action btn-secondary" on:click={() => { showChangePinForm = !showChangePinForm; showRemovePinForm = false; }}>
            {t("Change PIN")}
          </button>
          <button class="btn-action btn-danger" on:click={() => { showRemovePinForm = !showRemovePinForm; showChangePinForm = false; }}>
            {t("Remove PIN")}
          </button>
        </div>
      {/if}
    </div>

    <!-- Change PIN Form -->
    {#if showChangePinForm}
      <form class="inline-form" on:submit|preventDefault={handleChangePinSubmit}>
        <div class="form-field">
          <label>{t("Current PIN")}</label>
          <input type="password" inputmode="numeric" maxlength="6" bind:value={currentPinInput} on:input={filterNumeric} placeholder="------" autocomplete="off" />
        </div>
        <div class="form-field">
          <label>{t("New PIN")}</label>
          <input type="password" inputmode="numeric" maxlength="6" bind:value={newPinInput} on:input={filterNumeric} placeholder="------" autocomplete="off" />
        </div>
        <div class="form-field">
          <label>{t("Confirm New PIN")}</label>
          <input type="password" inputmode="numeric" maxlength="6" bind:value={newPinConfirmInput} on:input={filterNumeric} placeholder="------" autocomplete="off" />
        </div>
        {#if changePinError}
          <div class="form-error">{changePinError}</div>
        {/if}
        <button type="submit" class="btn-action" disabled={changePinSubmitting}>
          {changePinSubmitting ? t("Changing...") : t("Change PIN")}
        </button>
      </form>
    {/if}

    <!-- Remove PIN Form -->
    {#if showRemovePinForm}
      <form class="inline-form" on:submit|preventDefault={handleRemovePinSubmit}>
        <p class="form-warning">{t("Enter your current PIN to remove protection. API keys will still be encrypted with the default key.")}</p>
        <div class="form-field">
          <label>{t("Current PIN")}</label>
          <input type="password" inputmode="numeric" maxlength="6" bind:value={removePinInput} on:input={filterNumeric} placeholder="------" autocomplete="off" />
        </div>
        {#if removePinError}
          <div class="form-error">{removePinError}</div>
        {/if}
        <button type="submit" class="btn-action btn-danger" disabled={removePinSubmitting}>
          {removePinSubmitting ? t("Removing...") : t("Remove PIN")}
        </button>
      </form>
    {/if}
  </div>
</div>

{#if showPinSetup}
  <PinSetupDialog on:success={handlePinSetupSuccess} on:cancel={handlePinSetupCancel} />
{/if}

<style>
  .settings-view {
    padding: 1rem 1.5rem;
  }

  .settings-view-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--browserx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.375rem;
    display: flex;
  }

  .back-button:hover {
    color: var(--browserx-text);
    background: var(--browserx-surface);
  }

  .settings-view-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .settings-section {
    margin-bottom: 1.5rem;
  }

  .section-title {
    margin: 0 0 0.25rem;
    font-size: 0.9rem;
    color: var(--browserx-text);
  }

  .section-description {
    margin: 0 0 1rem;
    font-size: 0.8rem;
    color: var(--browserx-text-secondary);
    line-height: 1.4;
  }

  .status-message {
    padding: 0.5rem;
    margin-bottom: 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    color: var(--browserx-success, #00ff00);
    background: rgba(0, 255, 0, 0.1);
    border: 1px solid var(--browserx-success, #00ff00);
  }

  .setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--browserx-border);
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .setting-label {
    font-size: 0.85rem;
    color: var(--browserx-text);
  }

  .setting-value {
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
  }

  .pin-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-action {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    cursor: pointer;
    background: var(--browserx-primary, #00ff00);
    color: var(--browserx-background, #000);
    border: none;
    font-weight: 500;
  }

  .btn-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: transparent;
    color: var(--browserx-text);
    border: 1px solid var(--browserx-border);
  }

  .btn-danger {
    background: transparent;
    color: var(--browserx-error, #ff0000);
    border: 1px solid var(--browserx-error, #ff0000);
  }

  .inline-form {
    padding: 0.75rem;
    margin-top: 0.5rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    background: var(--browserx-surface);
  }

  .form-field {
    margin-bottom: 0.5rem;
  }

  .form-field label {
    display: block;
    font-size: 0.75rem;
    margin-bottom: 0.125rem;
    color: var(--browserx-text-secondary);
  }

  .form-field input {
    width: 100%;
    padding: 0.375rem;
    font-size: 1rem;
    letter-spacing: 0.2em;
    text-align: center;
    background: var(--browserx-background);
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    color: var(--browserx-text);
    box-sizing: border-box;
  }

  .form-field input:focus {
    outline: none;
    border-color: var(--browserx-primary);
  }

  .form-error {
    color: var(--browserx-error, #ff0000);
    font-size: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .form-warning {
    font-size: 0.8rem;
    color: var(--browserx-warning, #ffff00);
    margin: 0 0 0.5rem;
    line-height: 1.3;
  }
</style>
