import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installTelemetry } from '../install';
import {
  logEvent,
  _resetForTesting,
  type TelemetryEvent,
} from '../analytics';

describe('installTelemetry gate (Test 3.b)', () => {
  const orig = process.env.APPLEPI_NO_TELEMETRY;
  beforeEach(() => _resetForTesting());
  afterEach(() => {
    if (orig === undefined) delete process.env.APPLEPI_NO_TELEMETRY;
    else process.env.APPLEPI_NO_TELEMETRY = orig;
  });

  it('telemetryEnabled:false → sink attached but nothing emitted', async () => {
    const seen: TelemetryEvent[] = [];
    installTelemetry({
      getTelemetryEnabled: () => false,
      sink: { write: (e) => seen.push(e) },
    });
    logEvent('x', { n: 1 });
    await Promise.resolve();
    expect(seen).toHaveLength(0);
  });

  it('telemetryEnabled:true → events flow', async () => {
    const seen: TelemetryEvent[] = [];
    installTelemetry({
      getTelemetryEnabled: () => true,
      sink: { write: (e) => seen.push(e) },
    });
    logEvent('x', { n: 1 });
    await Promise.resolve();
    expect(seen).toEqual([{ name: 'x', metadata: { n: 1 } }]);
  });

  it('live gate: a runtime toggle takes effect without re-install', async () => {
    let enabled = false;
    const seen: TelemetryEvent[] = [];
    installTelemetry({
      getTelemetryEnabled: () => enabled,
      sink: { write: (e) => seen.push(e) },
    });
    logEvent('a', { n: 1 });
    enabled = true; // simulate config toggle / server hot-reload
    logEvent('b', { n: 2 });
    await Promise.resolve();
    expect(seen.map((e) => e.name)).toEqual(['b']);
  });

  it('APPLEPI_NO_TELEMETRY forces off even if telemetryEnabled:true', async () => {
    process.env.APPLEPI_NO_TELEMETRY = '1';
    const seen: TelemetryEvent[] = [];
    installTelemetry({
      getTelemetryEnabled: () => true,
      sink: { write: (e) => seen.push(e) },
    });
    logEvent('x', { n: 1 });
    await Promise.resolve();
    expect(seen).toHaveLength(0);
  });
});
