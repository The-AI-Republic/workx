<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import {
    userStore,
    userInitials,
    getDesktopLoginPageUrl,
    getLoginPageUrl,
    getDesktopAuthorizeUrl,
    getDesktopTokenUrl,
    hasDesktopOidc,
    DESKTOP_OIDC_CLIENT_ID,
    DESKTOP_OIDC_REDIRECT,
  } from '../../stores/userStore';
  import { uiTheme } from '../../stores/themeStore';
  import { platform } from '../../stores/platformStore';
  import { AUTH_ROUTE_PATHS, HOME_PAGE_BASE_URL, LLM_API_URL, buildHostedAuthUrl } from '../../lib/constants';
  import { generatePKCEChallenge, randomUrlToken } from '@/core/auth/PKCEHelper';
  import Tooltip from './Tooltip.svelte';
  import PopupCard from './PopupCard.svelte';
  import { _t } from '../../lib/i18n';
  import type { RuntimeAuthState } from '@/core/services/runtime-state';

  type DesktopLoginCompletion = {
    success: boolean;
    state?: RuntimeAuthState;
    user?: { name?: string | null; email?: string | null; avatar?: string | null; userType?: number } | null;
  };

  let isLoggingIn = $state(false);
  let cancelLogin: (() => void) | null = $state(null);

  let showMenu = $state(false);
  let showPromoTooltip = $state(false);
  let promoTooltipTimer: ReturnType<typeof setTimeout> | null = null;
  let hasShownPromoTooltip = $state(false);
  const hasHostedAuth = Boolean(HOME_PAGE_BASE_URL && AUTH_ROUTE_PATHS.login);

  // Watch for user state changes to show promo tooltip when not logged in (only once)
  $effect(() => {
    if (hasHostedAuth && !$userStore.isLoading && !$userStore.isLoggedIn && !hasShownPromoTooltip) {
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

  onMount(() => {
    const handleLoginRequest = () => {
      if (platform.platformName !== 'desktop' || isLoggingIn) return;
      void openLoginPage();
    };
    window.addEventListener('workx:request-login', handleLoginRequest);
    return () => window.removeEventListener('workx:request-login', handleLoginRequest);
  });

  onDestroy(() => {
    hidePromoTooltip();
  });

  async function openLoginPage() {
    if (!hasHostedAuth) {
      console.warn('[UserLoginStatus] Hosted auth is not configured');
      return;
    }

    if (platform.platformName === 'desktop') {
      // Desktop mode: open the home-page login in the external browser, await
      // the workx://auth/callback deep link (Rust → WebView event), and let the
      // runtime own credentials. Prefer OIDC + PKCE (authorization code); fall
      // back to the legacy desktop-token flow only when OIDC is unconfigured.
      isLoggingIn = true;
      let isCancelled = false;
      let rejectPending: ((err: Error) => void) | null = null;

      cancelLogin = () => {
        isCancelled = true;
        isLoggingIn = false;
        cancelLogin = null;
        rejectPending?.(new Error('Login cancelled'));
        console.log('[UserLoginStatus] Login cancelled by user');
      };

      try {
        const [{ open }, { listen }, { getInitializedUIClient }] = await Promise.all([
          import('@tauri-apps/plugin-shell'),
          import('@tauri-apps/api/event'),
          import('@/core/messaging'),
        ]);

        // 1. Build the login URL. OIDC requires a PKCE pair + CSRF `state` that
        // we hold in this closure until the callback returns the matching code.
        const useOidc = hasDesktopOidc();
        let codeVerifier = '';
        let expectedState = '';
        let loginUrl: string | null;
        if (useOidc) {
          const pkce = await generatePKCEChallenge();
          codeVerifier = pkce.codeVerifier;
          expectedState = randomUrlToken();
          loginUrl = getDesktopAuthorizeUrl({ codeChallenge: pkce.codeChallenge, state: expectedState });
        } else {
          loginUrl = getDesktopLoginPageUrl();
        }
        if (!loginUrl) throw new Error('Hosted auth is not configured');

        // 2. Subscribe to the workx-deeplink event from Rust before opening the
        // browser. Resolve the parsed callback query params so the OIDC and
        // legacy branches can each read what they need.
        const callbackParams = new Promise<URLSearchParams>((resolve, reject) => {
          let settled = false;
          const timeoutId = setTimeout(() => {
            rejectWithCleanup(new Error('Login timed out'));
          }, 300_000);
          const consumedAuthCallbacks = new Set<string>();

          const resolveWithCleanup = (params: URLSearchParams) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(params);
          };
          const rejectWithCleanup = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            reject(error);
          };
          rejectPending = rejectWithCleanup;

          listen<string>('workx-deeplink', (event) => {
            try {
              const urlObj = new URL(event.payload);
              if (urlObj.host !== 'auth' || urlObj.pathname !== '/callback') {
                return;
              }
              const dedupeKey = urlObj.toString();
              if (consumedAuthCallbacks.has(dedupeKey)) {
                return;
              }
              consumedAuthCallbacks.add(dedupeKey);
              const oauthError = urlObj.searchParams.get('error');
              if (oauthError) {
                rejectWithCleanup(
                  new Error(urlObj.searchParams.get('error_description') ?? oauthError),
                );
                return;
              }
              resolveWithCleanup(urlObj.searchParams);
            } catch (err) {
              rejectWithCleanup(err instanceof Error ? err : new Error(String(err)));
            }
          }).then((unlisten) => {
            // Detach the listener once the promise settles so a later
            // unrelated deeplink does not silently re-trigger login UI.
            callbackParams.finally(() => unlisten()).catch(() => undefined);
          }).catch((err) => {
            rejectWithCleanup(err instanceof Error ? err : new Error(String(err)));
          });
        });
        void callbackParams.catch(() => undefined);

        await open(loginUrl);
        const params = await callbackParams;
        if (isCancelled) return;

        // 3. Hand off to the runtime, which persists tokens in the keychain (via
        // the Rust keychain control-frame bridge), creates a backend-routing
        // AuthManager, and pushes it into every active session's model client.
        const client = await getInitializedUIClient();
        let completion: DesktopLoginCompletion;

        if (useOidc) {
          // OIDC: validate the CSRF `state`, then exchange the code for tokens
          // inside the runtime (public PKCE client — no secret in the WebView).
          const returnedState = params.get('state');
          if (!returnedState || returnedState !== expectedState) {
            throw new Error('Login failed: state mismatch (possible CSRF)');
          }
          const code = params.get('code');
          if (!code) throw new Error('Login failed: missing authorization code');
          const tokenUrl = getDesktopTokenUrl();
          if (!tokenUrl) throw new Error('Hosted auth is not configured');
          completion = await client.serviceRequest<DesktopLoginCompletion>('auth.exchangeOIDCCode', {
            code,
            codeVerifier,
            tokenUrl,
            clientId: DESKTOP_OIDC_CLIENT_ID,
            redirectUri: DESKTOP_OIDC_REDIRECT,
            backendBaseUrl: LLM_API_URL,
          });
        } else {
          // Legacy desktop-token flow: tokens are embedded in the callback URL.
          const accessToken = params.get('access_token');
          const refreshToken = params.get('refresh_token');
          if (!accessToken || !refreshToken) throw new Error('Missing tokens');
          completion = await client.serviceRequest<DesktopLoginCompletion>('auth.completeLogin', {
            accessToken,
            refreshToken,
            backendBaseUrl: LLM_API_URL,
          });
        }
        if (isCancelled) return;

        // 4. Update the UI userStore from the runtime response. Desktop
        // profile lookup belongs to the runtime; the WebView does not retry
        // profile calls with raw tokens after login.
        const profile = completion?.state?.profile ?? completion?.user ?? null;
        if (profile) {
          userStore.setUser({
            name: profile.name ?? null,
            email: profile.email,
            avatar: profile.avatar ?? null,
            userType: profile.userType ?? 0,
          });
        } else {
          // The runtime has accepted and stored the token. Keep the desktop UI
          // in logged-in state even if the profile endpoint is unavailable.
          userStore.setUser({ name: null, email: null, avatar: null, userType: 0 });
        }
        console.log('[UserLoginStatus] Desktop auth completed via runtime');
      } catch (error) {
        if (!isCancelled) {
          console.error('[UserLoginStatus] Desktop login failed:', error);
        }
        rejectPending?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (!isCancelled) {
          isLoggingIn = false;
          cancelLogin = null;
        }
        rejectPending = null;
      }
    } else if (platform.platformName === 'web') {
      // Web mode: popup OAuth flow via WebAuthService
      isLoggingIn = true;

      let isCancelled = false;
      cancelLogin = () => {
        isCancelled = true;
        isLoggingIn = false;
        cancelLogin = null;
        webAuthService?.cancelLogin();
        console.log('[UserLoginStatus] Web login cancelled by user');
      };

      let webAuthService: Awaited<ReturnType<typeof import('../../auth/WebAuthService').getWebAuthService>> | null = null;
      try {
        const { getWebAuthService } = await import('../../auth/WebAuthService');
        webAuthService = getWebAuthService(HOME_PAGE_BASE_URL);
        const session = await webAuthService.login();

        if (isCancelled) return;

        const accessToken = await webAuthService.getAccessToken();
        const profile = accessToken ? await fetchUserProfile(accessToken) : null;

        if (profile) {
          userStore.setUser({
            name: profile.name || session.given_name || session.name || null,
            email: profile.email || session.email,
            avatar: profile.avatar || session.picture || null,
            userType: profile.userType,
          });
        } else {
          userStore.setUser({
            name: session.given_name || session.name || null,
            email: session.email,
            avatar: session.picture || null,
            userType: (session.subscription as any)?.plan_id ?? 0,
          });
        }
        console.log('[UserLoginStatus] Web login successful for:', session.email);
      } catch (error) {
        if (!isCancelled) {
          console.error('[UserLoginStatus] Web login failed:', error);
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
      if (loginUrl) chrome.tabs.create({ url: loginUrl });
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

  function openUsage() {
    showMenu = false;
    push('/usage');
  }

  function openSettings() {
    showMenu = false;
    push('/settings');
  }

  async function handleLogout() {
    showMenu = false;
    try {
      if (platform.platformName === 'desktop') {
        // Desktop: the session token lives in the runtime keychain, so logout
        // must go through the runtime `auth.logout` service — it evicts the
        // tokens from the vault and flips the runtime auth state to logged-out.
        // (WebAuthService.logout only clears webfront localStorage, which is why
        // the button was previously hidden on desktop and logout did nothing.)
        const { getInitializedUIClient } = await import('@/core/messaging');
        await (await getInitializedUIClient()).serviceRequest('auth.logout');
      } else {
        const { getWebAuthService } = await import('../../auth/WebAuthService');
        await getWebAuthService().logout();
      }
    } catch (error) {
      console.warn('[UserLoginStatus] Logout error:', error);
    }
    userStore.setNotLoggedIn();
  }

  async function openUserCenter(event: MouseEvent) {
    event.preventDefault();
    showMenu = false;
    const userCenterUrl = buildHostedAuthUrl(AUTH_ROUTE_PATHS.userCenter);
    if (!userCenterUrl) return;

    if (platform.platformName === 'desktop') {
      // Desktop mode: use Tauri shell plugin to open in browser
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(userCenterUrl);
    } else if (platform.platformName === 'web') {
      window.open(userCenterUrl, '_blank');
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
          href={buildHostedAuthUrl(AUTH_ROUTE_PATHS.userCenter) ?? undefined}
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
          onclick={openUsage}
          role="menuitem"
        >
          <svg class="w-[18px] h-[18px] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <rect x="3" y="12" width="4" height="9" rx="1"></rect>
            <rect x="10" y="7" width="4" height="14" rx="1"></rect>
            <rect x="17" y="3" width="4" height="18" rx="1"></rect>
          </svg>
          <span>{$_t("Usage")}</span>
        </button>

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

        <button
          class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none cursor-pointer text-sm text-left transition-colors duration-150
            {$uiTheme === 'modern'
              ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat rounded-md m-1 w-[calc(100%-8px)] hover:bg-white/10'
              : 'text-term-green font-terminal hover:bg-term-green/10'}"
          onclick={handleLogout}
          role="menuitem"
        >
          <svg class="w-[18px] h-[18px] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span>{$_t("Logout")}</span>
        </button>
      </div>{/snippet}
    </PopupCard>
  {:else if hasHostedAuth}
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
