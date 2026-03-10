<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { userStore, userInitials, getLoginPageUrl } from '../../stores/userStore';
  import { uiTheme } from '../../stores/themeStore';
  import { platform } from '../../stores/platformStore';
  import { HOME_PAGE_BASE_URL, LLM_API_URL } from '../../lib/constants';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { _t } from '../../lib/i18n';
  import { fetchUserProfile } from '../../lib/apis';

  let isLoggingIn = $state(false);
  let cancelLogin: (() => void) | null = $state(null);

  let showMenu = $state(false);
  let showPromoTooltip = $state(false);
  let promoTooltipTimer: ReturnType<typeof setTimeout> | null = null;
  let hasShownPromoTooltip = $state(false);

  // Watch for user state changes to show promo tooltip when not logged in (only once)
  $effect(() => {
    if (!$userStore.isLoading && !$userStore.isLoggedIn && !hasShownPromoTooltip) {
      showPromoTooltipWithTimer();
    } else if ($userStore.isLoggedIn) {
      hidePromoTooltip();
      hasShownPromoTooltip = false;
    }
  });

  function showPromoTooltipWithTimer() {
    // Only show once per session
    if (!showPromoTooltip && !hasShownPromoTooltip) {
      showPromoTooltip = true;
      hasShownPromoTooltip = true;
      // Auto-hide after 5 seconds
      promoTooltipTimer = setTimeout(() => {
        showPromoTooltip = false;
        promoTooltipTimer = null;
      }, 5000);
    }
  }

  function hidePromoTooltip() {
    showPromoTooltip = false;
    if (promoTooltipTimer) {
      clearTimeout(promoTooltipTimer);
      promoTooltipTimer = null;
    }
  }

  onDestroy(() => {
    hidePromoTooltip();
  });

  async function openLoginPage() {
    if (platform.platformName === 'desktop') {
      // Desktop mode: use DesktopAuthService with deep link OAuth
      isLoggingIn = true;

      // Create a cancellation mechanism
      let isCancelled = false;
      cancelLogin = () => {
        isCancelled = true;
        isLoggingIn = false;
        cancelLogin = null;
        // Reject the pending login promise so the deep link callback cannot
        // silently authenticate the user after they cancelled.
        authService.cancelLogin();
        console.log('[UserLoginStatus] Login cancelled by user');
      };

      try {
        const { getDesktopAuthService } = await import('@/desktop/auth/DesktopAuthService');
        const authService = getDesktopAuthService(HOME_PAGE_BASE_URL);
        await authService.initialize();
        const session = await authService.login();

        // Check if cancelled while waiting
        if (isCancelled) return;

        // Fetch user profile using same API as extension to get accurate userType
        const accessToken = await authService.getAccessToken();
        const profile = accessToken ? await fetchUserProfile(accessToken) : null;

        // Update user store - prefer profile data (has accurate userType)
        if (profile) {
          userStore.setUser({
            name: profile.name || session.given_name || session.name || null,
            email: profile.email || session.email,
            avatar: profile.avatar || session.picture || null,
            userType: profile.userType,
          });
        } else {
          // Fallback to session data
          userStore.setUser({
            name: session.given_name || session.name || null,
            email: session.email,
            avatar: session.picture || null,
            userType: (session.subscription as any)?.plan_id ?? 0,
          });
        }

        // Tell the agent to switch to backend routing mode (direct call, same process)
        try {
          const { getDesktopAgentBootstrap } = await import('@/desktop/agent/DesktopAgentBootstrap');
          const bootstrap = getDesktopAgentBootstrap();
          const tokenGetter = () => authService.getAccessToken();
          await bootstrap.setAuthMode(false, LLM_API_URL, tokenGetter);
          console.log('[UserLoginStatus] Desktop auth mode set to backend routing');
        } catch (authError) {
          console.warn('[UserLoginStatus] Failed to set desktop auth mode:', authError);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error('[UserLoginStatus] Desktop login failed:', error);
        }
      } finally {
        if (!isCancelled) {
          isLoggingIn = false;
          cancelLogin = null;
        }
      }
    } else {
      // Extension mode: open login page in a new tab
      const loginUrl = getLoginPageUrl();
      chrome.tabs.create({ url: loginUrl });
    }
  }

  function handleLoginClick() {
    if (isLoggingIn && cancelLogin) {
      // Cancel ongoing login
      cancelLogin();
    } else {
      // Start login
      openLoginPage();
    }
  }

  function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    showMenu = !showMenu;
  }

  function closeMenu() {
    showMenu = false;
  }

  function openSettings() {
    showMenu = false;
    push('/settings');
  }

  async function openUserCenter(event: MouseEvent) {
    event.preventDefault();
    showMenu = false;
    const userCenterUrl = `${HOME_PAGE_BASE_URL}/user-center/info`;

    if (platform.platformName === 'desktop') {
      // Desktop mode: use Tauri shell plugin to open in browser
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(userCenterUrl);
    } else {
      // Extension mode: use chrome.tabs.create
      chrome.tabs.create({ url: userCenterUrl });
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showMenu = !showMenu;
    } else if (event.key === 'Escape') {
      showMenu = false;
    }
  }
