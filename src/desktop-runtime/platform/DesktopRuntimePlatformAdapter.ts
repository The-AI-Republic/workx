import { DesktopPlatformAdapter } from '@/desktop/platform/DesktopPlatformAdapter';
import type { BrowserPageContext } from '@/core/platform/IPlatformAdapter';
import { getBrowserBridgeHandle } from '@/tools/browserBridgeHandle';

export class DesktopRuntimePlatformAdapter extends DesktopPlatformAdapter {
  constructor(private readonly sessionId: string) {
    super();
  }

  override async initialize(): Promise<void> {
    await super.initialize();
  }

  override async getCurrentPageContext(): Promise<BrowserPageContext> {
    const bridge = getBrowserBridgeHandle();
    if (bridge?.hasActiveNode()) {
      const context = await bridge.getSessionBrowserContext(this.sessionId);
      return context
        ? { tabId: context.tabId, currentUrl: context.url, currentDomain: context.hostname }
        : {};
    }
    // The desktop fallback adapter is process-global and therefore cannot be
    // used as a per-session browser identity source.
    return {};
  }

  override async dispose(): Promise<void> {
    await getBrowserBridgeHandle()?.releaseSession(this.sessionId).catch(() => undefined);
    await super.dispose();
  }
}
