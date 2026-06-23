/**
 * ViewportOverrideService — deterministic viewport via CDP Emulation.
 *
 * Applies `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1` so
 * screenshot pixels == CSS pixels == input coordinates, eliminating all DPR
 * math downstream (the structural fix behind the T08 DPR hotfix). Also lets the
 * agent test responsive/breakpoint layouts via an explicit size.
 *
 * Scope (design §3.3 / §1.6): the override is user-visible (it resizes the live
 * tab), so it is applied ONLY during page_vision flows and explicit
 * `browser_viewport set`, defaults to the tab's CURRENT CSS viewport (not a
 * fixed 1280×720) to avoid visibly resizing the user's page, and is always
 * cleared on release / turn end.
 *
 * @module extension/tools/browser/ViewportOverrideService
 */

export type CdpSend = <T = any>(method: string, params?: any) => Promise<T>;

export interface ViewportSize {
  width: number;
  height: number;
}

export class ViewportOverrideService {
  constructor(private readonly send: CdpSend) {}

  /**
   * Apply a deterministic viewport. Width/height default to the tab's current
   * CSS viewport so the page isn't visibly resized. Returns the size applied.
   */
  async setOverride(size?: Partial<ViewportSize>): Promise<ViewportSize> {
    let width = size?.width;
    let height = size?.height;

    if (width === undefined || height === undefined) {
      const current = await this.getCurrentViewport();
      width = width ?? current.width;
      height = height ?? current.height;
    }

    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    return { width, height };
  }

  /** Clear any active device-metrics override. Never throws. */
  async clearOverride(): Promise<void> {
    try {
      await this.send('Emulation.clearDeviceMetricsOverride', {});
    } catch (error) {
      console.warn('[ViewportOverrideService] clearDeviceMetricsOverride failed:', error);
    }
  }

  private async getCurrentViewport(): Promise<ViewportSize> {
    const result = await this.send<any>('Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight })',
      returnByValue: true,
    });
    return result.result.value;
  }
}
