/**
 * Background cleanup for expired rollouts
 * Uses Chrome alarms API to periodically clean up expired rollouts
 */

import { RolloutRecorder } from '@/storage/rollout';

// ============================================================================
// Constants
// ============================================================================

const CLEANUP_ALARM_NAME = 'rollout-cleanup';
const CLEANUP_INTERVAL_MINUTES = 60; // Run cleanup every hour

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize rollout cleanup alarm on extension install/update.
 * Should be called from background service worker.
 */
export function initializeRolloutCleanup(): void {
  // Listen for extension installation/update
  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[Rollout Cleanup] Extension event:', details.reason);

    // Create periodic cleanup alarm
    await createCleanupAlarm();

    // Run cleanup immediately on install
    if (details.reason === 'install' || details.reason === 'update') {
      console.log('[Rollout Cleanup] Running initial cleanup...');
      await runCleanup();
    }
  });

  // Listen for alarm events
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === CLEANUP_ALARM_NAME) {
      console.log('[Rollout Cleanup] Alarm triggered, running cleanup...');
      await runCleanup();
    }
  });
}

// ============================================================================
// Alarm Management
// ============================================================================

/**
 * Create periodic cleanup alarm.
 */
async function createCleanupAlarm(): Promise<void> {
  // Clear existing alarm if any
  await chrome.alarms.clear(CLEANUP_ALARM_NAME);

  // Create new alarm
  await chrome.alarms.create(CLEANUP_ALARM_NAME, {
    delayInMinutes: CLEANUP_INTERVAL_MINUTES,
    periodInMinutes: CLEANUP_INTERVAL_MINUTES,
  });

  console.log(`[Rollout Cleanup] Alarm created: runs every ${CLEANUP_INTERVAL_MINUTES} minutes`);
}

/**
 * Get cleanup alarm status (for debugging/monitoring).
 */
export async function getCleanupAlarmStatus(): Promise<{
  exists: boolean;
  scheduledTime?: number;
  periodInMinutes?: number;
}> {
  const alarm = await chrome.alarms.get(CLEANUP_ALARM_NAME);

  if (!alarm) {
    return { exists: false };
  }

  return {
    exists: true,
    scheduledTime: alarm.scheduledTime,
    periodInMinutes: alarm.periodInMinutes,
  };
}

// ============================================================================
// Cleanup Execution
// ============================================================================

/**
 * Run rollout cleanup and log results.
 */
async function runCleanup(): Promise<void> {
  try {
    const startTime = Date.now();
    const deletedCount = await RolloutRecorder.cleanupExpired();
    const duration = Date.now() - startTime;

    console.log(`[Rollout Cleanup] Cleanup completed in ${duration}ms`);
    console.log(`[Rollout Cleanup] Deleted ${deletedCount} expired rollout(s)`);

    // Log to storage (optional, for monitoring)
    await logCleanupResult({
      timestamp: Date.now(),
      deletedCount,
      duration,
      success: true,
    });
  } catch (error) {
    console.error('[Rollout Cleanup] Cleanup failed:', error);

    await logCleanupResult({
      timestamp: Date.now(),
      deletedCount: 0,
      duration: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Manually trigger cleanup (for testing/debugging).
 */
export async function manualCleanup(): Promise<{
  deletedCount: number;
  duration: number;
  success: boolean;
  error?: string;
}> {
  try {
    const startTime = Date.now();
    const deletedCount = await RolloutRecorder.cleanupExpired();
    const duration = Date.now() - startTime;

    return {
      deletedCount,
      duration,
      success: true,
    };
  } catch (error) {
    return {
      deletedCount: 0,
      duration: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Logging
// ============================================================================

interface CleanupResult {
  timestamp: number;
  deletedCount: number;
  duration: number;
  success: boolean;
  error?: string;
}

const MAX_CLEANUP_LOGS = 50; // Keep last 50 cleanup results

/**
 * Log cleanup result to Chrome storage for monitoring.
 */
async function logCleanupResult(result: CleanupResult): Promise<void> {
  try {
    // Get existing logs
    const stored = await chrome.storage.local.get('rollout_cleanup_logs');
    const logs: CleanupResult[] = stored.rollout_cleanup_logs || [];

    // Add new log
    logs.push(result);

    // Trim to max size
    if (logs.length > MAX_CLEANUP_LOGS) {
      logs.splice(0, logs.length - MAX_CLEANUP_LOGS);
    }

    // Save back
    await chrome.storage.local.set({ rollout_cleanup_logs: logs });
  } catch (error) {
    console.error('[Rollout Cleanup] Failed to log result:', error);
  }
}

/**
 * Get cleanup logs (for monitoring/debugging).
 */
export async function getCleanupLogs(): Promise<CleanupResult[]> {
  try {
    const stored = await chrome.storage.local.get('rollout_cleanup_logs');
    return stored.rollout_cleanup_logs || [];
  } catch (error) {
    console.error('[Rollout Cleanup] Failed to get logs:', error);
    return [];
  }
}

/**
 * Clear cleanup logs.
 */
export async function clearCleanupLogs(): Promise<void> {
  await chrome.storage.local.remove('rollout_cleanup_logs');
}
