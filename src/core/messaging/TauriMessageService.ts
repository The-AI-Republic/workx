/**
 * Tauri Desktop Message Service
 *
 * Implementation of IMessageService for Tauri desktop apps.
 * Uses Tauri's event system for UI ↔ Agent communication.
 *
 * In desktop mode, both UI and agent run in the same WebView process.
 * This service:
 * 1. Emits submissions to 'pi:submit' for TauriChannel to receive
 * 2. Listens for events on 'pi:event' from TauriChannel
 * 3. Delegates queries (HEALTH_CHECK, etc.) to the DesktopAgentBootstrap
 *
 * @module core/messaging/TauriMessageService
 */

import { MessageType } from '../MessageRouter';
import type {
  IMessageService,
  MessageHandler,
  Unsubscribe,
  ConnectionState,
  MessageServiceConfig,
} from './types';
import type { EventMsg } from '../protocol/events';
import type { Op } from '../protocol/types';
import type { Skill, InvocationMode } from '../skills/types';
import type { SchedulerJobRecord } from '../models/types/Scheduler';

import { isPayloadRef, retrievePayload } from '@/desktop/channels/LargePayloadStore';

/** Map a SchedulerJobRecord to a summary object for UI */
function toJobSummary(j: SchedulerJobRecord) {
  return {
    id: j.id,
    input: j.input.slice(0, 100),
    scheduledTime: j.scheduledTime,
    status: j.status,
    createdAt: j.createdAt,
  };
}

// Tauri API types (loaded dynamically)
type TauriEmit = (event: string, payload?: unknown) => Promise<void>;
type TauriListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

