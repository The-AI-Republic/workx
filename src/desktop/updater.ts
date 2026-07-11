/**
 * Auto-Updater Service
 *
 * Checks for application updates via GitHub Releases and handles
 * downloading, installing, and relaunching the app.
 * Uses Tauri's updater plugin with the configured endpoint.
 *
 * @module desktop/updater
 */

// @ts-ignore - Tauri plugin, types may not be available in all build modes
import { check, type Update } from '@tauri-apps/plugin-updater';
// @ts-ignore - Tauri plugin, types may not be available in all build modes
import { relaunch } from '@tauri-apps/plugin-process';

let pendingUpdate: Update | null = null;

/**
 * Check for available updates.
 * Stores the pending update for later download/install.
 *
 * @returns The update object if an update is available, null otherwise
 */
export async function checkForUpdate(): Promise<Update | null> {
  const update = await check();
  if (update) {
    console.log(`[Updater] Update available: v${update.version}`);
    pendingUpdate = update;
    return update;
  }
  console.log('[Updater] App is up to date');
  pendingUpdate = null;
  return null;
}

/**
 * Download and install a pending update, then relaunch the app.
 *
 * @param onProgress - Optional callback for download progress (bytes downloaded, total bytes)
 */
export async function downloadAndInstall(
  onProgress?: (downloaded: number, total: number | undefined) => void
): Promise<void> {
  if (!pendingUpdate) {
    console.warn('[Updater] No pending update to install');
    return;
  }

  let downloaded = 0;
  let contentLength: number | undefined;

  await pendingUpdate.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength;
        console.log(`[Updater] Download started (${contentLength ?? 'unknown'} bytes)`);
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, contentLength);
        break;
      case 'Finished':
        console.log('[Updater] Download finished, installing...');
        break;
    }
  });

  console.log('[Updater] Update installed, relaunching...');
  await relaunch();
}

/**
 * Initialize the updater: check once on launch, then periodically.
 *
 * @param intervalMinutes - How often to check for updates (default: 60 minutes)
 */
export async function initializeUpdater(intervalMinutes = 60): Promise<void> {
  // Initial check, deferred and non-blocking. `check()` is a network round-trip
  // to the updater endpoint; running it inline used to sit on the cold-start
  // critical path (it was awaited before the UI mounted). Fire it a few seconds
  // after launch instead, once first paint and the sidecar handshake are done.
  setTimeout(() => {
    checkForUpdate()
      .then((update) => {
        if (update) {
          console.log(`[Updater] Update v${update.version} is available — will prompt user in a future release`);
        }
      })
      .catch((error) => {
        console.warn('[Updater] Initial update check failed:', error);
      });
  }, 5000);

  // Periodic checks
  setInterval(async () => {
    try {
      await checkForUpdate();
    } catch (error) {
      console.warn('[Updater] Periodic update check failed:', error);
    }
  }, intervalMinutes * 60 * 1000);
}
