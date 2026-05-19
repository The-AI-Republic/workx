/**
 * Desktop Scheduler Deep Link Handler
 *
 * Handles incoming `applepi://scheduler/trigger?jobId=xxx` deep links
 * that fire when an OS-level scheduled job activates.
 *
 * Listens on the existing `auth-callback` Tauri event (reuses current
 * deep-link infrastructure — no Rust changes needed).
 *
 * @module desktop/scheduler/DesktopSchedulerDeepLinkHandler
 */

import type { Scheduler } from '../../core/scheduler/Scheduler';
import { getJobAlarmName } from '../../core/models/types/SchedulerContracts';

export class DesktopSchedulerDeepLinkHandler {
  private unlisten: (() => void) | null = null;

  constructor(private scheduler: Scheduler) {}

  /**
   * Start listening for scheduler deep link events.
   */
  async initialize(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');

      this.unlisten = await listen<string>('auth-callback', (event) => {
        const url = event.payload;
        this.handleDeepLink(url);
      });

      console.log('[DesktopSchedulerDeepLinkHandler] Listening for scheduler deep links');
    } catch (error) {
      console.warn('[DesktopSchedulerDeepLinkHandler] Failed to initialize:', error);
    }
  }

  /**
   * Handle a deep link URL.
   * Only processes scheduler trigger URLs, ignores auth callbacks.
   */
  private handleDeepLink(url: string): void {
    try {
      // Parse the URL — expected format: `applepi://scheduler/trigger?jobId=xxx`
      const urlObj = new URL(url);

      // Match on hostname + pathname for proper URL path matching
      // URL parses `applepi://scheduler/trigger` as host="scheduler", pathname="/trigger"
      const isSchedulerTrigger =
        urlObj.hostname === 'scheduler' && urlObj.pathname === '/trigger';

      if (!isSchedulerTrigger) {
        return; // Not a scheduler URL — let auth handler process it
      }

      // Extract jobId from query params
      const jobId = urlObj.searchParams.get('jobId');

      if (!jobId) {
        console.warn('[DesktopSchedulerDeepLinkHandler] Missing jobId in deep link:', url);
        return;
      }

      console.log(`[DesktopSchedulerDeepLinkHandler] Received trigger for job ${jobId}`);

      // Trigger the alarm handler, then clean up the OS job after it succeeds
      const alarmName = getJobAlarmName(jobId);
      this.scheduler.handleAlarm(alarmName)
        .then(() => this.removeOsJob(jobId))
        .catch((error) => {
          console.error(`[DesktopSchedulerDeepLinkHandler] Failed to handle alarm for job ${jobId}:`, error);
        });
    } catch (error) {
      console.error('[DesktopSchedulerDeepLinkHandler] Error processing deep link:', error);
    }
  }

  /**
   * Remove the OS-level job after it fires (no longer needed).
   */
  private async removeOsJob(jobId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('scheduler_remove_os_job', { jobId });
    } catch (error) {
      console.warn('[DesktopSchedulerDeepLinkHandler] Failed to remove OS job:', error);
    }
  }

  /**
   * Stop listening for deep link events.
   */
  dispose(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }
}
