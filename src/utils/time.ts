/**
 * Timer utilities for pause mechanism in Chrome extension service worker context
 *
 * Chrome service workers can hibernate during long pauses, so we use a hybrid approach:
 * - setTimeout for pauses <60s (reliable in active service worker)
 * - chrome.alarms for pauses >=60s (persists across hibernation)
 *
 * @module time
 * @since 1.0.0
 */

/**
 * Result from creating a pause timer
 *
 * @interface PauseTimerResult
 * @property {number | string} timerId - Timer identifier (number for setTimeout, string for chrome.alarms)
 * @property {() => Promise<void>} cancel - Function to cancel the timer and prevent callback execution
 */
export interface PauseTimerResult {
  /** Timer identifier (number for setTimeout, string for chrome.alarms) */
  timerId: number | string;
  /** Function to cancel the timer */
  cancel: () => Promise<void>;
}

/**
 * PauseTimer provides reliable pause/resume functionality in service worker context
 *
 * This class handles the complexity of Chrome service worker hibernation by automatically
 * choosing the appropriate timer mechanism based on pause duration:
 *
 * - **Short pauses (<60s)**: Uses `setTimeout` for accuracy and simplicity
 * - **Long pauses (>=60s)**: Uses `chrome.alarms` which persist across hibernation
 *
 * @example
 * ```typescript
 * // Pause for 30 seconds (uses setTimeout)
 * const shortPause = await PauseTimer.delay(30000, () => {
 *   console.log('Short pause complete');
 * });
 *
 * // Pause for 5 minutes (uses chrome.alarms)
 * const longPause = await PauseTimer.delay(300000, () => {
 *   console.log('Long pause complete, survived hibernation');
 * });
 *
 * // Cancel a pause early
 * await shortPause.cancel();
 * ```
 *
 * @class PauseTimer
 * @since 1.0.0
 */
export class PauseTimer {
  /**
   * Create a pause timer that works in service worker context
   *
   * Automatically selects the appropriate timer mechanism based on duration:
   * - Pauses <60 seconds use setTimeout
   * - Pauses >=60 seconds use chrome.alarms (survives hibernation)
   *
   * @param {number} durationMs - Pause duration in milliseconds (must be positive)
   * @param {() => void} onResume - Callback to invoke when pause completes
   * @returns {Promise<PauseTimerResult>} Promise resolving to timer handle with cancel function
   *
   * @throws {Error} If chrome.alarms API is not available for long pauses
   *
   * @example
   * ```typescript
   * // Short pause example
   * const timer = await PauseTimer.delay(5000, () => {
   *   console.log('Resumed after 5 seconds');
   * });
   *
   * // Cancel if needed
   * await timer.cancel();
   * ```
   */
  static async delay(
    durationMs: number,
    onResume: () => void
  ): Promise<PauseTimerResult> {
    if (durationMs < 60000) {
      // Short pause: use setTimeout (works fine for <1 min)
      const timerId = setTimeout(onResume, durationMs) as unknown as number;

      return {
        timerId,
        cancel: async () => clearTimeout(timerId),
      };
    } else {
      // Long pause: use chrome.alarms for persistence across service worker hibernation
      const alarmName = `pause-resume-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Create alarm
      await chrome.alarms.create(alarmName, { delayInMinutes: durationMs / 60000 });

      // Register listener
      const listener = (alarm: chrome.alarms.Alarm) => {
        if (alarm.name === alarmName) {
          chrome.alarms.onAlarm.removeListener(listener);
          onResume();
        }
      };
      chrome.alarms.onAlarm.addListener(listener);

      return {
        timerId: alarmName,
        cancel: async () => {
          chrome.alarms.onAlarm.removeListener(listener);
          await chrome.alarms.clear(alarmName);
        },
      };
    }
  }
}
