import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActiveTabService, type ActiveTabSnapshot } from '@/core/tabs/ActiveTabService';

const snap = (host: string, url?: string, tabId?: number): ActiveTabSnapshot => ({
  hostname: host,
  url: url ?? `https://${host}/`,
  tabId,
});

describe('ActiveTabService', () => {
  let service: ActiveTabService;

  beforeEach(() => {
    service = new ActiveTabService();
  });

  it('starts empty', () => {
    expect(service.getCurrent()).toBeNull();
  });

  it('setSnapshot stores and returns via getCurrent', () => {
    service.setSnapshot(snap('gmail.com'));
    expect(service.getCurrent()?.hostname).toBe('gmail.com');
  });

  it('notifies subscribers on snapshot change', () => {
    const listener = vi.fn();
    service.subscribe(listener);
    service.setSnapshot(snap('gmail.com'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'gmail.com' }));
  });

  it('does NOT notify when same hostname+url is set again', () => {
    const listener = vi.fn();
    service.subscribe(listener);
    service.setSnapshot(snap('gmail.com', 'https://gmail.com/inbox'));
    service.setSnapshot(snap('gmail.com', 'https://gmail.com/inbox'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('DOES notify when url changes within same hostname', () => {
    const listener = vi.fn();
    service.subscribe(listener);
    service.setSnapshot(snap('gmail.com', 'https://gmail.com/inbox'));
    service.setSnapshot(snap('gmail.com', 'https://gmail.com/sent'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies multiple subscribers', () => {
    const a = vi.fn();
    const b = vi.fn();
    service.subscribe(a);
    service.subscribe(b);
    service.setSnapshot(snap('gmail.com'));
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('unsubscribe removes only that listener', () => {
    const a = vi.fn();
    const b = vi.fn();
    const off = service.subscribe(a);
    service.subscribe(b);
    off();
    service.setSnapshot(snap('gmail.com'));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('isolates listener throws (other listeners still fire)', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    service.subscribe(a);
    service.subscribe(b);
    service.setSnapshot(snap('gmail.com'));
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('reset clears state', () => {
    const listener = vi.fn();
    service.subscribe(listener);
    service.setSnapshot(snap('gmail.com'));
    service.reset();
    expect(service.getCurrent()).toBeNull();
    service.setSnapshot(snap('github.com'));
    expect(listener).toHaveBeenCalledTimes(1); // only the first call before reset
  });
});
