import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import type {
  ChannelCapabilities,
  ChannelEvent,
  ChannelType,
  SubmissionContext,
  SubmissionHandler,
} from '@/core/channels/types';
import type { DesktopRuntimeFrame } from '../protocol/frames';
import { StdioFrameCarrier } from '../protocol/stdioCarrier';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class StdioRuntimeChannel implements ChannelAdapter {
  readonly channelId = 'desktop-runtime-main';
  readonly channelType: ChannelType = 'tauri';

  private submissionHandler: SubmissionHandler | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private unlisten: (() => void) | null = null;

  constructor(private readonly carrier: StdioFrameCarrier) {}

  async initialize(): Promise<void> {
    this.connectionState = 'connecting';
    this.unlisten = this.carrier.onFrame((frame) => {
      void this.handleFrame(frame);
    });
    this.connectionState = 'connected';
  }

  async shutdown(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    this.submissionHandler = null;
    this.connectionState = 'disconnected';
  }

  onSubmission(handler: SubmissionHandler): void {
    this.submissionHandler = handler;
  }

  async sendEvent(event: ChannelEvent): Promise<void> {
    this.carrier.send({ type: 'event', event });
  }

  supportsStreaming(): boolean {
    return true;
  }

  supportsApprovals(): boolean {
    return true;
  }

  supportsMedia(): boolean {
    return true;
  }

  supportsServices(): boolean {
    return true;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: true,
      approvals: true,
      media: true,
      services: true,
    };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  private async handleFrame(frame: DesktopRuntimeFrame): Promise<void> {
    if (frame.type === 'ping') {
      this.carrier.send({ type: 'pong', id: frame.id, ts: Date.now() });
      return;
    }

    if (frame.type === 'request') {
      if (!this.submissionHandler) {
        this.carrier.send({ type: 'response', id: frame.id, ok: false, error: 'No submission handler registered' });
        return;
      }

      const context: SubmissionContext = {
        channelId: this.channelId,
        channelType: this.channelType,
        ...frame.context,
      };

      try {
        await this.submissionHandler(frame.op, context);
        this.carrier.send({ type: 'response', id: frame.id, ok: true });
      } catch (error) {
        this.carrier.send({
          type: 'response',
          id: frame.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
