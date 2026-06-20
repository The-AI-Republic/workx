import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOtelSink, isOtelSinkEnabled } from '../otel/OtelSink';
import { teeSinks } from '../TeeSink';
import type { TelemetryEvent } from '../analytics';

describe('Phase 4: OTLP sink ships dark', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.WORKX_OTEL_TELEMETRY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('disabled by default — createOtelSink returns null', () => {
    expect(isOtelSinkEnabled()).toBe(false);
    expect(createOtelSink()).toBeNull();
  });

  it('still null with only the flag (no endpoint) or only an endpoint', () => {
    process.env.WORKX_OTEL_TELEMETRY = '1';
    expect(createOtelSink()).toBeNull();
    delete process.env.WORKX_OTEL_TELEMETRY;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    expect(createOtelSink()).toBeNull();
  });

  it('opted in → batches and POSTs OTLP/HTTP, fire-and-forget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.WORKX_OTEL_TELEMETRY = '1';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/';

    const sink = createOtelSink();
    expect(sink).not.toBeNull();
    sink!.write({ name: 'tool.exec.end', metadata: { success: true, duration: 9 } });
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://collector:4318/v1/logs');
    const body = JSON.parse((init as { body: string }).body);
    const rec =
      body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.body.stringValue).toBe('tool.exec.end');
  });

  it('write never throws even if fetch is broken', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('no fetch');
    });
    process.env.WORKX_OTEL_TELEMETRY = 'true';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://c:4318';
    const sink = createOtelSink()!;
    expect(() => sink.write({ name: 'x', metadata: {} })).not.toThrow();
  });

  it('teeSinks fans out and isolates a throwing sink', () => {
    const a: TelemetryEvent[] = [];
    const tee = teeSinks(
      {
        write: () => {
          throw new Error('boom');
        },
      },
      { write: (e) => a.push(e) },
    );
    expect(() => tee.write({ name: 'e', metadata: { n: 1 } })).not.toThrow();
    expect(a).toEqual([{ name: 'e', metadata: { n: 1 } }]);
  });
});