</script>

<div class="relative flex items-center justify-center">
  {#if $userStore.isLoading}
    <!-- Loading state -->
    <div class="w-8 h-8 flex items-center justify-center">
      <span class="loading-dot w-2 h-2 rounded-full
        {$uiTheme === 'modern'
          ? 'bg-chat-text-muted dark:bg-chat-text-muted-dark'
          : 'bg-term-dim-green'}"></span>
    </div>
  {:else if $userStore.isLoggedIn}
    <!-- Logged in state - show user avatar with initials -->
    <PopupCard title="" show={showMenu} onClose={closeMenu}>
      {#snippet trigger()}<div>
        <Tooltip content={$_t("User Center")} disabled={showMenu}>
          <div
            class="relative w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all duration-200
              {$uiTheme === 'modern'
                ? 'bg-chat-primary dark:bg-chat-primary-dark border-none hover:shadow-[0_2px_8px_rgba(96,165,250,0.3)]'
                : 'bg-term-bg border border-term-green hover:border-term-bright-green hover:shadow-[0_0_8px_rgba(0,255,0,0.3)]'}"
            onclick={toggleMenu}
            onkeydown={handleKeydown}
            role="button"
            tabindex="0"
            aria-haspopup="true"
            aria-expanded={showMenu}
          >
            <span class="text-sm font-semibold uppercase
              {$uiTheme === 'modern'
                ? 'text-white font-chat'
                : 'text-term-green font-terminal'}">{$userInitials}</span>
          </div>
        </Tooltip>
      </div>{/snippet}

      {#snippet content()}<div class="min-w-[180px]">
        <!-- User Info Section -->
        <a
          href="{HOME_PAGE_BASE_URL}/user-center/info"
          class="flex items-center gap-3 p-3 no-underline cursor-pointer rounded transition-colors duration-150
            {$uiTheme === 'modern'
              ? 'hover:bg-white/10'
              : 'hover:bg-term-green/10'}"
          onclick={openUserCenter}
        >
          <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0
            {$uiTheme === 'modern'
              ? 'bg-chat-primary dark:bg-chat-primary-dark border-none'
              : 'bg-term-green/10 border border-term-dim-green'}">
            <span class="text-base font-semibold uppercase
              {$uiTheme === 'modern'
                ? 'text-white font-chat'
                : 'text-term-green font-terminal'}">{$userInitials}</span>
          </div>
          <div class="flex flex-col gap-0.5 overflow-hidden">
            {#if $userStore.userName}
              <span class="text-sm font-medium whitespace-nowrap overflow-hidden text-ellipsis
                {$uiTheme === 'modern'
                  ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
                  : 'text-term-bright-green'}">{$userStore.userName}</span>
            {/if}
            {#if $userStore.userEmail}
              <span class="text-sm whitespace-nowrap overflow-hidden text-ellipsis
                {$uiTheme === 'modern'
                  ? 'text-white/70 font-chat'
                  : 'text-term-dim-green'}">{$userStore.userEmail}</span>
            {:else if !$userStore.userName}
              <span class="text-sm
                {$uiTheme === 'modern'
                  ? 'text-white/70 font-chat'
                  : 'text-term-dim-green'}">{$_t("Logged in")}</span>
            {/if}
          </div>
        </a>

        <div class="{$uiTheme === 'modern'
          ? 'h-px bg-white/15'
          : 'h-px bg-term-dim-green/30'}"></div>

        <!-- Menu Items -->
        <button
          class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none cursor-pointer text-sm text-left transition-colors duration-150
            {$uiTheme === 'modern'
              ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat rounded-md m-1 w-[calc(100%-8px)] hover:bg-white/10'
              : 'text-term-green font-terminal hover:bg-term-green/10'}"
          onclick={openSettings}
          role="menuitem"
        >
          <svg class="w-[18px] h-[18px] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>{$_t("Settings")}</span>
        </button>
      </div>{/snippet}
    </PopupCard>
  {:else}
    <!-- Not logged in state - show login link -->
    <Tooltip content={isLoggingIn ? $_t("Click to cancel login") : (showPromoTooltip ? $_t("Login to get free credits") : $_t("Sign in to your account"))}>
      <button
        class="relative cursor-pointer text-sm transition-all duration-200
          {$uiTheme === 'modern'
            ? 'bg-transparent border-none text-chat-primary dark:text-chat-primary-dark font-chat font-medium py-1.5 px-3 rounded-lg hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark hover:text-chat-text dark:hover:text-chat-text-dark'
            : 'bg-transparent border border-term-green text-term-green font-terminal py-1.5 px-3 rounded hover:bg-term-green/10 hover:border-term-bright-green hover:text-term-bright-green'}
          {isLoggingIn ? 'hover:!bg-red-500/10 hover:!border-red-400 hover:!text-red-400' : ''}"
        onclick={handleLoginClick}
      >
        {#if isLoggingIn}
          <span class="login-spinner"></span>
          {$_t("Logging in...")}
        {:else}
          {$_t("Login")}
        {/if}
      </button>
    </Tooltip>
  {/if}
</div>

<style>
  .loading-dot {
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .login-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 6px;
    vertical-align: middle;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
