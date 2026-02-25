<!--
  PinUnlockOverlay - Full-screen vault unlock overlay
  Blocks all interaction until correct PIN entered.
  Dispatches: unlocked
-->

<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { t } from '../../lib/i18n';
  import { vaultStore, refreshVaultStatus } from '../../stores/vaultStore';

  const dispatch = createEventDispatcher<{ unlocked: void }>();

  let pin = '';
  let error = '';
  let isSubmitting = false;
  let showForgotConfirm = false;
  let forgotSubmitting = false;

  // Lockout countdown
  let countdownInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    // Start countdown if already locked out
    if ($vaultStore.isLockedOut && $vaultStore.lockoutSecondsRemaining > 0) {
      startCountdown();
    }
  });

  onDestroy(() => {
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
  });

  function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      vaultStore.update((s) => {
        const remaining = s.lockoutSecondsRemaining - 1;
        if (remaining <= 0) {
          if (countdownInterval) clearInterval(countdownInterval);
          countdownInterval = null;
          return { ...s, isLockedOut: false, lockoutSecondsRemaining: 0 };
        }
        return { ...s, lockoutSecondsRemaining: remaining };
      });
    }, 1000);
  }

  async function handleSubmit() {
    error = '';
    if (!/^\d{6}$/.test(pin)) {
      error = 'PIN must be exactly 6 digits';
      return;
    }

    isSubmitting = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'vault:unlock',
        payload: { pin },
      });

      if (response?.success) {
        pin = '';
        await refreshVaultStatus();
        dispatch('unlocked');
      } else if (response?.data?.isLockedOut) {
        error = 'Too many attempts';
        vaultStore.update((s) => ({
          ...s,
          isLockedOut: true,
          lockoutSecondsRemaining: response.data.lockoutSecondsRemaining || 30,
        }));
        startCountdown();
        pin = '';
      } else {
        error = response?.message || 'Incorrect PIN';
        pin = '';
      }
    } catch {
      error = 'Failed to communicate with extension';
    } finally {
      isSubmitting = false;
    }
  }

  async function handleForgotPinConfirm() {
    forgotSubmitting = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'vault:pin:forgot',
        payload: { confirmReset: true },
      });

      if (response?.success) {
        showForgotConfirm = false;
        await refreshVaultStatus();
        dispatch('unlocked');
      } else {
        error = response?.message || 'Failed to reset vault';
      }
    } catch {
      error = 'Failed to communicate with extension';
    } finally {
      forgotSubmitting = false;
    }
  }

  function handlePinInput(event: Event) {
    const input = event.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    pin = input.value;
  }
</script>

<div class="unlock-overlay">
  <div class="unlock-dialog">
    <div class="lock-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        <circle cx="12" cy="16" r="1"></circle>
      </svg>
    </div>

    <h2 class="unlock-title">{t("Vault Locked")}</h2>
    <p class="unlock-description">
      {t("Enter your 6-digit PIN to unlock your API keys.")}
    </p>

    {#if !showForgotConfirm}
      <form on:submit|preventDefault={handleSubmit}>
        {#if $vaultStore.isLockedOut}
          <div class="lockout-message">
            {t("Too many failed attempts. Try again in")}
            <span class="countdown">{$vaultStore.lockoutSecondsRemaining}s</span>
          </div>
        {:else}
          <div class="pin-field">
            <input
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

          {#if error}
            <div class="unlock-error">{error}</div>
          {/if}

          <button type="submit" class="btn-unlock" disabled={isSubmitting || pin.length !== 6}>
            {isSubmitting ? t("Unlocking...") : t("Unlock")}
          </button>
        {/if}
      </form>

      <button class="btn-forgot" on:click={() => { showForgotConfirm = true; error = ''; }}>
        {t("Forgot PIN?")}
      </button>
    {:else}
      <div class="forgot-confirm">
        <p class="forgot-warning">
          {t("This will permanently delete all stored API keys and reset the vault. You will need to re-enter your API keys.")}
        </p>
        <div class="forgot-actions">
          <button class="btn-cancel" on:click={() => (showForgotConfirm = false)} disabled={forgotSubmitting}>
            {t("Cancel")}
          </button>
          <button class="btn-danger" on:click={handleForgotPinConfirm} disabled={forgotSubmitting}>
            {forgotSubmitting ? t("Resetting...") : t("Reset Vault")}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .unlock-overlay {
    position: fixed;
    inset: 0;
    background: var(--browserx-background, #000);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }

  .unlock-dialog {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem;
    max-width: 320px;
    width: 100%;
  }

  .lock-icon {
    color: var(--browserx-primary, #00ff00);
    margin-bottom: 1rem;
    opacity: 0.8;
  }

  .unlock-title {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
    color: var(--browserx-text, #00ff00);
    text-align: center;
  }

  .unlock-description {
    margin: 0 0 1.5rem;
    font-size: 0.85rem;
    color: var(--browserx-text-secondary, #00cc00);
    text-align: center;
    line-height: 1.4;
  }

  form {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .pin-field {
    width: 100%;
    margin-bottom: 0.75rem;
  }

  .pin-field input {
    width: 100%;
    padding: 0.75rem;
    font-size: 1.5rem;
    letter-spacing: 0.4em;
    text-align: center;
    background: var(--browserx-surface, #0a0a0a);
    border: 1px solid var(--browserx-border, #00cc00);
    border-radius: 0.5rem;
    color: var(--browserx-text, #00ff00);
    box-sizing: border-box;
  }

  .pin-field input:focus {
    outline: none;
    border-color: var(--browserx-primary, #00ff00);
  }

  .unlock-error {
    color: var(--browserx-error, #ff0000);
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
    text-align: center;
  }

  .lockout-message {
    color: var(--browserx-warning, #ffff00);
    font-size: 0.9rem;
    text-align: center;
    margin-bottom: 1rem;
    line-height: 1.4;
  }

  .countdown {
    font-weight: 700;
    font-size: 1.1rem;
    display: inline-block;
    margin-left: 0.25rem;
  }

  .btn-unlock {
    width: 100%;
    padding: 0.625rem;
    border-radius: 0.5rem;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    background: var(--browserx-primary, #00ff00);
    color: var(--browserx-background, #000);
    border: none;
  }

  .btn-unlock:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-forgot {
    background: none;
    border: none;
    color: var(--browserx-text-secondary, #00cc00);
    font-size: 0.8rem;
    cursor: pointer;
    margin-top: 1rem;
    padding: 0.25rem 0.5rem;
  }

  .btn-forgot:hover {
    color: var(--browserx-text, #00ff00);
    text-decoration: underline;
  }

  .forgot-confirm {
    width: 100%;
    text-align: center;
  }

  .forgot-warning {
    margin: 0 0 1rem;
    font-size: 0.85rem;
    color: var(--browserx-error, #ff0000);
    line-height: 1.4;
  }

  .forgot-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
  }

  .btn-cancel, .btn-danger {
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

  .btn-cancel:hover:not(:disabled) {
    background: var(--browserx-surface, #0a0a0a);
  }

  .btn-danger {
    background: transparent;
    color: var(--browserx-error, #ff0000);
    border-color: var(--browserx-error, #ff0000);
  }

  .btn-danger:hover:not(:disabled) {
    background: rgba(255, 0, 0, 0.1);
  }

  .btn-danger:disabled, .btn-cancel:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
