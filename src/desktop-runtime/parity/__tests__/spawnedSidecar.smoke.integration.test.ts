/**
 * Track 45 Goal 1 — spawned-sidecar protocol & lifecycle smoke test.
 *
 * Boots the real WorkX desktop runtime sidecar
 * (`tauri/sidecar/desktop-runtime/index.mjs`) and asserts three
 * end-to-end behaviors that today's CI does not cover:
 *
 *   1. The sidecar launches and completes the `hello`/`hello-ok`
 *      handshake (nonce-and-version verified).
 *   2. A `ping`/`pong` round-trip succeeds against the runtime's
 *      always-on health handler (`src/desktop-runtime/index.ts:65`).
 *      This is the side-effect-free smoke target — it does NOT
 *      involve RepublicAgent, model clients, storage, MCP, scheduler,
 *      or auth.
 *   3. Graceful shutdown: sending the `shutdown` frame causes the
 *      child to exit within `SHUTDOWN_GRACE` (5 s).
 *
 * Out of scope (deliberate, see Track 45 design): UserInput Op
 * comparisons against a canonical event sequence. The Track 43 parity
 * scaffolding that previously held such a list (`scenarios.ts` +
 * `SCENARIO_EVENT_SEQUENCES`) had invalid Op payloads and synthetic
 * placeholder events; it was removed when this PR landed. A real
 * functional-turn verifier requires deterministic agent fixtures and
 * belongs in a separate track.
 *
 * Prerequisite: `npm run build:desktop-runtime-sidecar` must have run
 * first. The Tauri beforeBuild hook does this automatically; for a
 * direct test invocation the helper raises a clear error pointing at
 * the command if the bundle is missing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSidecar, type SpawnedSidecar } from './spawnedSidecar.helper';

describe('spawned-sidecar protocol smoke (Track 45 Goal 1)', () => {
  let tmpConfigDir: string;
  let sidecar: SpawnedSidecar;

  beforeAll(async () => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'applepi-track45-'));
    sidecar = await spawnSidecar({ tmpConfigDir });
  }, 60_000);

  afterAll(async () => {
    if (sidecar) {
      await sidecar.shutdown();
    }
    if (tmpConfigDir) {
      try {
        rmSync(tmpConfigDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('completes the hello/hello-ok handshake on startup', () => {
    // Verified by the fact that `spawnSidecar()` in `beforeAll` returned
    // successfully — its implementation throws on nonce/version mismatch
    // or handshake timeout (see `spawnedSidecar.helper.ts`).
    expect(sidecar.child().pid).toBeGreaterThan(0);
    expect(sidecar.child().exitCode).toBeNull();
  });

  it('answers a ping with a matching pong (side-effect-free round-trip)', async () => {
    await sidecar.sendPing();
  });

  it('exits gracefully within SHUTDOWN_GRACE after a shutdown frame', async () => {
    const started = Date.now();
    await sidecar.shutdown();
    const elapsed = Date.now() - started;
    const child = sidecar.child();
    expect(child.exitCode != null || child.signalCode != null).toBe(true);
    // SHUTDOWN_GRACE is 5 s in runtime_supervisor.rs; allow a small
    // observer-side margin (Vitest fake timers + process scheduling).
    expect(elapsed).toBeLessThan(6_000);
  });
});
