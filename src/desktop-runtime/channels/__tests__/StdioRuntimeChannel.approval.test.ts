import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopRuntimeFrame } from '../../protocol/frames';
import { StdioFrameCarrier } from '../../protocol/stdioCarrier';
import { StdioRuntimeChannel } from '../StdioRuntimeChannel';

function encodeFrame(frame: DesktopRuntimeFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), 'utf-8');
  return Buffer.concat([Buffer.from(`${payload.length}\n`), payload]);
}

describe('StdioRuntimeChannel approval routing', () => {
  it('preserves the approval session across the production stdio boundary', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputChunks: Buffer[] = [];
    output.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)));

    const carrier = new StdioFrameCarrier(input, output);
    const channel = new StdioRuntimeChannel(carrier);
    const submission = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(submission);
    carrier.start();
    await channel.initialize();

    input.write(encodeFrame({
      type: 'request',
      id: 'request-approval',
      op: {
        type: 'ExecApproval',
        id: 'approval-123',
        decision: 'approve',
      },
      context: { sessionId: 'session-origin' },
    }));

    await vi.waitFor(() => {
      expect(submission).toHaveBeenCalledWith(
        {
          type: 'ExecApproval',
          id: 'approval-123',
          decision: 'approve',
        },
        {
          channelId: 'desktop-runtime-main',
          channelType: 'tauri',
          sessionId: 'session-origin',
        },
      );
      expect(Buffer.concat(outputChunks).toString('utf-8')).toContain(
        '"id":"request-approval","ok":true',
      );
    });

    await channel.shutdown();
    carrier.stop();
  });
});
