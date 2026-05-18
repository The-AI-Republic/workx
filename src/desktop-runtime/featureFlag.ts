export function isDesktopRuntimeRelayEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem('applepi.desktopRuntimeRelay') !== 'false';
}
