import { setRuntimeProfile } from '@/runtime/profile';
import {
  createDevDesktopRuntimeHost,
  setDesktopRuntimeHost,
  type DesktopRuntimeHost,
} from './host';
import { StdioFrameCarrier } from './protocol/stdioCarrier';
import {
  DESKTOP_RUNTIME_PROTOCOL_VERSION,
  type DesktopRuntimeFrame,
} from './protocol/frames';
import {
  DesktopRuntimeControlBridge,
  setDesktopRuntimeControlBridge,
} from './protocol/controlBridge';
import { StdioRuntimeChannel } from './channels/StdioRuntimeChannel';
import { PiRuntimeBootstrap } from './PiRuntimeBootstrap';

async function loadHost(): Promise<DesktopRuntimeHost> {
  const raw = process.env.APPLEPI_DESKTOP_RUNTIME_HOST;
  if (raw) return JSON.parse(raw) as DesktopRuntimeHost;
  return createDevDesktopRuntimeHost();
}

async function main(): Promise<void> {
  setRuntimeProfile('desktop-runtime');
  const host = await loadHost();
  setDesktopRuntimeHost(host);

  const carrier = new StdioFrameCarrier();
  const controlBridge = new DesktopRuntimeControlBridge(carrier);
  setDesktopRuntimeControlBridge(controlBridge);

  let bootstrap: PiRuntimeBootstrap | null = null;
  carrier.onFrame((frame: DesktopRuntimeFrame) => {
    if (controlBridge.handleFrame(frame)) return;
    if (frame.type === 'shutdown') {
      void bootstrap?.shutdown().finally(() => process.exit(0));
    }
  });
  carrier.on('error', (error) => {
    console.error('[desktop-runtime] stdio carrier error:', error);
  });
  carrier.start();

  carrier.send({
    type: 'hello-ok',
    protocolVersion: DESKTOP_RUNTIME_PROTOCOL_VERSION,
    runtimeProfile: 'desktop-runtime',
    pid: process.pid,
  });

  const channel = new StdioRuntimeChannel(carrier);
  bootstrap = new PiRuntimeBootstrap(channel);
  await bootstrap.initialize();

  const shutdown = (signal: string) => {
    void bootstrap.shutdown().finally(() => {
      console.error(`[desktop-runtime] shutdown after ${signal}`);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error) => {
  console.error('[desktop-runtime] fatal startup error:', error);
  process.exit(1);
});
