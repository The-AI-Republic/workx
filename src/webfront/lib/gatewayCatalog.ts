import { GATEWAY_CATALOG_URL } from './constants';

export interface GatewayCatalogOpenResult {
  opened: boolean;
  url: string | null;
}

export function getGatewayCatalogUrl(): string | null {
  const url = GATEWAY_CATALOG_URL.trim();
  return url.length > 0 ? url : null;
}

export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
    return;
  } catch {
    // Fall through to browser surfaces below. The Tauri shell plugin is only
    // available in the desktop shell.
  }

  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url });
    return;
  }

  if (typeof window !== 'undefined' && window.open) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  throw new Error('No external URL opener is available');
}

export async function openGatewayCatalog(
  opener: (url: string) => Promise<void> = openExternalUrl,
): Promise<GatewayCatalogOpenResult> {
  const url = getGatewayCatalogUrl();
  if (!url) {
    return { opened: false, url: null };
  }

  await opener(url);
  return { opened: true, url };
}