// Lazy import to avoid circular dependency
let _agentBootstrap: any = null;
async function getAgentBootstrap() {
  if (!_agentBootstrap) {
    const module = await import('@/desktop/agent/DesktopAgentBootstrap');
    _agentBootstrap = module.getDesktopAgentBootstrap();
  }
  return _agentBootstrap;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<MessageServiceConfig> = {
  maxRetries: 3,
  retryDelay: 100,
  timeout: 30000,
};

/**
 * Tauri desktop message service implementation
 */
export class TauriMessageService implements IMessageService {
  private config: Required<MessageServiceConfig>;
  private connectionState: ConnectionState = 'disconnected';
  private handlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private unlistenFunctions: Array<() => void> = [];

  // Tauri APIs (loaded dynamically)
  private emit: TauriEmit | null = null;
  private listen: TauriListen | null = null;

  constructor(config: MessageServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the Tauri message service
   */
  async initialize(): Promise<void> {
    console.log('[TauriMessageService] Initializing...');
    this.connectionState = 'connecting';

    // Dynamically load Tauri APIs
    try {
      const eventModule = await import('@tauri-apps/api/event');
      this.emit = eventModule.emit;
      this.listen = eventModule.listen;

      console.log('[TauriMessageService] Tauri APIs loaded');
    } catch (error) {
      console.error('[TauriMessageService] Failed to load Tauri APIs:', error);
      this.connectionState = 'error';
      throw new Error('Failed to load Tauri APIs');
    }

    // Set up event listeners
    try {
      // Listen for events from agent (via TauriChannel)
      const unlistenEvent = await this.listen<EventMsg>('pi:event', (event) => {
        let payload: EventMsg;
        if (isPayloadRef(event.payload)) {
          payload = retrievePayload(event.payload.__payloadRef) as EventMsg;
        } else {
          payload = event.payload;
        }
        this.handleIncomingEvent(payload);
      });
      this.unlistenFunctions.push(unlistenEvent);

      // Listen for message router events (STATE_UPDATE, etc.)
      const unlistenMessage = await this.listen<{ type: MessageType; payload: unknown }>(
        'pi:message',
        (event) => {
          this.handleIncomingMessage(event.payload);
        }
      );
      this.unlistenFunctions.push(unlistenMessage);

      this.connectionState = 'connected';
      console.log('[TauriMessageService] Connected');
    } catch (error) {
      console.error('[TauriMessageService] Failed to set up listeners:', error);
      this.connectionState = 'error';
      throw error;
    }
  }

  /**
   * Send a message and wait for response
   *
   * Message routing:
   * - SUBMISSION: Emit to 'pi:submit' for agent processing (fire-and-forget)
   * - HEALTH_CHECK, GET_STATE, etc.: Query agent bootstrap directly
   * - Other messages: Handle locally or emit as events
   */
  async send<T = unknown>(type: MessageType, payload?: unknown): Promise<T> {
    // Check if Tauri APIs are available
    if (!this.emit) {
      throw new Error('Tauri APIs not initialized');
    }

    // Route based on message type
    switch (type) {
      case MessageType.SUBMISSION:
        return this.handleSubmission(payload) as T;

      case MessageType.PING:
        return { pong: true } as T;

      case MessageType.HEALTH_CHECK:
        return this.handleHealthCheck() as T;

      case MessageType.GET_STATE:
        return this.handleGetState() as T;

      case MessageType.SESSION_RESET:
        return this.handleSessionReset() as T;

      case MessageType.RESUME_SESSION:
        return this.handleResumeSession(payload) as T;

      case MessageType.INTERRUPT:
        return this.handleInterrupt() as T;

      case MessageType.CONFIG_UPDATE:
        return this.handleConfigUpdate() as T;

      case MessageType.SKILLS_LIST:
      case MessageType.SKILLS_LOAD:
      case MessageType.SKILLS_SAVE:
      case MessageType.SKILLS_DELETE:
      case MessageType.SKILLS_UPDATE_MODE:
      case MessageType.SKILLS_IMPORT:
      case MessageType.SKILLS_EXPORT:
      case MessageType.SKILLS_TRUST:
        return this.handleSkillsMessage(type, payload) as T;

      case MessageType.SCHEDULER_CREATE_DRAFT_JOB:
      case MessageType.SCHEDULER_SCHEDULE_JOB:
      case MessageType.SCHEDULER_TRIGGER_JOB:
      case MessageType.SCHEDULER_CANCEL_JOB:
      case MessageType.SCHEDULER_COMPLETE_JOB:
      case MessageType.SCHEDULER_FAIL_JOB:
      case MessageType.SCHEDULER_PAUSE_QUEUE:
      case MessageType.SCHEDULER_RESUME_QUEUE:
      case MessageType.SCHEDULER_GET_DRAFT_JOBS:
      case MessageType.SCHEDULER_GET_SCHEDULED_JOBS:
      case MessageType.SCHEDULER_GET_MISSED_JOBS:
      case MessageType.SCHEDULER_GET_QUEUE:
      case MessageType.SCHEDULER_GET_ARCHIVED_JOBS:
      case MessageType.SCHEDULER_GET_STATE:
      case MessageType.SCHEDULER_GET_JOB_DETAILS:
        return this.handleSchedulerMessage(type, payload) as T;

      default:
        // For other message types, emit as event and return success
        console.log('[TauriMessageService] Emitting message:', type);
        await this.emit('pi:message', { type, payload });
        return { success: true } as T;
    }
  }

  /**
   * Handle submission - emit to 'pi:submit' for TauriChannel
   */
  private async handleSubmission(payload: unknown): Promise<{ success: boolean }> {
    if (!this.emit) {
      throw new Error('Emit not available');
    }

    const submission = payload as { op: Op; context?: { tabId?: number } };

    console.log('[TauriMessageService] Emitting submission:', submission.op?.type);

    // Emit to 'pi:submit' which TauriChannel listens for
    await this.emit('pi:submit', {
      op: submission.op,
      context: submission.context,
    });

    return { success: true };
  }

  /**
   * Handle health check by querying agent bootstrap
   */
  private async handleHealthCheck(): Promise<unknown> {
    try {
      const bootstrap = await getAgentBootstrap();
      const readyState = await bootstrap.getReadyState();

      return {
        type: MessageType.HEALTH_STATUS,
        ready: readyState.ready,
        message: readyState.message || 'Desktop mode',
        provider: readyState.provider || 'unknown',
        model: readyState.model || 'unknown',
        authMode: readyState.authMode || 'api_key',
      };
    } catch (error) {
      console.error('[TauriMessageService] Health check failed:', error);
      return {
        type: MessageType.HEALTH_STATUS,
        ready: false,
        message: error instanceof Error ? error.message : 'Health check failed',
        authMode: 'none',
      };
    }
  }

  /**
   * Handle get state request
   */
  private async handleGetState(): Promise<unknown> {
    try {
      const bootstrap = await getAgentBootstrap();
      const agent = bootstrap.getAgent();

      if (agent) {
        const session = agent.getSession();
        return {
          tabId: session.getTabId(),
          history: session.getConversationHistory().items,
        };
      }

      return {
        tabId: -1,
        history: [],
      };
    } catch (error) {
      console.error('[TauriMessageService] Get state failed:', error);
      return {
        tabId: -1,
        history: [],
      };
    }
  }

  /**
   * Handle session reset
   */
  private async handleSessionReset(): Promise<{ success: boolean }> {
    try {
      const bootstrap = await getAgentBootstrap();
      const agent = bootstrap.getAgent();

      if (agent) {
        const session = agent.getSession();
        await session.reset();
      }

      return { success: true };
    } catch (error) {
      console.error('[TauriMessageService] Session reset failed:', error);
      return { success: false };
    }
  }

  /**
   * Handle session resume — loads conversation history from rollout storage
   * and recreates the agent with the resumed session.
   */
  private async handleResumeSession(payload: unknown): Promise<unknown> {
    try {
      const { conversationId } = payload as { conversationId: string };
      const bootstrap = await getAgentBootstrap();
      const items = await bootstrap.resumeSession(conversationId);
      return { history: items };
    } catch (error) {
      console.error('[TauriMessageService] Resume session failed:', error);
      return { history: [] };
    }
  }

  /**
   * Handle interrupt request
   */
  private async handleInterrupt(): Promise<{ success: boolean }> {
    try {
      const bootstrap = await getAgentBootstrap();
      const agent = bootstrap.getAgent();

      if (agent) {
        await agent.interrupt();
      }

      return { success: true };
    } catch (error) {
      console.error('[TauriMessageService] Interrupt failed:', error);
      return { success: false };
    }
  }

  /**
   * Handle config update by delegating to DesktopAgentBootstrap
   */
  private async handleConfigUpdate(): Promise<{ success: boolean }> {
    try {
      const bootstrap = await getAgentBootstrap();
      await bootstrap.handleConfigUpdate();
      return { success: true };
    } catch (error) {
      console.error('[TauriMessageService] Config update failed:', error);
      return { success: false };
    }
  }

  /**
   * Handle SKILLS_* messages by delegating to the SkillRegistry
   */
  private async handleSkillsMessage(type: MessageType, payload: unknown): Promise<unknown> {
    const bootstrap = await getAgentBootstrap();
    const registry = bootstrap.getSkillRegistry();
    if (!registry) {
      throw new Error('SkillRegistry not initialized');
    }

    switch (type) {
      case MessageType.SKILLS_LIST:
        return registry.getSkillMetas();

      case MessageType.SKILLS_LOAD: {
        const { name, args } = payload as { name: string; args?: string };
        return registry.invoke(name, args ? args.split(/\s+/) : []);
      }

      case MessageType.SKILLS_SAVE: {
        const skill = payload as Skill;
        await registry.save(skill);
        return { success: true };
      }

      case MessageType.SKILLS_DELETE: {
        const { name } = payload as { name: string };
        await registry.delete(name);
        return { success: true };
      }

      case MessageType.SKILLS_UPDATE_MODE: {
        const { name, mode } = payload as { name: string; mode: InvocationMode };
        await registry.updateInvocationMode(name, mode);
        return { success: true };
      }

      case MessageType.SKILLS_IMPORT: {
        const { url } = payload as { url: string };
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('Only HTTP/HTTPS URLs are supported for skill import');
        }
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch skill from ${url}: ${response.statusText}`);
        }
        const content = await response.text();
        const skill = await registry.importFromContent(content, url);
        return { success: true, skill };
      }

      case MessageType.SKILLS_EXPORT: {
        const { name } = payload as { name: string };
        const content = await registry.export(name);
        return { success: true, content };
      }

      case MessageType.SKILLS_TRUST: {
        const { name } = payload as { name: string };
        await registry.trustSkill(name);
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown skills message type: ${type}` };
    }
  }

  /**
   * Handle SCHEDULER_* messages by delegating to the Scheduler instance
   */
  private async handleSchedulerMessage(type: MessageType, payload: unknown): Promise<unknown> {
    const bootstrap = await getAgentBootstrap();
    const scheduler = bootstrap.getScheduler();
    if (!scheduler) {
      throw new Error('Scheduler not initialized');
    }
    const storage = scheduler.getStorage();

    switch (type) {
      case MessageType.SCHEDULER_CREATE_DRAFT_JOB: {
        const { input } = payload as { input: string };
        const jobId = await scheduler.createDraftJob(input);
        return { success: true, jobId };
      }

      case MessageType.SCHEDULER_SCHEDULE_JOB: {
        const { input, jobId, scheduledTime } = payload as { input?: string; jobId?: string; scheduledTime: number };
        if (jobId) {
          await scheduler.scheduleExistingJob(jobId, scheduledTime);
          return { success: true, jobId };
        } else if (input) {
          const newJobId = await scheduler.scheduleJob(input, scheduledTime);
          return { success: true, jobId: newJobId };
        } else {
          return { success: false, error: 'Either input or jobId is required' };
        }
      }

      case MessageType.SCHEDULER_TRIGGER_JOB: {
        const { jobId } = payload as { jobId: string };
        await scheduler.triggerJob(jobId);
        return { success: true };
      }

      case MessageType.SCHEDULER_CANCEL_JOB: {
        const { jobId } = payload as { jobId: string };
        await scheduler.cancelJob(jobId);
        return { success: true };
      }

      case MessageType.SCHEDULER_COMPLETE_JOB: {
        const { jobId, result } = payload as { jobId: string; result: any };
        await scheduler.completeJob(jobId, result);
        return { success: true };
      }

      case MessageType.SCHEDULER_FAIL_JOB: {
        const { jobId, error } = payload as { jobId: string; error: string };
        await scheduler.failJob(jobId, error);
        return { success: true };
      }

      case MessageType.SCHEDULER_PAUSE_QUEUE:
        await scheduler.pauseJobQueue();
        return { success: true };

      case MessageType.SCHEDULER_RESUME_QUEUE:
        await scheduler.resumeJobQueue();
        return { success: true };

      case MessageType.SCHEDULER_GET_DRAFT_JOBS: {
        const jobs = await storage.getDraftJobs();
        return { jobs: jobs.map(toJobSummary) };
      }

      case MessageType.SCHEDULER_GET_SCHEDULED_JOBS: {
        const jobs = await storage.getScheduledJobs();
        return { jobs: jobs.map(toJobSummary) };
      }

      case MessageType.SCHEDULER_GET_MISSED_JOBS: {
        const jobs = await storage.getMissedJobs();
        return { jobs: jobs.map(toJobSummary) };
      }

      case MessageType.SCHEDULER_GET_QUEUE: {
        const jobs = await storage.getJobQueueJobs();
        return { jobs: jobs.map(toJobSummary) };
      }

      case MessageType.SCHEDULER_GET_ARCHIVED_JOBS: {
        const { limit = 50, offset = 0 } = (payload || {}) as { limit?: number; offset?: number };
        const jobs = await storage.getArchivedJobs(limit, offset);
        return {
          jobs: jobs.map((j: SchedulerJobRecord) => ({
            id: j.id,
            input: j.input.slice(0, 100),
            scheduledTime: j.scheduledTime,
            completedAt: j.completedAt,
            status: j.status,
            sessionId: j.sessionId,
            error: j.error,
          })),
          total: jobs.length,
          hasMore: jobs.length === limit,
        };
      }

      case MessageType.SCHEDULER_GET_STATE:
        return scheduler.getSchedulerState();

      case MessageType.SCHEDULER_GET_JOB_DETAILS: {
        const { jobId } = payload as { jobId: string };
        const job = await storage.getJob(jobId);
        return { job };
      }

      default:
        return { success: false, error: `Unknown scheduler message type: ${type}` };
    }
  }

  /**
   * Subscribe to messages of a specific type
   */
  on<T = unknown>(type: MessageType, handler: MessageHandler<T>): Unsubscribe {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as MessageHandler);

    return () => {
      this.off(type, handler as MessageHandler);
    };
  }

  /**
   * Remove a message handler
   */
  off(type: MessageType, handler: MessageHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    console.log('[TauriMessageService] Destroying...');

    // Remove event listeners
    for (const unlisten of this.unlistenFunctions) {
      unlisten();
    }
    this.unlistenFunctions = [];

    // Clear handlers
    this.handlers.clear();

    this.connectionState = 'disconnected';
  }

  /**
   * Handle incoming events from agent (via TauriChannel)
   *
   * Events are dispatched to registered handlers and also mapped to MessageType
   * for backwards compatibility with components using MessageRouter patterns.
   *
   * Note: TauriChannel emits EventMsg directly, but UI handlers expect the full
   * Event structure { id, msg }. We wrap the EventMsg here for compatibility.
   */
  private handleIncomingEvent(eventMsg: EventMsg): void {
    if (!eventMsg?.type) return;

    console.log('[TauriMessageService] Received event:', eventMsg.type);

    // Wrap EventMsg in Event structure (id + msg) for UI compatibility
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      msg: eventMsg,
    };

    // Map EventMsg types to MessageType for handler dispatch
    const eventTypeMap: Record<string, MessageType | undefined> = {
      'BackgroundEvent': MessageType.EVENT,
      'TaskStarted': MessageType.EVENT,
      'TaskComplete': MessageType.EVENT,
      'TaskError': MessageType.EVENT,
      'TurnStart': MessageType.EVENT,
      'TurnComplete': MessageType.EVENT,
      'TurnAborted': MessageType.EVENT,
      'ToolCall': MessageType.EVENT,
      'ToolResult': MessageType.EVENT,
      'AssistantText': MessageType.EVENT,
      'AssistantTextDelta': MessageType.RESPONSE_OUTPUT_TEXT_DELTA,
      'ReasoningDelta': MessageType.RESPONSE_REASONING_CONTENT_DELTA,
      'RequestApproval': MessageType.APPROVAL_REQUEST,
      'Error': MessageType.EVENT,
    };

    // Dispatch to EVENT handlers (generic event handler)
    // Pass the wrapped Event object (with id and msg) for UI compatibility
    const eventHandlers = this.handlers.get(MessageType.EVENT);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`[TauriMessageService] EVENT handler error:`, error);
        }
      }
    }

    // Also dispatch to specific type handlers if mapped
    const mappedType = eventTypeMap[eventMsg.type];
    if (mappedType && mappedType !== MessageType.EVENT) {
      const handlers = this.handlers.get(mappedType);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (error) {
            console.error(`[TauriMessageService] Handler error for ${mappedType}:`, error);
          }
        }
      }
    }
  }

  /**
   * Handle incoming messages from DesktopMessageRouter
   */
  private handleIncomingMessage(message: { type: MessageType; payload: unknown }): void {
    if (!message?.type) return;

    const handlers = this.handlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.payload);
        } catch (error) {
          console.error(`[TauriMessageService] Handler error for ${message.type}:`, error);
        }
      }
    }
  }
}
