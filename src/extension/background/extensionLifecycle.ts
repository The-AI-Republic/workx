/**
 * Extension lifecycle hardening (design §3.10).
 *
 * - `getExtensionInstanceId` (T28): a stable per-install UUID for telemetry /
 *   disambiguating multiple Chrome profiles.
 * - `DeferredReload` (T27): when an extension update is pending, defer
 *   `chrome.runtime.reload()` until no agent session is active, so an in-flight
 *   turn isn't killed by a restart.
 *
 * @module extension/background/extensionLifecycle
 */

const INSTANCE_ID_KEY = 'workx:extension_instance_id';

export async function getExtensionInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTANCE_ID_KEY);
  const existing = stored[INSTANCE_ID_KEY] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_ID_KEY]: id });
  return id;
}

/**
 * Defers reload-on-update until a predicate reports no active session. Wire
 * `register()` to `chrome.runtime.onUpdateAvailable`, and call `onSessionEnded()`
 * whenever a session finishes so a pending reload can fire.
 */
export class DeferredReload {
  private pending = false;

  constructor(
    private readonly isSessionActive: () => boolean,
    private readonly reload: () => void = () => chrome.runtime.reload()
  ) {}

  register(): void {
    chrome.runtime?.onUpdateAvailable?.addListener(() => {
      this.pending = true;
      this.maybeReload();
    });
  }

  /** Call when a session ends; reloads now if an update is pending and idle. */
  onSessionEnded(): void {
    this.maybeReload();
  }

  private maybeReload(): void {
    if (this.pending && !this.isSessionActive()) {
      this.reload();
    }
  }
}
