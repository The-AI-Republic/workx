import { EventEmitter } from 'node:events';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import type { DesktopRuntimeFrame } from './frames';

/** Hard cap on a single frame payload (and on an unframed header run). */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class StdioFrameCarrier extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private started = false;

  constructor(
    private readonly input: Readable = defaultStdin,
    private readonly output: Writable = defaultStdout,
  ) {
    super();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.on('data', this.onData);
    this.input.on('end', () => this.emit('end'));
    this.input.on('error', (error) => this.emit('error', error));
  }

  stop(): void {
    if (!this.started) return;
    this.input.off('data', this.onData);
    this.started = false;
  }

  send(frame: DesktopRuntimeFrame): void {
    const payload = Buffer.from(JSON.stringify(frame), 'utf-8');
    this.output.write(`${payload.length}\n`);
    this.output.write(payload);
  }

  onFrame(handler: (frame: DesktopRuntimeFrame) => void): () => void {
    this.on('frame', handler);
    return () => this.off('frame', handler);
  }

  private onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        // No frame header yet. Guard against an unbounded run of bytes with no
        // newline (a peer that never frames) exhausting memory.
        if (this.buffer.length > MAX_FRAME_BYTES) {
          this.emit('error', new Error('Frame header exceeds maximum size; dropping buffer'));
          this.buffer = Buffer.alloc(0);
        }
        return;
      }

      const lengthText = this.buffer.subarray(0, newline).toString('utf-8').trim();
      const length = Number(lengthText);
      if (!/^\d+$/.test(lengthText) || !Number.isInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
        // Resync: drop only the bad header line and keep scanning, so one stray
        // non-frame line (e.g. a stray stdout write) cannot kill the stream.
        this.emit('error', new Error(`Invalid frame length: ${JSON.stringify(lengthText)}`));
        this.buffer = this.buffer.subarray(newline + 1);
        continue;
      }

      const frameStart = newline + 1;
      const frameEnd = frameStart + length;
      if (this.buffer.length < frameEnd) return;

      const payload = this.buffer.subarray(frameStart, frameEnd).toString('utf-8');
      this.buffer = this.buffer.subarray(frameEnd);

      try {
        this.emit('frame', JSON.parse(payload) as DesktopRuntimeFrame);
      } catch (error) {
        this.emit('error', error);
      }
    }
  };
}
