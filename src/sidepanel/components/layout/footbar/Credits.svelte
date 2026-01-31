<script lang="ts">
  import Tooltip from '../../common/Tooltip.svelte';
  import PopupCard from '../../common/PopupCard.svelte';
  import { userStore } from '../../../stores/userStore';
  import { uiTheme, type UITheme } from '../../../stores/themeStore';
  import { HOME_PAGE_BASE_URL } from '../../../lib/constants';
  import { _t } from '../../../lib/i18n';

  // Plan constants
  const PLAN_NAMES: Record<number, string> = {
    0: 'Free',
    1: 'Basic',
    2: 'Plus',
    3: 'Pro',
    4: 'Enterprise',
  };

  const PLAN_COLORS: Record<number, string> = {
    0: 'from-gray-400 to-gray-500',
    1: 'from-blue-400 to-blue-500',
    2: 'from-purple-500 to-blue-500',
    3: 'from-amber-500 to-orange-500',
    4: 'from-emerald-500 to-teal-500',
  };

  const PLAN_ID_PLUS = 2;

  let showDetailsPopup = false;
  let currentTheme: UITheme = 'terminal';

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Get credits from user store
  $: credits = $userStore.credits;
  $: isLoading = $userStore.isCreditsLoading;

  // Computed values - Only use advanced credits for browserx
  $: totalDailyCredits = credits ? credits.daily_advanced_credits : 0;
  $: isLowCredits = totalDailyCredits < 10 && totalDailyCredits >= 0;
  $: isNegativeCredits = totalDailyCredits < 0;
  $: currentPlanName = credits ? (PLAN_NAMES[credits.plan_id] || 'Free') : 'Free';
  $: currentPlanColor = credits ? (PLAN_COLORS[credits.plan_id] || PLAN_COLORS[0]) : PLAN_COLORS[0];

  // Next refresh time (midnight UTC)
  $: hoursUntilRefresh = (() => {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return Math.floor((tomorrow.getTime() - now.getTime()) / (1000 * 60 * 60));
  })();

  function getCreditColor(): string {
    if (isNegativeCredits) return currentTheme === 'chatgpt' ? '#ef4444' : '#ff5252';
    if (isLowCredits) return currentTheme === 'chatgpt' ? '#f59e0b' : '#ff9800';
    return currentTheme === 'chatgpt' ? '#fbbf24' : '#ffc107';
  }

  function formatCreditValue(value: number): string {
    return value.toLocaleString();
  }

  function toggleDetailsPopup(event: MouseEvent) {
    event.stopPropagation();
    // Toggle popup - show even if credits is null (will just be empty)
    showDetailsPopup = !showDetailsPopup;
  }
</script>

<PopupCard
  title={$_t("Credit Details")}
  show={showDetailsPopup}
  onClose={() => showDetailsPopup = false}
