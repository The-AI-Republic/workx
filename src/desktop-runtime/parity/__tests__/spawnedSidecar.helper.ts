/**
 * Track 45 Goal 1 — spawned-sidecar test helper.
 *
 * Spawns the real Apple Pi desktop runtime sidecar
 * (`tauri/sidecar/desktop-runtime/index.mjs`) as a Node child process,
 * drives the `hello`/`hello-ok` handshake using the production
 * `StdioFrameCarrier`, and exposes a small request/response surface
 * for the smoke test:
 *
 *   - `sendPing(): Promise<void>` — round-trip a `ping` against the
 *     runtime's always-on health handler (`src/desktop-runtime/index.ts:65`).
 *     Side-effect-free; does not touch RepublicAgent / model / storage.
 *   - `shutdown(): Promise<void>` — send `shutdown`, wait up to
 *     `SHUTDOWN_GRACE_MS` for clean exit, escalate to SIGKILL otherwise.
 *
 * Deliberately narrow scope: this helper only proves the sidecar
 * boots, handshakes, answers protocol pings, and shuts down. It does
 * NOT drive UserInput Ops or compare event sequences against a
 * canonical list — the Track 43 parity scaffolding that previously
 * lived in `scenarios.ts` was removed when this PR landed because its
 * Op payloads were type-incorrect and its event sequences were
 * synthetic placeholders. Building a real functional-turn verifier
 * requires deterministic agent fixtures (fake model client, fake
 * services, fake storage) and is out of scope for Track 45.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StdioFrameCarrier } from '@/desktop-runtime/protocol/stdioCarrier';
import { DESKTOP_RUNTIME_PROTOCOL_VERSION, type DesktopRuntimeFrame } from '@/desktop-runtime/protocol/frames';

/** Matches `SHUTDOWN_GRACE` in `tauri/src/runtime_supervisor.rs:24`. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Bounds the handshake reply wait. The real supervisor has no explicit
 *  handshake timeout; for tests we want to fail fast if the sidecar
 *  fails to start. */
const HANDSHAKE_DEADLINE_MS = 30_000;
/** Bounds a ping/pong round-trip. */
const PING_DEADLINE_MS = 5_000;

export interface SpawnSidecarOptions {
  /**
   * Absolute path to a writable directory used as
   * `APPLEPI_DESKTOP_CONFIG_DIR`. `createDevDesktopRuntimeHost` will
   * build storage/rollouts/config paths under it. The caller is
   * responsible for cleanup.
   */
  tmpConfigDir: string;
  /**
   * Optional override for the sidecar entry path. Defaults to
   * `tauri/sidecar/desktop-runtime/index.mjs` resolved against repo
   * root.
   */
  entryPath?: string;
}

export interface SpawnedSidecar {
  /** Round-trip a `ping`. Resolves on matching `pong`. */
  sendPing(): Promise<void>;
  /** Send `shutdown`; wait for clean exit; SIGKILL if exceeded. */
  shutdown(): Promise<void>;
  /** Underlying child process for diagnostic access (e.g. exit code). */
  child(): ChildProcessWithoutNullStreams;
}

function resolveSidecarEntry(override: string | undefined): string {
  if (override) return override;
  // Tests run from repo root via vitest; resolve relative to CWD which
  // vitest sets to the project root by default.
  const candidate = resolve(process.cwd(), 'tauri/sidecar/desktop-runtime/index.mjs');
  if (!existsSync(candidate)) {
    throw new Error(
      `Sidecar entry not found at ${candidate}. ` +
      `Run \`npm run build:desktop-runtime-sidecar\` and retry.`,
    );
  }
  return candidate;
}

