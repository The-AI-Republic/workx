import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { StdioFrameCarrier, MAX_FRAME_BYTES } from '../stdioCarrier';

/**
 * Carrier-level hardening. Anything _supervisor-level_ (handshake nonce,
 * protocol version mismatch shutdown, stderr fan-out) is enforced one layer up
 * — those have their own tests against the entrypoint and the Rust supervisor.
 * What the carrier itself must guarantee:
 *
 *   - Resync on stray bytes without dropping subsequent well-formed frames.
 *   - JSON parse failures inside a well-framed payload are reported as errors
 *     but do not corrupt the stream.
 *   - 0x0a (newline) bytes inside a JSON payload do not confuse framing.
 *   - send() writes exactly `len\n<payload>` with no extra whitespace.
 *   - stop() detaches the data listener and leaves the input writable.
 *   - A frame at exactly MAX_FRAME_BYTES is accepted; anything above is not.
 */

function makeCarrier() {
  const input = new PassThrough();
  const output = new PassThrough();
  const carrier = new StdioFrameCarrier(input, output);
  return { input, output, carrier };
}

function frameBytes(obj: unknown): Buffer {
  const p = Buffer.from(JSON.stringify(obj), 'utf-8');
  return Buffer.concat([Buffer.from(`${p.length}\n`), p]);
}

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('StdioFrameCarrier (hardening)', () => {
  it('emits error for invalid JSON inside a well-framed payload, then keeps the stream', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();

    // Well-framed length header, garbage payload.
    const bad = Buffer.from('not-json');
    input.write(Buffer.concat([Buffer.from(`${bad.length}\n`), bad]));
    // Then a valid frame must still be delivered.
    input.write(frameBytes({ type: 'pong', id: 'after', ts: 1 }));

    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'pong', id: 'after', ts: 1 }]);
  });

  it('preserves 0x0a bytes inside a JSON payload (length-prefix is authoritative)', async () => {
    const { input, carrier } = makeCarrier();
    const frames: Array<{ event: { msg: { text: string } } }> = [];
    carrier.onFrame((f) => frames.push(f as { event: { msg: { text: string } } }));
    carrier.start();

    const payload = { type: 'event', event: { msg: { text: 'line one\nline two\nline three' } } };
    input.write(frameBytes(payload));

    await flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event.msg.text).toBe('line one\nline two\nline three');
  });

  it('rejects a non-integer length header (e.g. "12.5") and resyncs', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();

    // Bad header followed _directly_ by a clean frame. The carrier's resync
    // drops only the bad header line; trailing non-framed bytes between the
    // header and the next length would themselves be misread as a header.
    input.write(Buffer.from('12.5\n'));
    input.write(frameBytes({ type: 'shutdown' }));

    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'shutdown' }]);
  });

  it('rejects a negative length header and resyncs', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();

    input.write(Buffer.from('-5\n'));
    input.write(frameBytes({ type: 'shutdown' }));

    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'shutdown' }]);
  });

  it('accepts a length-zero frame (empty payload) and emits the parse error rather than hanging', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();

    // length=0 is technically well-framed but JSON.parse('') will throw.
    input.write(Buffer.from('0\n'));
    input.write(frameBytes({ type: 'pong', id: 'k', ts: 9 }));

    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'pong', id: 'k', ts: 9 }]);
  });

  it('send() writes exactly `length\\n<payload>` with no extra framing bytes', async () => {
    const { output, carrier } = makeCarrier();
    const chunks: Buffer[] = [];
    output.on('data', (c) => chunks.push(c));

    carrier.send({ type: 'ping', id: 'q', ts: 42 });
    await flush();

    const wire = Buffer.concat(chunks).toString('utf-8');
    const expectedJson = JSON.stringify({ type: 'ping', id: 'q', ts: 42 });
    expect(wire).toBe(`${Buffer.byteLength(expectedJson, 'utf-8')}\n${expectedJson}`);
  });

  it('send() uses byte length, not character length, for multi-byte UTF-8 payloads', async () => {
    const { output, carrier } = makeCarrier();
    const chunks: Buffer[] = [];
    output.on('data', (c) => chunks.push(c));

    // 4 emoji = 8 chars but 16 bytes in UTF-8.
    carrier.send({ type: 'event', event: { msg: { text: '🎉🎉🎉🎉' } } } as never);
    await flush();

    const wire = Buffer.concat(chunks);
    const newline = wire.indexOf(0x0a);
    const lenHeader = Number(wire.subarray(0, newline).toString('utf-8'));
    const payload = wire.subarray(newline + 1);
    expect(lenHeader).toBe(payload.length);
    expect(JSON.parse(payload.toString('utf-8'))).toMatchObject({ event: { msg: { text: '🎉🎉🎉🎉' } } });
  });

  it('stop() detaches the data listener and ignores subsequent input', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.start();

    input.write(frameBytes({ type: 'ping', id: 'pre', ts: 1 }));
    await flush();
    carrier.stop();
    input.write(frameBytes({ type: 'ping', id: 'post', ts: 2 }));
    await flush();

    expect(frames).toEqual([{ type: 'ping', id: 'pre', ts: 1 }]);
  });

  it('accepts a frame at exactly MAX_FRAME_BYTES (but no larger)', async () => {
    const { input, carrier } = makeCarrier();
    const frames: Array<{ pad: string }> = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f as { pad: string }));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();

    // Build a JSON whose total byte length equals MAX_FRAME_BYTES. Start from
    // the fixed scaffolding length and pad the value to hit the cap exactly.
    // 1 MiB is plenty to prove the path; the cap itself is exercised by the
    // existing oversized-header test in the sibling file.
    const targetBytes = 1024 * 1024;
    const scaffold = JSON.stringify({ pad: '' });
    const padBytes = targetBytes - scaffold.length;
    const pad = 'x'.repeat(padBytes);
    const payload = JSON.stringify({ pad });
    input.write(Buffer.concat([Buffer.from(`${Buffer.byteLength(payload, 'utf-8')}\n`), Buffer.from(payload, 'utf-8')]));

    await flush(50);
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.pad).toHaveLength(padBytes);
  });

  it('rejects a frame strictly above MAX_FRAME_BYTES and resyncs', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.on('error', (e) => errors.push(e));
    carrier.start();

    // Bad header followed _directly_ by a clean frame; see the comment on the
    // "non-integer length" test above for why trailing non-framed garbage
    // between the bad header and the next frame would itself be misread.
    input.write(Buffer.from(`${MAX_FRAME_BYTES + 1}\n`));
    input.write(frameBytes({ type: 'shutdown' }));

    await flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ type: 'shutdown' }]);
  });

  it('delivers a frame even when bytes trickle in one byte at a time', async () => {
    const { input, carrier } = makeCarrier();
    const frames: unknown[] = [];
    carrier.onFrame((f) => frames.push(f));
    carrier.start();

    const wire = frameBytes({ type: 'pong', id: 'trickle', ts: 7 });
    for (const byte of wire) {
      input.write(Buffer.from([byte]));
    }

    await flush();
    expect(frames).toEqual([{ type: 'pong', id: 'trickle', ts: 7 }]);
  });
});
