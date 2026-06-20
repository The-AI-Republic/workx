// @vitest-environment node
/**
 * Track 22 — DCE regression guard (Phase 3 / Risk: "feature.ts must stay a
 * bare typed export").
 *
 * Bundles the fixture through Vite's real `build()` (Rollup + `define` +
 * esbuild minify — the exact production pipeline, which is what gives the
 * cross-module constant propagation that Phase 0 measured) and asserts the
 * gated "heavy" module's unique marker:
 *   - is ABSENT when the flag is defined false  (dead-code eliminated)
 *   - is PRESENT when the flag is defined true   (positive control)
 *
 * If anyone reverts feature.ts to a string-keyed indexed `feature('X')`
 * function, the equivalent fixture change stops constant-folding and the
 * "absent when false" assertion fails — loudly, in CI.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '__fixtures__/entry-fixture.ts');
const MARKER = 'HEAVY_MODULE_a1b2c3d4_PRESENT_IN_BUNDLE';

async function bundleWith(flag: 'true' | 'false'): Promise<string> {
  const result = (await build({
    configFile: false,
    logLevel: 'silent',
    define: { __FEATURE_TESTGATE__: flag },
    build: {
      write: false,
      minify: true,
      lib: { entry, formats: ['es'], fileName: 'out' },
    },
  })) as Array<{ output: Array<{ type: string; code?: string }> }>;
  // `write:false` lib build → RollupOutput[]; concat every emitted chunk.
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((o) => o.output)
    .map((c) => ('code' in c && c.code ? c.code : ''))
    .join('\n');
}

describe('Track 22 — compile-time gate is dead-code-eliminable', () => {
  it('flag OFF: gated heavy module is stripped from the bundle', async () => {
    const out = await bundleWith('false');
    expect(out).not.toContain(MARKER);
  });

  it('flag ON: gated heavy module is present (positive control)', async () => {
    const out = await bundleWith('true');
    expect(out).toContain(MARKER);
  });
});
