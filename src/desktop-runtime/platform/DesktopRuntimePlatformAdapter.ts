import { DesktopPlatformAdapter } from '@/desktop/platform/DesktopPlatformAdapter';

export class DesktopRuntimePlatformAdapter extends DesktopPlatformAdapter {
  override async initialize(): Promise<void> {
    await super.initialize();
  }
}
