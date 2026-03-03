/**
 * Desktop Scheduler Deep Link Handler
 *
 * Handles incoming `airepublic-pi://scheduler/trigger?taskId=xxx` deep links
 * that fire when an OS-level scheduled job activates.
 *
 * Listens on the existing `auth-callback` Tauri event (reuses current
 * deep-link infrastructure — no Rust changes needed).
 *
 * @module desktop/scheduler/DesktopSchedulerDeepLinkHandler
 */

import type { Scheduler } from '../../core/scheduler/Scheduler';
import { getTaskAlarmName } from '../../core/models/types/SchedulerContracts';

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
      // Parse the URL — handle both `airepublic-pi://scheduler/trigger` formats
      // The URL may come as `airepublic-pi://scheduler/trigger?taskId=xxx`
      // or just the path portion depending on the platform
      if (!url.includes('scheduler/trigger')) {
        return; // Not a scheduler URL — let auth handler process it
      }

      // Extract taskId from query params
      const urlObj = new URL(url);
      const taskId = urlObj.searchParams.get('taskId');

      if (!taskId) {
        console.warn('[DesktopSchedulerDeepLinkHandler] Missing taskId in deep link:', url);
        return;
      }

      console.log(`[DesktopSchedulerDeepLinkHandler] Received trigger for task ${taskId}`);

      // Trigger the alarm handler
      const alarmName = getTaskAlarmName(taskId);
      this.scheduler.handleAlarm(alarmName).catch((error) => {
        console.error(`[DesktopSchedulerDeepLinkHandler] Failed to handle alarm for task ${taskId}:`, error);
      });

      // Clean up the OS job (it already fired)
      this.removeOsJob(taskId);
    } catch (error) {
      console.error('[DesktopSchedulerDeepLinkHandler] Error processing deep link:', error);
    }
  }

  /**
   * Remove the OS-level job after it fires (no longer needed).
   */
  private async removeOsJob(taskId: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('scheduler_remove_os_job', { taskId });
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
