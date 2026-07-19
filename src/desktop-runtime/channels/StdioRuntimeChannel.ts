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
type RequestFrame = Extract<DesktopRuntimeFrame, { type: 'request' }>;

const MAX_PENDING_REQUESTS = 256;

export class StdioRuntimeChannel implements ChannelAdapter {
  readonly channelId = 'desktop-runtime-main';
  readonly channelType: ChannelType = 'tauri';

  private submissionHandler: SubmissionHandler | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private unlisten: (() => void) | null = null;
  private activationPromise: Promise<void> | null = null;
  private pendingRequests: RequestFrame[] = [];

  constructor(private readonly carrier: StdioFrameCarrier) {
    // The Rust supervisor completes its transport handshake before the agent
    // bootstrap registers this channel. Subscribe immediately so requests
    // sent during that startup window are retained instead of disappearing.
    this.unlisten = this.carrier.onFrame((frame) => {
      if (frame.type !== 'request') return;
      if (this.connectionState === 'connected' && this.submissionHandler) {
        void this.handleRequest(frame);
        return;
      }
      if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) {
        this.carrier.send({
          type: 'response',
          id: frame.id,
          ok: false,
          error: 'Desktop runtime is still starting and its request buffer is full',
        });
        return;
      }
      this.pendingRequests.push(frame);
    });
  }

  async initialize(): Promise<void> {
    if (this.connectionState === 'disconnected') {
      this.connectionState = 'connecting';
    }
  }

  /**
   * Admit requests only after ServerAgentBootstrap has registered every
   * service. ChannelManager initializes the transport earlier in bootstrap,
   * so treating initialize() itself as readiness would replay session.list
   * into a partially populated ServiceRegistry.
   */
  async activate(): Promise<void> {
    if (this.connectionState === 'connected') return;
    if (this.connectionState === 'disconnected') await this.initialize();
    if (!this.activationPromise) {
      this.activationPromise = this.finishActivation().finally(() => {
        this.activationPromise = null;
      });
    }
    return this.activationPromise;
  }

  async shutdown(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    this.submissionHandler = null;
    this.pendingRequests = [];
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

  private async finishActivation(): Promise<void> {
    // onSubmission() is set by ChannelManager immediately before initialize().
    // Keep the channel in `connecting` while draining so later frames cannot
    // overtake requests that arrived during bootstrap.
    while (this.pendingRequests.length > 0) {
      await this.handleRequest(this.pendingRequests.shift()!);
    }
    this.connectionState = 'connected';
  }

  private async handleRequest(frame: RequestFrame): Promise<void> {
    if (!this.submissionHandler) {
      this.carrier.send({
        type: 'response',
        id: frame.id,
        ok: false,
        error: 'No submission handler registered',
      });
      return;
    }

    const context: SubmissionContext = {
      ...frame.context,
      channelId: this.channelId,
      channelType: this.channelType,
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
