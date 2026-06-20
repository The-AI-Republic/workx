// MUST be the first import: redirects console.* off fd 1 before any other
// module's top-level code can log and corrupt the frame protocol.
import './stdoutGuard';
import { setRuntimeProfile } from '@/runtime/profile';
import {
  assertDesktopRuntimeHost,
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
import { WorkXRuntimeBootstrap } from './WorkXRuntimeBootstrap';

async function loadHost(): Promise<DesktopRuntimeHost> {
  const raw = process.env.WORKX_DESKTOP_RUNTIME_HOST;
  if (raw) return assertDesktopRuntimeHost(JSON.parse(raw) as DesktopRuntimeHost);
  return createDevDesktopRuntimeHost();
}

async function main(): Promise<void> {
  setRuntimeProfile('desktop-runtime');
  const host = await loadHost();
  setDesktopRuntimeHost(host);

  const carrier = new StdioFrameCarrier();
  const controlBridge = new DesktopRuntimeControlBridge(carrier);
  setDesktopRuntimeControlBridge(controlBridge);

  let bootstrap: WorkXRuntimeBootstrap | null = null;
  let helloAcked = false;

  const sendHelloOk = (nonce?: string): void => {
    helloAcked = true;
    carrier.send({
      type: 'hello-ok',
      nonce,
      protocolVersion: DESKTOP_RUNTIME_PROTOCOL_VERSION,
      runtimeProfile: 'desktop-runtime',
      pid: process.pid,
    });
  };

  carrier.onFrame((frame: DesktopRuntimeFrame) => {
    if (controlBridge.handleFrame(frame)) return;
    switch (frame.type) {
      case 'hello':
        if (frame.protocolVersion !== DESKTOP_RUNTIME_PROTOCOL_VERSION) {
          console.error(
            `[desktop-runtime] unsupported protocol version ${frame.protocolVersion}, ` +
            `expected ${DESKTOP_RUNTIME_PROTOCOL_VERSION}; exiting`,
          );
          process.exit(1);
        }
        sendHelloOk(frame.nonce);
        break;
      case 'ping':
        // Answer health pings here (always-on, including during slow bootstrap
        // init before the channel attaches) so the supervisor never sees a
        // false "unresponsive" during startup.
        carrier.send({ type: 'pong', id: frame.id, ts: Date.now() });
        break;
      case 'shutdown':
        void bootstrap?.shutdown().finally(() => process.exit(0));
        break;
    }
  });
  carrier.on('error', (error) => {
    console.error('[desktop-runtime] stdio carrier error:', error);
  });
  carrier.start();

  // A supervisor that does not perform the hello handshake (older host) will
  // never send `hello`; emit an unsolicited hello-ok once so it still learns
  // pid/profile and does not deadlock waiting for it. Log loudly so a
  // missing-handshake regression (the supervisor should ALWAYS send `hello`
  // after Track 43) is visible in the supervisor's `runtime:stderr` event
  // stream, not silently papered over.
  setTimeout(() => {
    if (!helloAcked) {
      console.error('[desktop-runtime] WARN: no hello received after 2s; sending unsolicited hello-ok. The Rust supervisor should have sent `hello` — this fallback exists for backward compatibility only and may mask a protocol regression.');
      sendHelloOk(undefined);
    }
  }, 2_000);

  const channel = new StdioRuntimeChannel(carrier);
  bootstrap = new WorkXRuntimeBootstrap({ channel });
  await bootstrap.initialize();

  const shutdown = (signal: string) => {
    void Promise.resolve(bootstrap?.shutdown()).finally(() => {
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
