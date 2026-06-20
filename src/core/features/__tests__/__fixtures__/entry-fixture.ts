// Track 22 regression fixture — the gate call site, mirroring the real
// `if (MCP) { ... }` pattern in service-worker.ts.
import { TESTGATE } from './feature-fixture';
import { HEAVY_MARKER } from './heavy-fixture';

export function run(): string {
  if (TESTGATE) {
    return HEAVY_MARKER;
  }
  return 'off';
}
