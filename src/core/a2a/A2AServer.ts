/**
 * A2A Server
 *
 * Exposes the local agent as an A2A-compatible server so remote A2A agents can
 * discover (agent card) and delegate work (`message/send`) to this instance's
 * `RepublicAgent`.
 *
 * Implements FR-6 of the WorkX Server Decoupling design
 * (.ai_design/workx_server_decoupling/design.md): a headless A2A endpoint that
 * the existing desktop A2A client can connect to with no desktop change.
 *
 * The SDK plumbing (agent card, JSON-RPC handler, task store, executor) lives
 * here; the bridge to the actual agent runtime is injected via
 * {@link A2AAgentBridge} so this module stays free of bootstrap/registry
 * internals and is unit-testable with a mock bridge.
 *
 * @module core/a2a/A2AServer
 */

import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import type { AgentCard, AgentSkill, Part, Task } from '@a2a-js/sdk';

/**
 * The result of running a single delegated turn on the local agent.
 */
export interface A2ATurnResult {
  /** Final assistant text for the turn (may be empty). */
  text: string;
  /** True when the turn completed normally (not aborted / errored). */
  success: boolean;
  /** Error message when the turn failed. */
  error?: string;
}

/**
 * Bridge between the A2A server and the local agent runtime.
 *
 * The bootstrap supplies the concrete implementation (backed by the
 * SessionManager + event tap); tests supply a mock.
 */
export interface A2AAgentBridge {
  /**
   * Run one delegated turn on the local agent and resolve with the final
   * assistant text. Implementations should honour `signal` for cancellation.
   */
  runTurn(params: {
    text: string;
    contextId: string;
    taskId: string;
    signal: AbortSignal;
  }): Promise<A2ATurnResult>;

  /**
   * Names of tools registered on the local agent, surfaced as agent-card skill
   * tags so remote callers can see (coarsely) what the agent can do.
   */
  listToolNames(): string[];
}

/**
 * Static identity used to build the agent card.
 */
export interface A2AServerIdentity {
  name: string;
  description: string;
  version: string;
  /** Public base URL clients use to reach this agent (JSON-RPC endpoint). */
  url: string;
  /** A2A protocol version. Defaults to {@link DEFAULT_PROTOCOL_VERSION}. */
  protocolVersion?: string;
}

export interface A2AServerOptions {
  bridge: A2AAgentBridge;
  identity: A2AServerIdentity;
}

/** A2A protocol version implemented by this server. */
export const DEFAULT_PROTOCOL_VERSION = '0.3.0';

/** Stable id for the single general-purpose delegation skill. */
const GENERAL_SKILL_ID = 'general';

/**
 * Bridges A2A `message/send` requests into the local agent's turn loop.
 *
 * For each incoming message it extracts the text, runs a single agent turn via
 * the injected bridge, and publishes the result as a terminal `Task` on the
 * SDK event bus. Blocking `message/send` callers receive that task as the
 * response; the desktop A2A client maps it back into the conversation.
 */
class WorkXAgentExecutor implements AgentExecutor {
  private readonly cancellations = new Map<string, AbortController>();

  constructor(private readonly bridge: A2AAgentBridge) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    const text = extractText(userMessage.parts);

    const controller = new AbortController();
    this.cancellations.set(taskId, controller);

