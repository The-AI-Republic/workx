/**
 * ChromeActiveTabAdapter — extension-only adapter that pumps Chrome tab events
 * into a shared ActiveTabService so SkillDomainFilter can react to navigation.
 *
 * Listens to:
 *  - chrome.tabs.onActivated  — user switches tab
 *  - chrome.tabs.onUpdated    — current tab navigates (filters to URL/load completion)
 *  - chrome.windows.onFocusChanged — user switches windows (re-queries active tab)
 *
 * Returns dispose() that removes all listeners.
 */

import type { ActiveTabService } from '@/core/tabs/ActiveTabService';

function hostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function pushActiveTab(service: ActiveTabService, tabId?: number): Promise<void> {
  try {
    const tab = tabId !== undefined
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab || !tab.url) return;
    const hostname = hostnameFromUrl(tab.url);
    if (!hostname) return; // chrome:// urls etc. — skip
    service.setSnapshot({ url: tab.url, hostname, tabId: tab.id });
  } catch {
    // tab may have closed mid-flight; fall through silently
  }
}

export function startChromeActiveTabAdapter(service: ActiveTabService): () => void {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    console.warn('[ChromeActiveTabAdapter] chrome.tabs not available — adapter inert');
    return () => undefined;
  }

  const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
    void pushActiveTab(service, info.tabId);
  };
  const onUpdated = (
    tabId: number,
    changeInfo: chrome.tabs.OnUpdatedInfo,
    tab: chrome.tabs.Tab,
  ) => {
    if (!tab.active) return;
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    void pushActiveTab(service, tabId);
  };
  const onFocusChanged = (windowId: number) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void pushActiveTab(service);
  };

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  if (chrome.windows?.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
  }

  // Seed the service with whatever's currently active.
  void pushActiveTab(service);

  return () => {
    try { chrome.tabs.onActivated.removeListener(onActivated); } catch { /* shutdown */ }
    try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch { /* shutdown */ }
    try { chrome.windows?.onFocusChanged?.removeListener(onFocusChanged); } catch { /* shutdown */ }
  };
}
