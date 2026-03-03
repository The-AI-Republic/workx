import { describe, it, expect } from 'vitest';
import { NoOpNotifier } from '../IUserNotifier';

describe('NoOpNotifier', () => {
  const notifier = new NoOpNotifier();

  it('notifyInfo resolves with empty string', async () => {
    const result = await notifier.notifyInfo('title', 'msg');
    expect(result).toBe('');
  });

  it('notifyWarning resolves with empty string', async () => {
    const result = await notifier.notifyWarning('title', 'msg');
    expect(result).toBe('');
  });

  it('notifyProgress resolves with empty string', async () => {
    const result = await notifier.notifyProgress('title', 'msg', 0, 100);
    expect(result).toBe('');
  });

  it('updateProgress resolves without throwing', async () => {
    await expect(notifier.updateProgress('id', 50, 100)).resolves.toBeUndefined();
  });

  it('processEvent resolves without throwing', async () => {
    await expect(notifier.processEvent({} as any)).resolves.toBeUndefined();
  });

  it('clearAll resolves without throwing', async () => {
    await expect(notifier.clearAll()).resolves.toBeUndefined();
  });

  it('onNotification does nothing without throwing', () => {
    expect(() => notifier.onNotification(() => {})).not.toThrow();
  });
});
