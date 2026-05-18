import { ServerAgentBootstrap } from '@/server/agent/ServerAgentBootstrap';
import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import { getDesktopRuntimeHost } from './host';

export class PiRuntimeBootstrap extends ServerAgentBootstrap {
  constructor(channel: ChannelAdapter) {
    const host = getDesktopRuntimeHost();
    super({
      profile: 'desktop-runtime',
      dataDir: host.configDir,
      channel,
    });
  }
}
