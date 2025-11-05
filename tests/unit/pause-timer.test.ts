/**
 * Unit tests for PauseTimer utility
 * T013-T014: Test short (<60s) and long (>=60s) pause implementations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PauseTimer } from '../../src/utils/time';

describe('PauseTimer.delay() - short pauses (<60s)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use setTimeout for pauses less than 60 seconds', async () => {
    const onResume = vi.fn();
    const pauseDuration = 30000; // 30 seconds

    const resultPromise = PauseTimer.delay(pauseDuration, onResume);

    // Fast-forward time
    await vi.advanceTimersByTimeAsync(pauseDuration);

    const result = await resultPromise;

    expect(onResume).toHaveBeenCalledOnce();
    expect(result.timerId).toBeDefined();
    // In Node.js test environment, setTimeout returns a Timeout object, not a number
    // The important thing is that it's defined and can be used with clearTimeout
    expect(result.timerId).toBeTruthy();
  });

  it('should call onResume callback after the specified duration', async () => {
    const onResume = vi.fn();
    const pauseDuration = 5000; // 5 seconds

    const resultPromise = PauseTimer.delay(pauseDuration, onResume);

    // Verify callback not called yet
    expect(onResume).not.toHaveBeenCalled();

    // Fast-forward to just before completion
    await vi.advanceTimersByTimeAsync(4999);
    expect(onResume).not.toHaveBeenCalled();

    // Complete the timer
    await vi.advanceTimersByTimeAsync(1);
    await resultPromise;

    expect(onResume).toHaveBeenCalledOnce();
  });

  it('should provide a cancel function that clears the timeout', async () => {
    const onResume = vi.fn();
    const pauseDuration = 10000; // 10 seconds

    const result = await PauseTimer.delay(pauseDuration, onResume);

    // Cancel the timer
    await result.cancel();

    // Fast-forward past the original duration
    await vi.advanceTimersByTimeAsync(pauseDuration + 1000);

    // Callback should not have been called
    expect(onResume).not.toHaveBeenCalled();
  });

  it('should handle minimum pause duration (1 second)', async () => {
    const onResume = vi.fn();
    const pauseDuration = 1000; // 1 second

    const resultPromise = PauseTimer.delay(pauseDuration, onResume);

    await vi.advanceTimersByTimeAsync(pauseDuration);
    await resultPromise;

    expect(onResume).toHaveBeenCalledOnce();
  });

  it('should handle pause at the boundary (59999ms)', async () => {
    const onResume = vi.fn();
    const pauseDuration = 59999; // Just under 60 seconds

    const resultPromise = PauseTimer.delay(pauseDuration, onResume);

    await vi.advanceTimersByTimeAsync(pauseDuration);
    await resultPromise;

    expect(onResume).toHaveBeenCalledOnce();
  });
});

describe('PauseTimer.delay() - long pauses (>=60s)', () => {
  let mockChrome: any;

  beforeEach(() => {
    // Mock chrome.alarms API
    mockChrome = {
      alarms: {
        create: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(true),
        onAlarm: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        }
      }
    };
    (global as any).chrome = mockChrome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (global as any).chrome;
  });

  it('should use chrome.alarms for pauses of 60 seconds or more', async () => {
    const onResume = vi.fn();
    const pauseDuration = 60000; // 60 seconds exactly

    const result = await PauseTimer.delay(pauseDuration, onResume);

    expect(mockChrome.alarms.create).toHaveBeenCalledWith(
      expect.stringMatching(/^pause-resume-/),
      { delayInMinutes: 1 }
    );
    expect(mockChrome.alarms.onAlarm.addListener).toHaveBeenCalled();

    // Simulate alarm firing
    const listener = mockChrome.alarms.onAlarm.addListener.mock.calls[0][0];
    const alarmName = mockChrome.alarms.create.mock.calls[0][0];
    listener({ name: alarmName });

    expect(onResume).toHaveBeenCalledOnce();
  });

  it('should convert milliseconds to minutes for chrome.alarms', async () => {
    const onResume = vi.fn();
    const pauseDuration = 120000; // 2 minutes (120 seconds)

    await PauseTimer.delay(pauseDuration, onResume);

    expect(mockChrome.alarms.create).toHaveBeenCalledWith(
      expect.stringMatching(/^pause-resume-/),
      { delayInMinutes: 2 }
    );
  });

  it('should provide a cancel function that clears the alarm', async () => {
    const onResume = vi.fn();
    const pauseDuration = 120000; // 2 minutes

    const result = await PauseTimer.delay(pauseDuration, onResume);
    const alarmName = mockChrome.alarms.create.mock.calls[0][0];

    // Cancel the alarm
    await result.cancel();

    expect(mockChrome.alarms.clear).toHaveBeenCalledWith(alarmName);
  });

  it('should generate unique alarm names', async () => {
    const onResume1 = vi.fn();
    const onResume2 = vi.fn();

    await PauseTimer.delay(60000, onResume1);
    await PauseTimer.delay(60000, onResume2);

    const calls = mockChrome.alarms.create.mock.calls;
    const name1 = calls[0][0];
    const name2 = calls[1][0];

    expect(name1).not.toBe(name2);
    expect(name1).toMatch(/^pause-resume-\d+-[a-z0-9]+$/);
    expect(name2).toMatch(/^pause-resume-\d+-[a-z0-9]+$/);
  });

  it('should handle maximum pause duration (10 minutes)', async () => {
    const onResume = vi.fn();
    const pauseDuration = 600000; // 10 minutes

    await PauseTimer.delay(pauseDuration, onResume);

    expect(mockChrome.alarms.create).toHaveBeenCalledWith(
      expect.stringMatching(/^pause-resume-/),
      { delayInMinutes: 10 }
    );
  });

  it('should only trigger callback for matching alarm name', async () => {
    const onResume = vi.fn();
    const pauseDuration = 60000;

    await PauseTimer.delay(pauseDuration, onResume);

    const listener = mockChrome.alarms.onAlarm.addListener.mock.calls[0][0];
    const correctAlarmName = mockChrome.alarms.create.mock.calls[0][0];

    // Fire wrong alarm
    listener({ name: 'different-alarm' });
    expect(onResume).not.toHaveBeenCalled();

    // Fire correct alarm
    listener({ name: correctAlarmName });

    expect(onResume).toHaveBeenCalledOnce();
  });

  it('should clean up listener after alarm fires', async () => {
    const onResume = vi.fn();
    const pauseDuration = 60000;

    await PauseTimer.delay(pauseDuration, onResume);

    const listener = mockChrome.alarms.onAlarm.addListener.mock.calls[0][0];
    const alarmName = mockChrome.alarms.create.mock.calls[0][0];

    // Fire alarm
    listener({ name: alarmName });

    expect(mockChrome.alarms.onAlarm.removeListener).toHaveBeenCalledWith(listener);
  });
});
