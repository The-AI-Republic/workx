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
  it('replays requests that arrive before agent bootstrap registers the channel', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const carrier = new StdioFrameCarrier(input, output);
    const channel = new StdioRuntimeChannel(carrier);
    const submission = vi.fn().mockResolvedValue(undefined);
    carrier.start();

    input.write(encodeFrame({
      type: 'request',
      id: 'request-during-bootstrap',
      op: {
        type: 'ServiceRequest',
        requestId: 'session-list',
        service: 'session.list',
        params: { limit: 30 },
      },
      context: {},
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submission).not.toHaveBeenCalled();

    channel.onSubmission(submission);
    await channel.initialize();
    expect(submission).not.toHaveBeenCalled();
    await channel.activate();

    expect(submission).toHaveBeenCalledWith(
      {
        type: 'ServiceRequest',
        requestId: 'session-list',
        service: 'session.list',
        params: { limit: 30 },
      },
      {
        channelId: 'desktop-runtime-main',
        channelType: 'tauri',
      },
    );

    await channel.shutdown();
    carrier.stop();
  });

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
    await channel.activate();

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
