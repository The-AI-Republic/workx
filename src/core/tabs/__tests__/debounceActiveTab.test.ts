import { describe, expect, it, vi } from 'vitest';
import { createDebouncedActiveTabHandler } from '../debounceActiveTab';

describe('createDebouncedActiveTabHandler', () => {
  it('collapses rapid tab changes into one trailing callback', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const handler = createDebouncedActiveTabHandler(onChange, 500);

      handler.handle({ hostname: 'a.test' });
      handler.handle({ hostname: 'b.test' });
      handler.handle({ hostname: 'c.test' });

      vi.advanceTimersByTime(499);
      expect(onChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ hostname: 'c.test' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('can cancel a pending callback', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const handler = createDebouncedActiveTabHandler(onChange, 500);

      handler.handle({ hostname: 'a.test' });
      handler.cancel();
      vi.advanceTimersByTime(500);

      expect(onChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