export async function spawnSidecar(opts: SpawnSidecarOptions): Promise<SpawnedSidecar> {
  const entry = resolveSidecarEntry(opts.entryPath);

  // Prefer the bundled Node next to the entry if present (Track 44 ships
  // it for the production sidecar). Fall back to the test process's own
  // node — same binary that's running the test.
  const bundledNode = join(entry, '..', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;

  const child = spawn(nodeBin, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APPLEPI_RUNTIME_PROFILE: 'desktop-runtime',
      APPLEPI_DESKTOP_RUNTIME_ALLOW_DEV_HOST: 'true',
      APPLEPI_DESKTOP_CONFIG_DIR: opts.tmpConfigDir,
      // Quiet a couple of optional integrations the dev host doesn't need.
      NODE_NO_WARNINGS: '1',
    },
  }) as ChildProcessWithoutNullStreams;

  // Surface stderr to the test logger for diagnostics. Never parsed as
  // protocol (stderr is diagnostics-only by the runtime contract).
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[sidecar-stderr] ${chunk}`);
  });

  const carrier = new StdioFrameCarrier(child.stdout, child.stdin);

  // Bucket incoming frames by type so the handshake / ping / shutdown
  // helpers below can `await` what they need without missing earlier
  // arrivals. Each waiter records both resolve and reject so carrier
  // errors can fail the wait with the real cause instead of letting it
  // time out with a generic message.
  type Waiter = {
    resolve: (f: DesktopRuntimeFrame) => void;
    reject: (err: Error) => void;
  };
  const helloOkWaiters: Waiter[] = [];
  const pongWaiters = new Map<string, Waiter>();
  carrier.onFrame((frame) => {
    if (frame.type === 'hello-ok') {
      const w = helloOkWaiters.shift();
      if (w) w.resolve(frame);
    } else if (frame.type === 'pong') {
      const id = (frame as Extract<DesktopRuntimeFrame, { type: 'pong' }>).id;
      if (id) {
        const w = pongWaiters.get(id);
        if (w) {
          pongWaiters.delete(id);
          w.resolve(frame);
        }
      }
    }
    // All other frame types (event, response, control-request, …) are
    // ignored by the smoke test — they're produced by the agent stack
    // we're explicitly NOT driving.
  });
  carrier.on('error', (err) => {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[sidecar-carrier-error] ${wrapped.message}\n`);
    // Surface the real cause to every pending waiter so callers see
    // (e.g.) "Invalid frame length" instead of a generic "timed out"
    // 30 seconds later.
    while (helloOkWaiters.length > 0) {
      const w = helloOkWaiters.shift();
      if (w) w.reject(wrapped);
    }
    for (const [id, w] of pongWaiters) {
      pongWaiters.delete(id);
      w.reject(wrapped);
    }
  });
  carrier.start();

  // Drive the handshake.
  const nonce = randomUUID();
  carrier.send({
    type: 'hello',
    nonce,
    protocolVersion: DESKTOP_RUNTIME_PROTOCOL_VERSION,
  } as DesktopRuntimeFrame);

  // Hold onto the waiter reference so `onTimeout` can remove it from the
  // queue (otherwise a late `hello-ok` after a timeout would call a stale
  // resolver — benign today, but the pong path handles this correctly
  // and the hello path should too).
  let handshakeWaiter: Waiter | null = null;
  const helloOk = await withTimeout(
    new Promise<DesktopRuntimeFrame>((resolve, reject) => {
      handshakeWaiter = { resolve, reject };
      helloOkWaiters.push(handshakeWaiter);
    }),
    HANDSHAKE_DEADLINE_MS,
    'handshake (hello-ok) timed out',
    () => {
      if (handshakeWaiter) {
        const idx = helloOkWaiters.indexOf(handshakeWaiter);
        if (idx >= 0) helloOkWaiters.splice(idx, 1);
      }
      safeKill(child);
    },
  );

  const ok = helloOk as Extract<DesktopRuntimeFrame, { type: 'hello-ok' }>;
  if (ok.protocolVersion !== DESKTOP_RUNTIME_PROTOCOL_VERSION) {
    safeKill(child);
    throw new Error(
      `Handshake protocolVersion mismatch: expected ${DESKTOP_RUNTIME_PROTOCOL_VERSION}, ` +
      `got ${ok.protocolVersion}`,
    );
  }
  if (ok.nonce !== nonce) {
    safeKill(child);
    throw new Error(`Handshake nonce mismatch: expected ${nonce}, got ${ok.nonce}`);
  }

  async function sendPing(): Promise<void> {
    const id = randomUUID();
    carrier.send({ type: 'ping', id } as DesktopRuntimeFrame);
    await withTimeout(
      new Promise<DesktopRuntimeFrame>((resolve, reject) => {
        pongWaiters.set(id, { resolve, reject });
      }),
      PING_DEADLINE_MS,
      `ping (${id}) timed out without a matching pong`,
      () => {
        pongWaiters.delete(id);
      },
    );
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode != null || child.signalCode != null) {
      carrier.stop();
      return;
    }
    try {
      carrier.send({ type: 'shutdown' } as DesktopRuntimeFrame);
    } catch {
      // Stdin may already be closed — that's fine, escalate below if needed.
    }
    const exited = await waitForExit(child, SHUTDOWN_GRACE_MS);
    carrier.stop();
    if (!exited) {
      child.kill('SIGKILL');
      await waitForExit(child, 2_000);
    }
  }

  return {
    sendPing,
    shutdown,
    child: () => child,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout();
        reject(new Error(message));
      }, ms);
    }),
  ]);
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function safeKill(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // best-effort
  }
}
