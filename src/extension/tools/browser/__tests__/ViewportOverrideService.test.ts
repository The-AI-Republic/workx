import { describe, it, expect, vi } from 'vitest';
import { ViewportOverrideService } from '../ViewportOverrideService';

describe('ViewportOverrideService', () => {
  it('applies an explicit size with deviceScaleFactor 1', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new ViewportOverrideService(send);

    const applied = await service.setOverride({ width: 375, height: 667 });

    expect(applied).toEqual({ width: 375, height: 667 });
    expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });

  it('defaults to the current CSS viewport when size omitted', async () => {
    const send = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: { width: 1280, height: 720 } } };
      return undefined;
    });
    const service = new ViewportOverrideService(send);

    const applied = await service.setOverride();

    expect(applied).toEqual({ width: 1280, height: 720 });
    expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });

  it('clears the override', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new ViewportOverrideService(send);
    await service.clearOverride();
    expect(send).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
  });

  it('clearOverride never throws', async () => {
    const send = vi.fn().mockRejectedValue(new Error('detached'));
    const service = new ViewportOverrideService(send);
    await expect(service.clearOverride()).resolves.toBeUndefined();
  });
});
