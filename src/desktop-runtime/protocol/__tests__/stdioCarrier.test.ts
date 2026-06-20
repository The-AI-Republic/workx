import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { StdioFrameCarrier, MAX_FRAME_BYTES } from '../stdioCarrier';

function makeCarrier() {
  const input = new PassThrough();
  const output = new PassThrough();
  const carrier = new StdioFrameCarrier(input, output);
  return { input, carrier };
}

function frameBytes(obj: unknown): Buffer {
  const p = Buffer.from(JSON.stringify(obj), 'utf-8');
  return Buffer.concat([Buffer.from(`${p.length}\n`), p]);
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('StdioFrameCarrier', () => {
  it('parses a single frame', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.start();
    input.write(frameBytes({ type: 'ping', id: 'a', ts: 1 }));
    await flush();
    expect(frames).toEqual([{ type: 'ping', id: 'a', ts: 1 }]);
  });

  it('parses multiple frames split across chunk boundaries', async () => {
    const { input, carrier } = makeCarrier();
    const frames: Array<{ id: string }> = [];
    carrier.onFrame((f) => frames.push(f as { id: string }));
    carrier.start();
    const a = frameBytes({ type: 'pong', id: '1', ts: 1 });
    const b = frameBytes({ type: 'pong', id: '2', ts: 2 });
    input.write(Buffer.concat([a, b.subarray(0, 3)]));
    input.write(b.subarray(3));
    await flush();
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
  });

  it('resyncs past a stray non-frame line without dropping later frames', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();
    input.write(Buffer.from('[Bootstrap] stray stdout log line\n'));
    input.write(frameBytes({ type: 'shutdown' }));
    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'shutdown' }]);
  });

  it('rejects an oversized length and resyncs instead of buffering forever', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();
    input.write(Buffer.from(`${MAX_FRAME_BYTES + 1}\n`));
    input.write(frameBytes({ type: 'shutdown' }));
    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'shutdown' }]);
  });
});
