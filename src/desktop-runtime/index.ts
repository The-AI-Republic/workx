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
import { DESKTOP_RUNTIME_PROTOCOL_VERSION, type DesktopRuntimeFrame } from './protocol/frames';
import {
  DesktopRuntimeControlBridge,
  setDesktopRuntimeControlBridge,
} from './protocol/controlBridge';
import { StdioRuntimeChannel } from './channels/StdioRuntimeChannel';
import { WorkXRuntimeBootstrap } from './WorkXRuntimeBootstrap';
import { DesktopAppServerManager } from './app-server/DesktopAppServerManager';

async function loadHost(): Promise<DesktopRuntimeHost> {
  const raw = process.env.WORKX_DESKTOP_RUNTIME_HOST;
  if (raw) return assertDesktopRuntimeHost(JSON.parse(raw) as DesktopRuntimeHost);
  return createDevDesktopRuntimeHost();
}

async function main(): Promise<void> {
  setRuntimeProfile('desktop-runtime');
  if (process.env.WORKX_DATA_SOURCE_PACKAGING_SELF_TEST === '1') {
    const { runDataSourcePackagingSelfTest } = await import('./data-sources/packagingSelfTest');
    await runDataSourcePackagingSelfTest();
    console.error('[desktop-runtime] data-source-packaging-ok');
    return;
  }
  const host = await loadHost();
  setDesktopRuntimeHost(host);

  const carrier = new StdioFrameCarrier();
  const controlBridge = new DesktopRuntimeControlBridge(carrier);
  setDesktopRuntimeControlBridge(controlBridge);
  // Attach the request-buffering listener before stdin starts flowing. The
  // supervisor may send application requests immediately after hello-ok.
  const channel = new StdioRuntimeChannel(carrier);

  let bootstrap: WorkXRuntimeBootstrap | null = null;
  let appServer: DesktopAppServerManager | null = null;
  let helloAcked = false;

  // Stop the app-server listener before the bootstrap tears down its sessions,
  // so in-flight bridge connections are rejected cleanly rather than orphaned.
  const shutdownAll = async (): Promise<void> => {
    await appServer?.stop('runtime shutdown').catch(() => undefined);
    await bootstrap?.shutdown();
  };

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
              `expected ${DESKTOP_RUNTIME_PROTOCOL_VERSION}; exiting`
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
        void shutdownAll().finally(() => process.exit(0));
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
      console.error(
        '[desktop-runtime] WARN: no hello received after 2s; sending unsolicited hello-ok. The Rust supervisor should have sent `hello` — this fallback exists for backward compatibility only and may mask a protocol regression.'
      );
      sendHelloOk(undefined);
    }
  }, 2_000);

  bootstrap = new WorkXRuntimeBootstrap({ channel });
  await bootstrap.initialize();
  await channel.activate();

  // Bring up the desktop app-server (the loopback WS listener the browser
  // bridge connects to) and register its UI-facing status/control services.
  // registerServices() runs unconditionally so the settings UI can always read
  // status and toggle the listener; startFromConfig() only binds the listener
  // when app-server config is enabled (it never throws — failures are logged
  // and the runtime continues). When it binds, it also installs the Chrome
  // native-messaging host so the extension can connect with zero pairing.
  appServer = new DesktopAppServerManager({ bootstrap });
  appServer.registerServices();
  await appServer.startFromConfig();

  const shutdown = (signal: string) => {
    void shutdownAll().finally(() => {
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
