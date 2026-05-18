export function isDesktopRuntimeRelayEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem('applepi.desktopRuntimeRelay') === 'true';
}