>
  <div slot="trigger" class="credits-trigger {currentTheme}">
    <Tooltip content={$_t("Credit Details")} disabled={showDetailsPopup || isLoading}>
      <button
        class="credits-button"
        on:click={toggleDetailsPopup}
        aria-haspopup="true"
        aria-expanded={showDetailsPopup}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          class="credits-icon"
          style="fill: {isLoading ? (currentTheme === 'chatgpt' ? '#8e8ea0' : '#00cc00') : getCreditColor()};"
        >
          <path
            d="M12 .587l3.668 7.429L24 9.168l-6 5.847 1.416 8.268L12 18.896 4.584 23.283 6 15.015 0 9.168l8.332-1.152z"
          ></path>
        </svg>
        <span class="credits-value" style="color: {isLoading ? (currentTheme === 'chatgpt' ? '#8e8ea0' : '#00cc00') : getCreditColor()};">
          {#if isLoading}
            ...
          {:else}
            {formatCreditValue(totalDailyCredits)}
          {/if}
        </span>
      </button>
    </Tooltip>
  </div>

  <div slot="content" class="credits-content {currentTheme}">
    {#if isLoading}
      <div class="loading-state">
        <span class="loading-dot"></span>
        <span class="loading-text">{$_t("Loading credits...")}</span>
      </div>
    {:else if !credits}
      <div class="error-state">
        <span class="error-text">{$_t("Unable to load credit information")}</span>
      </div>
    {:else if credits}
      <!-- Current Plan Section -->
      <div class="plan-section">
        <div class="plan-label">{$_t("Current Plan:")}</div>
        <span class="plan-badge bg-gradient-to-r {currentPlanColor}">
          {currentPlanName}
        </span>
      </div>

      <!-- Daily Credits Section -->
      <div class="credits-section">
        <h4 class="section-title">{$_t("Daily Credits")}</h4>
        <div class="credit-row">
          <span class="credit-label">{$_t("Remaining:")}</span>
          <span class="credit-value total-value" class:negative={credits.daily_advanced_credits < 0} style="color: {getCreditColor()};">
            {formatCreditValue(credits.daily_advanced_credits)}
          </span>
        </div>
      </div>

      <!-- Monthly Credits Section -->
      {#if credits.monthly_advanced_credits > 0}
        <div class="credits-section">
          <h4 class="section-title">{$_t("Monthly Credits")}</h4>
          <div class="credit-row">
            <span class="credit-label">{$_t("Remaining:")}</span>
            <span class="credit-value">{formatCreditValue(credits.monthly_advanced_credits)}</span>
          </div>
        </div>
      {/if}

      <!-- Extra Credits Section -->
      {#if credits.extra_advanced_credits > 0}
        <div class="credits-section">
          <h4 class="section-title">{$_t("Extra Credits")}</h4>
          <div class="credit-row">
            <span class="credit-label">{$_t("Available:")}</span>
            <span class="credit-value extra">+{formatCreditValue(credits.extra_advanced_credits)}</span>
          </div>
        </div>
      {/if}

      <!-- Status Indicators -->
      <div class="status-section">
        {#if isNegativeCredits && credits.extra_advanced_credits > 0}
          <div class="status-item info">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>{$_t("Using extra credits")}</span>
          </div>
        {/if}

        {#if hoursUntilRefresh > 0}
          <div class="status-item muted">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span>{$_t("Refreshes in")} {hoursUntilRefresh}h</span>
          </div>
        {/if}

        {#if isLowCredits && !isNegativeCredits}
          <div class="status-item warning">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span>{$_t("Low credits remaining")}</span>
          </div>
        {/if}
      </div>

      <!-- Upgrade Button -->
      {#if credits.plan_id < PLAN_ID_PLUS}
        <a
          href="{HOME_PAGE_BASE_URL}/pricing"
          target="_blank"
          rel="noopener noreferrer"
          class="upgrade-button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
          </svg>
          <span>{credits.plan_id === 0 ? $_t('Upgrade to Premium') : $_t('Upgrade My Plan')}</span>
        </a>
      {/if}
    {/if}
  </div>
</PopupCard>

<style>
  /* Credits Trigger Container */
  .credits-trigger {
    display: flex;
    align-items: center;
  }

  /* Loading state */
  .loading-dot {
    width: 6px;
    height: 6px;
    background-color: var(--color-term-dim-green, #00cc00);
    border-radius: 50%;
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* Loading and Error States in Popup */
  .loading-state,
  .error-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 20px;
    min-width: 180px;
  }

  .loading-text {
    font-size: 12px;
    color: var(--color-term-dim-green, #00cc00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .error-text {
    font-size: 12px;
    color: var(--color-term-dim-green, #00cc00);
    font-family: 'Monaco', 'Courier New', monospace;
    text-align: center;
  }

  /* Credits Button - Terminal Theme (default) */
  .credits-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 10px;
    min-width: 50px;
    min-height: 28px;
    background: transparent;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .credits-button:hover:not(:disabled) {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--color-term-bright-green, #33ff00);
  }

  .credits-button:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .credits-icon {
    width: 14px;
    height: 14px;
    transition: transform 0.2s ease;
  }

  .credits-value {
    font-size: 12px;
    font-weight: 600;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  /* Credits Content Styles */
  .credits-content {
    min-width: 220px;
  }

  /* Plan Section */
  .plan-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px;
    margin-bottom: 12px;
    background: rgba(0, 255, 0, 0.05);
    border: 1px solid rgba(0, 204, 0, 0.3);
    border-radius: 4px;
  }

  .plan-label {
    font-size: 12px;
    color: var(--color-term-dim-green, #00cc00);
  }

  .plan-badge {
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 700;
    color: white;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Credits Section */
  .credits-section {
    margin-bottom: 12px;
  }

  .section-title {
    margin: 0 0 8px 0;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-term-dim-green, #00cc00);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .credit-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
  }

  .credit-row.total {
    padding-top: 8px;
    margin-top: 4px;
    border-top: 1px solid rgba(0, 204, 0, 0.2);
  }

  .credit-label {
    font-size: 12px;
    color: var(--color-term-green, #00ff00);
  }

  .credit-value {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-term-bright-green, #33ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .credit-value.negative {
    color: #ff5252;
  }

  .credit-value.extra {
    color: #4caf50;
  }

  .credit-value.total-value {
    font-weight: 700;
  }

  /* Status Section */
  .status-section {
    padding-top: 8px;
    border-top: 1px solid rgba(0, 204, 0, 0.2);
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    margin-top: 6px;
  }

  .status-item.info {
    color: #60a5fa;
  }

  .status-item.muted {
    color: var(--color-term-dim-green, #00cc00);
  }

  .status-item.warning {
    color: #ff9800;
  }

  /* Upgrade Button */
  .upgrade-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    margin-top: 12px;
    padding: 10px;
    background: linear-gradient(to right, #8b5cf6, #3b82f6);
    color: white;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    border-radius: 6px;
    transition: all 0.2s ease;
  }

  .upgrade-button:hover {
    transform: scale(1.02);
    box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .credits-trigger.chatgpt .loading-dot {
    background-color: var(--chat-text-muted, #8e8ea0);
  }

  .credits-trigger.chatgpt .credits-button {
    border: none;
    border-radius: 0.5rem;
    padding: 6px 10px;
  }

  .credits-trigger.chatgpt .credits-button:hover:not(:disabled) {
    background: var(--chat-button-hover, #ececec);
  }

  .credits-trigger.chatgpt .credits-value {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  /* Content ChatGPT overrides */
  .credits-content.chatgpt .loading-text,
  .credits-content.chatgpt .error-text {
    color: rgba(255, 255, 255, 0.7);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .credits-content.chatgpt .loading-dot {
    background-color: var(--chat-text-muted, #8e8ea0);
  }

  .credits-content.chatgpt .plan-section {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
  }

  .credits-content.chatgpt .plan-label {
    color: rgba(255, 255, 255, 0.7);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .credits-content.chatgpt .section-title {
    color: rgba(255, 255, 255, 0.6);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .credits-content.chatgpt .credit-row.total {
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .credits-content.chatgpt .credit-label {
    color: var(--chat-tooltip-text, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .credits-content.chatgpt .credit-value {
    color: rgba(255, 255, 255, 0.9);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .credits-content.chatgpt .credit-value.negative {
    color: #ef4444;
  }

  .credits-content.chatgpt .credit-value.extra {
    color: #10b981;
  }

  .credits-content.chatgpt .status-section {
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .credits-content.chatgpt .status-item.muted {
    color: rgba(255, 255, 255, 0.5);
  }

  .credits-content.chatgpt .status-item.warning {
    color: #f59e0b;
  }

  .credits-content.chatgpt .upgrade-button {
    border-radius: 0.5rem;
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }
</style>
