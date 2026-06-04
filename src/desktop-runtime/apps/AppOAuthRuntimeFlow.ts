import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { URL as NodeURL } from 'node:url';
import { AppLocalStore } from '@/core/apps/AppLocalStore';
import { AppCredentialStore } from '@/core/apps/credentials/AppCredentialStore';
import { AppOAuthService } from '@/core/apps/auth/AppOAuthService';

interface OAuthCallbackResult {
  code: string;
  state: string;
}

interface CallbackListener {
  promise: Promise<OAuthCallbackResult>;
  close: () => void;
}

const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class AppOAuthRuntimeFlow {
  private readonly oauth: AppOAuthService;
  private inProgress = new Set<string>();

  constructor(
    private readonly store: AppLocalStore = new AppLocalStore(),
    credentials: AppCredentialStore = new AppCredentialStore(),
  ) {
    this.oauth = new AppOAuthService(credentials);
  }

  async connect(appId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<{ status: 'connected'; appId: string }> {
    if (this.inProgress.has(appId)) {
      throw new Error('App account connection already in progress');
    }
    this.inProgress.add(appId);

    try {
      const manifest = await this.store.getManifest(appId);
      if (!manifest) {
        throw new Error('Installed app metadata is missing. Sync or reinstall the app first.');
      }
      if (manifest.auth?.type !== 'oauth2') {
        throw new Error('This app does not use OAuth account connection.');
      }

      const { codeVerifier, codeChallenge } = await this.oauth.generatePKCEChallenge();
      const state = crypto.randomUUID();
      const authUrl = await this.oauth.prepareAuthorizationUrl(manifest, state, codeChallenge);
      const listener = await this.startCallbackListener(manifest.auth.redirectUri ?? DEFAULT_REDIRECT_URI, state, timeoutMs);

      try {
        await openExternalUrl(authUrl);
        const callback = await listener.promise;
        if (callback.state !== state) {
          throw new Error('OAuth state mismatch');
        }

        await this.oauth.exchangeCodeForTokens(manifest, callback.code, codeVerifier);
        await this.store.patchInstalledApp(appId, {
          connectionStatus: 'ready',
          lastError: undefined,
        });
        return { status: 'connected', appId };
      } finally {
        listener.close();
      }
    } catch (error) {
      await this.store.patchInstalledApp(appId, {
        connectionStatus: 'auth_error',
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.inProgress.delete(appId);
    }
  }

  private async startCallbackListener(redirectUri: string, state: string, timeoutMs: number): Promise<CallbackListener> {
    const callbackUrl = new NodeURL(redirectUri);
    if (callbackUrl.protocol !== 'http:') {
      throw new Error('App OAuth redirect URI must use http://localhost');
    }
    if (callbackUrl.hostname !== 'localhost' && callbackUrl.hostname !== '127.0.0.1') {
      throw new Error('App OAuth redirect URI must target localhost');
    }
    const port = Number(callbackUrl.port || '80');
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid OAuth callback port: ${callbackUrl.port}`);
    }
    const listenHost = callbackUrl.hostname === 'localhost' ? '127.0.0.1' : callbackUrl.hostname;

    let server: Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const close = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (server) {
        server.close(() => undefined);
        server = null;
      }
    };

    const promise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      server = createServer((req, res) => {
        try {
          if (!req.url) {
            res.writeHead(400).end('Bad Request');
            return;
          }

          const url = new NodeURL(req.url, callbackUrl.origin);
          if (url.pathname !== callbackUrl.pathname) {
            res.writeHead(404).end('Not Found');
            return;
          }

          const error = url.searchParams.get('error');
          if (error) {
            settled = true;
            res.writeHead(400, { 'Content-Type': 'text/html' }).end(
              `<html><body><h3>Connection failed</h3><p>${escapeHtml(error)}</p>You can close this window.</body></html>`,
            );
            reject(new Error(`OAuth provider error: ${error}`));
            close();
            return;
          }

          const code = url.searchParams.get('code');
          const respState = url.searchParams.get('state');
          if (!code || respState !== state) {
            settled = true;
            res.writeHead(400).end('Invalid OAuth callback');
            reject(new Error('OAuth callback missing code or state mismatch'));
            close();
            return;
          }

          settled = true;
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            '<html><body><h3>Connected</h3>You can close this window and return to the app.</body></html>',
          );
          resolve({ code, state: respState });
          close();
        } catch (error) {
          settled = true;
          try {
            res.writeHead(500).end('Internal Server Error');
          } catch {
            /* response may already be closed */
          }
          reject(error instanceof Error ? error : new Error(String(error)));
          close();
        }
      });

      server.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        const message = error.code === 'EADDRINUSE'
          ? `Failed to bind OAuth callback port ${port}: another app is using it.`
          : error.message;
        reject(new Error(message));
        close();
      });

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('App OAuth connection timed out'));
        close();
      }, timeoutMs);
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, listenHost, () => resolve());
    });

    return { promise, close };
  }
}

async function openExternalUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'rundll32'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['url.dll,FileProtocolHandler', url]
    : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', resolve);
    child.unref();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
