<script lang="ts">
  import Tooltip from '../../common/Tooltip.svelte';
  import PopupCard from '../../common/PopupCard.svelte';
  import { userStore } from '../../../stores/userStore';
  import { uiTheme, type UITheme } from '../../../stores/themeStore';
  import { HOME_PAGE_BASE_URL } from '../../../lib/constants';
  import { _t } from '../../../lib/i18n';

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

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  $: credits = $userStore.credits;
  $: isLoading = $userStore.isCreditsLoading;

  $: totalDailyCredits = credits ? credits.daily_advanced_credits : 0;
  $: isLowCredits = totalDailyCredits < 10 && totalDailyCredits >= 0;
  $: isNegativeCredits = totalDailyCredits < 0;
  $: currentPlanName = credits ? (PLAN_NAMES[credits.plan_id] || 'Free') : 'Free';
  $: currentPlanColor = credits ? (PLAN_COLORS[credits.plan_id] || PLAN_COLORS[0]) : PLAN_COLORS[0];

  $: hoursUntilRefresh = (() => {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return Math.floor((tomorrow.getTime() - now.getTime()) / (1000 * 60 * 60));
  })();

  function getCreditColor(): string {
    if (isNegativeCredits) return currentTheme === 'modern' ? '#ef4444' : '#ff5252';
    if (isLowCredits) return currentTheme === 'modern' ? '#f59e0b' : '#ff9800';
    return currentTheme === 'modern' ? '#fbbf24' : '#ffc107';
  }

  function formatCreditValue(value: number): string {
    return value.toLocaleString();
  }

  function toggleDetailsPopup(event: MouseEvent) {
    event.stopPropagation();
    showDetailsPopup = !showDetailsPopup;
  }
</script>

<PopupCard
  title={$_t("Credit Details")}
  show={showDetailsPopup}
  onClose={() => showDetailsPopup = false}
