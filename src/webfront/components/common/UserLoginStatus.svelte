<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { userStore, userInitials, getLoginPageUrl } from '../../stores/userStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { platform } from '../../stores/platformStore';
  import { HOME_PAGE_BASE_URL, LLM_API_URL } from '../../lib/constants';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { _t } from '../../lib/i18n';
  import { fetchUserProfile } from '../../lib/apis';

  const dispatch = createEventDispatcher();

  let isLoggingIn = false;
  let cancelLogin: (() => void) | null = null;

  let currentTheme: UITheme = 'terminal';
  let showMenu = false;
  let showPromoTooltip = false;
  let promoTooltipTimer: ReturnType<typeof setTimeout> | null = null;
  let hasShownPromoTooltip = false; // Track if we've already shown it once

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Watch for user state changes to show promo tooltip when not logged in (only once)
  $: if (!$userStore.isLoading && !$userStore.isLoggedIn && !hasShownPromoTooltip) {
    showPromoTooltipWithTimer();
  } else if ($userStore.isLoggedIn) {
    // User logged in, hide tooltip and reset flag for next session
    hidePromoTooltip();
    hasShownPromoTooltip = false;
  }

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
    dispatch('openSettings');
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

<div class="user-login-status {currentTheme}">
  {#if $userStore.isLoading}
    <!-- Loading state -->
    <div class="status-loading">
      <span class="loading-dot"></span>
    </div>
  {:else if $userStore.isLoggedIn}
    <!-- Logged in state - show user avatar with initials -->
    <PopupCard title="" show={showMenu} onClose={closeMenu}>
      <div slot="trigger">
        <Tooltip content={$_t("User Center")} disabled={showMenu}>
          <div
            class="user-avatar {currentTheme}"
            on:click={toggleMenu}
            on:keydown={handleKeydown}
            role="button"
            tabindex="0"
            aria-haspopup="true"
            aria-expanded={showMenu}
          >
            <span class="avatar-initials">{$userInitials}</span>
          </div>
        </Tooltip>
      </div>

      <div slot="content" class="user-menu-content {currentTheme}">
        <!-- User Info Section -->
        <a
          href="{HOME_PAGE_BASE_URL}/user-center/info"
          class="menu-section user-info user-info-link"
          on:click={openUserCenter}
        >
          <div class="user-info-avatar">
            <span class="avatar-initials-large">{$userInitials}</span>
          </div>
          <div class="user-info-details">
            {#if $userStore.userName}
              <span class="user-name">{$userStore.userName}</span>
            {/if}
            {#if $userStore.userEmail}
              <span class="user-email">{$userStore.userEmail}</span>
            {:else if !$userStore.userName}
              <span class="user-status">{$_t("Logged in")}</span>
            {/if}
          </div>
        </a>

        <div class="menu-divider"></div>

        <!-- Menu Items -->
        <button class="menu-item" on:click={openSettings} role="menuitem">
          <svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>{$_t("Settings")}</span>
        </button>
      </div>
    </PopupCard>
  {:else}
    <!-- Not logged in state - show login link -->
    <Tooltip content={isLoggingIn ? $_t("Click to cancel login") : (showPromoTooltip ? $_t("Login to get free credits") : $_t("Sign in to your account"))}>
      <button
        class="login-link"
        class:logging-in={isLoggingIn}
        on:click={handleLoginClick}
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
  .user-login-status {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Loading state */
  .status-loading {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .loading-dot {
    width: 8px;
    height: 8px;
    background-color: var(--color-term-dim-green, #00cc00);
    border-radius: 50%;
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* User Avatar - Terminal Theme */
  .user-avatar {
    position: relative;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #000000;
    border: 1px solid var(--color-term-green, #00ff00);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .user-avatar:hover {
    border-color: var(--color-term-bright-green, #33ff00);
    box-shadow: 0 0 8px rgba(0, 255, 0, 0.3);
  }

  .avatar-initials {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-term-green, #00ff00);
    text-transform: uppercase;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  /* User Menu Content - Terminal Theme */
  .user-menu-content {
    min-width: 180px;
  }

  .menu-section {
    padding: 12px;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .user-info-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(0, 255, 0, 0.1);
    border: 1px solid var(--color-term-dim-green, #00cc00);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .avatar-initials-large {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-term-green, #00ff00);
    text-transform: uppercase;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .user-info-details {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
  }

  .user-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-term-bright-green, #33ff00);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-email {
    font-size: 11px;
    color: var(--color-term-dim-green, #00cc00);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-info-link {
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s ease;
    border-radius: 4px;
  }

  .user-info-link:hover {
    background: rgba(0, 255, 0, 0.1);
  }

  .user-status {
    font-size: 11px;
    color: var(--color-term-dim-green, #00cc00);
  }

  .menu-divider {
    height: 1px;
    background: var(--color-term-dim-green, #00cc00);
    opacity: 0.3;
    margin: 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: var(--color-term-green, #00ff00);
    font-size: 13px;
    font-family: 'Monaco', 'Courier New', monospace;
    cursor: pointer;
    transition: background 0.15s ease;
    text-align: left;
  }

  .menu-item:hover {
    background: rgba(0, 255, 0, 0.1);
  }

  .menu-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  /* Login Link - Terminal Theme */
  .login-link {
    position: relative;
    background: transparent;
    border: 1px solid var(--color-term-green, #00ff00);
    color: var(--color-term-green, #00ff00);
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-family: 'Monaco', 'Courier New', monospace;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .login-link:hover {
    background: rgba(0, 255, 0, 0.1);
    border-color: var(--color-term-bright-green, #33ff00);
    color: var(--color-term-bright-green, #33ff00);
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .user-login-status.chatgpt .loading-dot {
    background-color: var(--chat-text-muted, #8e8ea0);
  }

  .user-avatar.chatgpt {
    background: var(--chat-primary, #60a5fa);
    border: none;
  }

  .user-avatar.chatgpt:hover {
    box-shadow: 0 2px 8px rgba(96, 165, 250, 0.3);
  }

  .user-avatar.chatgpt .avatar-initials {
    color: #ffffff;
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  /* ChatGPT Theme - User Menu Content */
  .user-menu-content.chatgpt .user-info-avatar {
    background: var(--chat-primary, #60a5fa);
    border: none;
  }

  .user-menu-content.chatgpt .avatar-initials-large {
    color: #ffffff;
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .user-menu-content.chatgpt .user-name {
    color: var(--chat-tooltip-text, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .user-menu-content.chatgpt .user-email,
  .user-menu-content.chatgpt .user-status {
    color: rgba(255, 255, 255, 0.7);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .user-menu-content.chatgpt .user-info-link:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .user-menu-content.chatgpt .menu-divider {
    background: rgba(255, 255, 255, 0.15);
    opacity: 1;
  }

  .user-menu-content.chatgpt .menu-item {
    color: var(--chat-tooltip-text, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    border-radius: 0.375rem;
    margin: 4px;
    width: calc(100% - 8px);
  }

  .user-menu-content.chatgpt .menu-item:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .user-login-status.chatgpt .login-link {
    background: transparent;
    border: none;
    color: var(--chat-primary, #60a5fa);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 0.5rem;
  }

  .user-login-status.chatgpt .login-link:hover {
    background: var(--chat-button-hover, #ececec);
    color: var(--chat-text, #0d0d0d);
  }

  /* Login loading state */
  .login-link.logging-in {
    cursor: pointer;
  }

  .login-link.logging-in:hover {
    background: rgba(255, 0, 0, 0.1);
    border-color: #ff6666;
    color: #ff6666;
  }

  .login-link.logging-in:hover .login-spinner {
    border-color: #ff6666;
    border-top-color: transparent;
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
