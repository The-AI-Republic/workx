export type RuntimeProfile = 'extension' | 'desktop-webview' | 'desktop-runtime' | 'server';

let overrideProfile: RuntimeProfile | null = null;

export function setRuntimeProfile(profile: RuntimeProfile): void {
  overrideProfile = profile;
  if (typeof process !== 'undefined') {
    process.env.APPLEPI_RUNTIME_PROFILE = profile;
  }
}

export function getRuntimeProfile(): RuntimeProfile {
  if (overrideProfile) return overrideProfile;

  if (typeof process !== 'undefined') {
    const envProfile = process.env.APPLEPI_RUNTIME_PROFILE;
    if (
      envProfile === 'extension' ||
      envProfile === 'desktop-webview' ||
      envProfile === 'desktop-runtime' ||
      envProfile === 'server'
    ) {
      return envProfile;
    }
  }

  if (typeof __BUILD_MODE__ !== 'undefined') {
    if (__BUILD_MODE__ === 'desktop') return 'desktop-webview';
    if (__BUILD_MODE__ === 'extension') return 'extension';
  }

  return 'server';
}

export function isDesktopRuntimeProfile(): boolean {
  return getRuntimeProfile() === 'desktop-runtime';
}