>
  <div slot="trigger" class="flex items-center">
    <Tooltip content={$_t("Credit Details")} disabled={showDetailsPopup || isLoading}>
      <button
        class="flex items-center justify-center gap-1.5 py-1.5 px-2.5 min-w-[50px] min-h-[28px] cursor-pointer transition-all duration-200
          {currentTheme === 'modern'
            ? 'bg-transparent border-none rounded-lg hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
            : 'bg-transparent border border-term-dim-green rounded hover:bg-term-green/10 hover:border-term-bright-green'}
          disabled:cursor-default disabled:opacity-70"
        on:click={toggleDetailsPopup}
        aria-haspopup="true"
        aria-expanded={showDetailsPopup}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5 transition-transform duration-200"
          style="fill: {isLoading ? (currentTheme === 'modern' ? '#8e8ea0' : '#00cc00') : getCreditColor()};"
        >
          <path
            d="M12 .587l3.668 7.429L24 9.168l-6 5.847 1.416 8.268L12 18.896 4.584 23.283 6 15.015 0 9.168l8.332-1.152z"
          ></path>
        </svg>
        <span class="text-sm font-semibold
          {currentTheme === 'modern' ? 'font-chat' : 'font-mono'}"
          style="color: {isLoading ? (currentTheme === 'modern' ? '#8e8ea0' : '#00cc00') : getCreditColor()};">
          {#if isLoading}
            ...
          {:else}
            {formatCreditValue(totalDailyCredits)}
          {/if}
        </span>
      </button>
    </Tooltip>
  </div>

  <div slot="content" class="min-w-[220px]">
    {#if isLoading}
      <div class="flex items-center justify-center gap-2 p-5 min-w-[180px]">
        <span class="loading-dot w-1.5 h-1.5 rounded-full
          {currentTheme === 'modern' ? 'bg-chat-text-muted dark:bg-chat-text-muted-dark' : 'bg-term-dim-green'}"></span>
        <span class="text-sm
          {currentTheme === 'modern' ? 'font-chat text-white/70' : 'font-mono text-term-dim-green'}">{$_t("Loading credits...")}</span>
      </div>
    {:else if !credits}
      <div class="flex items-center justify-center gap-2 p-5 min-w-[180px]">
        <span class="text-sm text-center
          {currentTheme === 'modern' ? 'font-chat text-white/70' : 'font-mono text-term-dim-green'}">{$_t("Unable to load credit information")}</span>
      </div>
    {:else if credits}
      <!-- Current Plan Section -->
      <div class="flex items-center justify-between p-2.5 mb-3 rounded
        {currentTheme === 'modern'
          ? 'bg-white/5 border border-white/10 rounded-lg'
          : 'bg-term-green/5 border border-term-dim-green/30'}">
        <span class="text-sm
          {currentTheme === 'modern' ? 'font-chat text-white/70' : 'text-term-dim-green'}">{$_t("Current Plan:")}</span>
        <span class="py-1 px-2.5 text-sm font-bold text-white rounded-xl uppercase tracking-wider bg-gradient-to-r {currentPlanColor}">
          {currentPlanName}
        </span>
      </div>

      <!-- Daily Credits Section -->
      <div class="mb-3">
        <h4 class="m-0 mb-2 text-sm font-medium uppercase tracking-wider
          {currentTheme === 'modern' ? 'font-chat text-white/60' : 'text-term-dim-green'}">{$_t("Daily Credits")}</h4>
        <div class="flex justify-between items-center py-1">
          <span class="text-sm
            {currentTheme === 'modern' ? 'font-chat text-white' : 'text-term-green'}">{$_t("Remaining:")}</span>
          <span class="text-sm font-medium
            {currentTheme === 'modern' ? 'font-chat' : 'font-mono'}
            {isNegativeCredits ? (currentTheme === 'modern' ? 'text-red-500' : 'text-red-400') : (currentTheme === 'modern' ? 'text-white/90' : 'text-term-bright-green')}"
            style="color: {getCreditColor()};">
            {formatCreditValue(credits.daily_advanced_credits)}
          </span>
        </div>
      </div>

      <!-- Monthly Credits Section -->
      {#if credits.monthly_advanced_credits > 0}
        <div class="mb-3">
          <h4 class="m-0 mb-2 text-sm font-medium uppercase tracking-wider
            {currentTheme === 'modern' ? 'font-chat text-white/60' : 'text-term-dim-green'}">{$_t("Monthly Credits")}</h4>
          <div class="flex justify-between items-center py-1">
            <span class="text-sm
              {currentTheme === 'modern' ? 'font-chat text-white' : 'text-term-green'}">{$_t("Remaining:")}</span>
            <span class="text-sm font-medium
              {currentTheme === 'modern' ? 'font-chat text-white/90' : 'font-mono text-term-bright-green'}">{formatCreditValue(credits.monthly_advanced_credits)}</span>
          </div>
        </div>
      {/if}

      <!-- Extra Credits Section -->
      {#if credits.extra_advanced_credits > 0}
        <div class="mb-3">
          <h4 class="m-0 mb-2 text-sm font-medium uppercase tracking-wider
            {currentTheme === 'modern' ? 'font-chat text-white/60' : 'text-term-dim-green'}">{$_t("Extra Credits")}</h4>
          <div class="flex justify-between items-center py-1">
            <span class="text-sm
              {currentTheme === 'modern' ? 'font-chat text-white' : 'text-term-green'}">{$_t("Available:")}</span>
            <span class="text-sm font-medium
              {currentTheme === 'modern' ? 'font-chat text-emerald-500' : 'font-mono text-green-500'}">+{formatCreditValue(credits.extra_advanced_credits)}</span>
          </div>
        </div>
      {/if}

      <!-- Status Indicators -->
      <div class="pt-2 border-t
        {currentTheme === 'modern' ? 'border-white/10' : 'border-term-dim-green/20'}">
        {#if isNegativeCredits && credits.extra_advanced_credits > 0}
          <div class="flex items-center gap-1.5 text-sm mt-1.5 text-blue-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>{$_t("Using extra credits")}</span>
          </div>
        {/if}

        {#if hoursUntilRefresh > 0}
          <div class="flex items-center gap-1.5 text-sm mt-1.5
            {currentTheme === 'modern' ? 'text-white/50' : 'text-term-dim-green'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span>{$_t("Refreshes in")} {hoursUntilRefresh}h</span>
          </div>
        {/if}

        {#if isLowCredits && !isNegativeCredits}
          <div class="flex items-center gap-1.5 text-sm mt-1.5
            {currentTheme === 'modern' ? 'text-amber-500' : 'text-orange-500'}">
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
          class="flex items-center justify-center gap-2 w-full mt-3 p-2.5 bg-gradient-to-r from-violet-500 to-blue-500 text-white text-sm font-semibold no-underline rounded-md transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-violet-500/30
            {currentTheme === 'modern' ? 'font-chat rounded-lg' : ''}"
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
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .loading-dot {
    animation: pulse 1s infinite;
  }
</style>
