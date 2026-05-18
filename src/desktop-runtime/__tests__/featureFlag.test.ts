import { afterEach, describe, expect, it } from 'vitest';
import { isDesktopRuntimeRelayEnabled } from '../featureFlag';

describe('desktop runtime relay feature flag', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('keeps the legacy in-WebView path as the default', () => {
    expect(isDesktopRuntimeRelayEnabled()).toBe(false);
  });

  it('enables the relay only when explicitly opted in', () => {
    localStorage.setItem('applepi.desktopRuntimeRelay', 'true');
    expect(isDesktopRuntimeRelayEnabled()).toBe(true);
  });

  it('does not enable the relay for legacy opt-out values', () => {
    localStorage.setItem('applepi.desktopRuntimeRelay', 'false');
    expect(isDesktopRuntimeRelayEnabled()).toBe(false);
  });
});
