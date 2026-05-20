/**
 * Runtime-side ChatGPT OAuth login coordinator.
 *
 * Owns the local HTTP callback server on 127.0.0.1:1455 inside the runtime
 * process. Replaces the old `start_oauth_callback_server` Tauri command and
 * `ChatGPTOAuthDesktopFlow` WebView coordinator.
 *
 * Contract:
 *   - The UI initiates login by calling the `auth.chatgpt.startLogin` runtime
 *     service. The runtime returns an authorization URL that the UI then
 *     opens in the user's default browser via Tauri's shell plugin.
 *   - The runtime concurrently binds a single-request HTTP listener on
 *     127.0.0.1:1455 to receive the OAuth callback. The listener self-closes
 *     after the first matching callback, on timeout, or on cancellation.
 *   - On success, tokens are persisted to the runtime credential store
 *     (keychain on desktop). The UI is notified via the service-request
 *     response; no token ever crosses IPC.
 */

import { createServer, type Server } from 'node:http';
import { URL as NodeURL } from 'node:url';
import { ChatGPTOAuthService, type ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';
import type { ChatGPTOAuthStorage } from '@/core/auth/ChatGPTOAuthService';

interface PendingLogin {
  resolve: (tokens: ChatGPTTokens) => void;
  reject: (error: Error) => void;
  state: string;
  codeVerifier: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
}

/** Hardcoded; OpenAI's PKCE redirect URI for this client. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class RuntimeChatGPTOAuthFlow {
  private current: PendingLogin | null = null;

  constructor(private readonly storage: ChatGPTOAuthStorage) {}

  get loginInProgress(): boolean {
    return this.current !== null;
  }

  /**
   * Build the auth URL and start the callback listener. Returns the URL the
   * UI should open in the browser. Throws on port-in-use, etc.
   */
  async beginLogin(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<{ authUrl: string }> {
    if (this.current) {
      throw new Error('ChatGPT OAuth login already in progress');
    }
    const service = new ChatGPTOAuthService(this.storage);
    const { codeVerifier, codeChallenge } = await service.generatePKCEChallenge();
    const state = crypto.randomUUID();
    const authUrl = service.buildAuthorizationUrl(state, codeChallenge);

    let pending!: PendingLogin;
    const completion = new Promise<ChatGPTTokens>((resolve, reject) => {
      pending = { resolve, reject } as unknown as PendingLogin;
    });

    const server = createServer((req, res) => {
      try {
        if (!req.url) {
          res.writeHead(400).end('Bad Request');
          return;
        }
        const url = new NodeURL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end('Not Found');
          return;
        }
        const code = url.searchParams.get('code');
        const respState = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(
            `<html><body><h3>Login failed</h3><p>${escapeHtml(error)}</p>You can close this window.</body></html>`,
          );
          pending.reject(new Error(`OAuth provider error: ${error}`));
          this.cleanup();
          return;
        }
        if (!code || respState !== state) {
          res.writeHead(400).end('Invalid OAuth callback');
          pending.reject(new Error('OAuth callback missing code or state mismatch'));
          this.cleanup();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<html><body><h3>Logged in</h3>You can close this window and return to the app.</body></html>',
        );

        service
          .exchangeCodeForTokens(code, codeVerifier)
          .then((tokens) => {
            pending.resolve(tokens);
            this.cleanup();
          })
          .catch((err) => {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
            this.cleanup();
          });
      } catch (err) {
        try {
          res.writeHead(500).end('Internal Server Error');
        } catch {
          /* response may already be closed */
        }
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        this.cleanup();
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        pending.reject(
          new Error(
            `Failed to bind port ${CALLBACK_PORT}: another app is using it. Close it and retry.`,
          ),
        );
      } else {
        pending.reject(err);
      }
      this.cleanup();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve());
    });

    pending = {
      ...pending,
      state,
      codeVerifier,
      server,
      timer: setTimeout(() => {
        pending.reject(new Error('ChatGPT OAuth login timed out'));
        this.cleanup();
      }, timeoutMs),
    };
    this.current = pending;

    // Detach the completion promise so callers can await it via `finishLogin`.
    this.completionPromise = completion;

    return { authUrl };
  }

  private completionPromise: Promise<ChatGPTTokens> | null = null;

  /**
   * Wait for the currently in-progress login to complete; resolves with the
   * tokens (already persisted) or rejects on error/timeout/cancellation.
   * Called by the runtime service handler immediately after `beginLogin`.
   */
  async waitForCompletion(): Promise<ChatGPTTokens> {
    if (!this.completionPromise) {
      throw new Error('No ChatGPT OAuth login in progress');
    }
    return this.completionPromise;
  }

  /**
   * Abort any in-progress login. Safe to call when none is running.
   */
  cancel(reason = 'cancelled'): void {
    if (!this.current) return;
    this.current.reject(new Error(`ChatGPT OAuth ${reason}`));
    this.cleanup();
  }

  private cleanup(): void {
    if (!this.current) return;
    clearTimeout(this.current.timer);
    this.current.server.close(() => undefined);
    this.current = null;
    this.completionPromise = null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