    try {
      if (!text.trim()) {
        eventBus.publish(makeTask(taskId, contextId, 'failed', 'No text content in message'));
        return;
      }

      // Publish an initial non-terminal task so the task exists in the store
      // while the (potentially long) turn runs — this is what lets a concurrent
      // tasks/get or tasks/cancel resolve it instead of hitting taskNotFound.
      eventBus.publish(makeTask(taskId, contextId, 'working'));

      const result = await this.bridge.runTurn({
        text,
        contextId,
        taskId,
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        eventBus.publish(makeTask(taskId, contextId, 'canceled'));
        return;
      }

      eventBus.publish(
        makeTask(
          taskId,
          contextId,
          result.success ? 'completed' : 'failed',
          result.success ? undefined : result.error,
          result.text
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      eventBus.publish(makeTask(taskId, contextId, 'failed', message));
    } finally {
      this.cancellations.delete(taskId);
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.cancellations.get(taskId)?.abort();
  }
}

/**
 * A2A server exposing the local agent. Construct with a bridge + identity,
 * then mount {@link getAgentCard} (GET) and {@link handleRpc} (POST) on the
 * host HTTP server.
 */
export class A2AServer {
  private readonly executor: WorkXAgentExecutor;
  private readonly requestHandler: DefaultRequestHandler;
  private readonly jsonRpcHandler: JsonRpcTransportHandler;
  private readonly card: AgentCard;

  constructor(private readonly options: A2AServerOptions) {
    this.card = this.buildAgentCard();
    this.executor = new WorkXAgentExecutor(options.bridge);
    this.requestHandler = new DefaultRequestHandler(
      this.card,
      new InMemoryTaskStore(),
      this.executor
    );
    this.jsonRpcHandler = new JsonRpcTransportHandler(this.requestHandler);
  }

  /**
   * The agent card served at `/.well-known/agent-card.json`.
   */
  getAgentCard(): AgentCard {
    return this.card;
  }

  /**
   * Handle a single JSON-RPC request body (e.g. `message/send`, `tasks/get`,
   * `tasks/cancel`). Streaming methods are not supported over this HTTP entry
   * point and yield a JSON-RPC error response.
   */
  async handleRpc(body: unknown): Promise<unknown> {
    const result = await this.jsonRpcHandler.handle(body);

    // Streaming methods (message/stream) return an async generator. This HTTP
    // endpoint is request/response only; surface a clear error rather than
    // hanging the caller. Blocking message/send returns a single response.
    if (isAsyncGenerator(result)) {
      return {
        jsonrpc: '2.0',
        id: (body as { id?: string | number | null })?.id ?? null,
        error: {
          code: -32004,
          message: 'Streaming is not supported on this endpoint; use blocking message/send',
        },
      };
    }

    return result;
  }

  private buildAgentCard(): AgentCard {
    const { identity, bridge } = this.options;
    const toolNames = safeToolNames(bridge);

    const skill: AgentSkill = {
      id: GENERAL_SKILL_ID,
      name: 'General agent task',
      description:
        'Delegate a natural-language task to this WorkX agent. The agent plans and ' +
        'executes using its available tools and returns the result.',
      tags: ['general', 'delegation', ...toolNames].slice(0, 32),
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    };

    return {
      protocolVersion: identity.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      name: identity.name,
      description: identity.description,
      url: identity.url,
      preferredTransport: 'JSONRPC',
      version: identity.version,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [skill],
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Concatenate the text parts of an A2A message. */
function extractText(parts: Part[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Build a terminal A2A Task to publish on the event bus. */
function makeTask(
  taskId: string,
  contextId: string,
  state: 'working' | 'submitted' | 'completed' | 'failed' | 'canceled',
  errorMessage?: string,
  responseText?: string
): Task {
  const task: Task = {
    kind: 'task',
    id: taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(errorMessage
        ? {
            message: {
              kind: 'message',
              role: 'agent',
              messageId: crypto.randomUUID(),
              parts: [{ kind: 'text', text: errorMessage }],
            },
          }
        : {}),
    },
  };

  if (responseText && responseText.length > 0) {
    task.artifacts = [
      {
        artifactId: crypto.randomUUID(),
        name: 'response',
        parts: [{ kind: 'text', text: responseText }],
      },
    ];
  }

  return task;
}

function safeToolNames(bridge: A2AAgentBridge): string[] {
  try {
    return bridge.listToolNames();
  } catch {
    return [];
  }
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncGenerator<unknown>)[Symbol.asyncIterator] === 'function'
  );
}
