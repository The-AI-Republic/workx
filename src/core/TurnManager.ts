/**
 * TurnManager implementation
 * Manages individual conversation turns, handles model streaming, and coordinates tool calls
 */

import { Session } from './Session';
import type { ToolDefinition } from '../tools/BaseTool';
import { SUBMIT_PLAN_TOOL_NAME } from '../tools/planReview/types';
import { TurnContext } from './TurnContext';
import { withModelRetry } from './models/resilience/withRetry';
import { calculateUSDCost } from './models/cost/cost';
import { AgentConfig } from '../config/AgentConfig';
import { combineUserAndProjectInstructions, loadProjectInstructions, loadPrompt } from './PromptLoader';
import type { EventMsg, TokenUsage, StreamErrorEvent } from './protocol/events';
import type { Event } from './protocol/types';
import type { Prompt as ModelPrompt } from './models/types/ResponsesAPI';
import { v4 as uuidv4 } from 'uuid';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { IToolsConfig } from '../config/types';
import { mapResponseItemToEventMessages } from './events/EventMapping';
import type { ResponseItem } from './protocol/types';
import { WebSearchTool } from '../tools/WebSearchTool';
import {
  prepareToolCall,
  partitionToolCalls,
  executeToolCallBatches,
  type PreparedToolCall,
} from './toolOrchestration';
import type { HookDispatcher } from './hooks/HookDispatcher';
import type { HookInput } from './hooks/types';
import {
  getPersistenceThreshold,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../tools/toolLimits';
import {
  buildPersistedOutputMessage,
  ToolResultTooLargeForStoreError,
} from '../tools/resultStore';
import {
  enforceToolResultBudget,
  type FunctionCallOutputItem,
} from '../tools/resultBudget';

/**
 * Optional MCP capability interface for sessions that support MCP tools.
 * Used for runtime duck-typing of Session subclasses with MCP support.
 */
interface MCPCapableSession {
  getMcpTools(): Promise<ToolDefinition[]>;
  executeMcpTool(name: string, params: any): Promise<any>;
}

/**
 * Result of processing a single response item
 */
export interface ProcessedResponseItem {
  /** The response item from the model */
  item: any;
  /** Optional response that needs to be sent back to model */
  response?: any;
}

/**
 * Result of a complete turn execution
 */
export interface TurnRunResult {
  /** All processed response items from this turn */
  processedItems: ProcessedResponseItem[];
  /** Total token usage for this turn */
  totalTokenUsage?: TokenUsage;
  /** Track 18: USD cost for this turn, computed from the post-swap model. */
  turnCostUSD?: number;
  /** Track 18: true when the model was absent from the cost table. */
  turnCostEstimated?: boolean;
}

/**
 * Configuration for turn execution
 */
export interface TurnConfig {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Base delay between retries in milliseconds */
  retryDelayMs?: number;
  /** Maximum delay between retries in milliseconds */
  maxRetryDelayMs?: number;
}


/**
 * Prompt structure for model requests
 */
export interface Prompt {
  /** Input messages/items for this turn */
  input: any[];
  /** Available tools */
  tools: ToolDefinition[];
  /** Override base instructions */
  baseInstructionsOverride?: string;
}

/**
 * TurnManager handles execution of individual conversation turns
 */
export class TurnManager {
  private session: Session;
  private turnContext: TurnContext;
  private toolRegistry: ToolRegistry;
  private config: TurnConfig;
  private cancelled = false;
  private nativeWebSearchEnabled = false;
  private hookDispatcher: HookDispatcher | null = null;

  constructor(
    session: Session,
    turnContext: TurnContext,
    toolRegistry: ToolRegistry,
    config: TurnConfig = {}
  ) {
    this.session = session;
    this.turnContext = turnContext;
    this.toolRegistry = toolRegistry;
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      maxRetryDelayMs: 30000,
      ...config,
    };
  }

  /**
   * Set the hook dispatcher for pre/post tool use hooks.
   */
  setHookDispatcher(dispatcher: HookDispatcher): void {
    this.hookDispatcher = dispatcher;
  }

  /**
   * Cancel the current turn
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Check if turn is cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Run a complete turn with retry logic
   */
  async runTurn(input: any[]): Promise<TurnRunResult> {
    // Build tools list from turn context
    const tools = await this.buildToolsFromContext();

    // Reload the system prompt per turn so dynamic prompt extensions (notably the
    // memory extension that injects core-memory.md) reflect the latest state.
    // loadPrompt() is in-memory templating with no I/O, so the cost is negligible.
    // Falls back to the value cached on TurnContext if reload throws.
    let baseInstructions: string | undefined;
    try {
      baseInstructions = await loadPrompt(this.turnContext.getAgentMode());
    } catch (err) {
      console.warn('[TurnManager] loadPrompt() failed, reusing cached base instructions:', err);
      baseInstructions = this.turnContext.getBaseInstructions();
    }
    const projectInstructions = await loadProjectInstructions(this.session.getWorkspaceRoot?.());
    const userInstructions = combineUserAndProjectInstructions(
      this.turnContext.getUserInstructions(),
      projectInstructions,
    );

    const prompt: ModelPrompt = {
      input,
      tools,
      base_instructions_override: baseInstructions,
      user_instructions: userInstructions,
    };

    const maxRetries = this.config.maxRetries || 3;

    // Track 12: resolve the configured fallback model (composite key) once per
    // turn. On sustained provider overload the orchestrator swaps to it.
    let fallbackModelKey: string | undefined;
    try {
      const agentConfig = await AgentConfig.getInstance();
      const currentKey = this.turnContext.getSelectedModelKey();
      fallbackModelKey = agentConfig.getModelByKey(currentKey)?.model
        .fallbackModelKey;
    } catch {
      fallbackModelKey = undefined;
    }

    // Track 12: a single retry orchestrator wraps the whole turn. Each retry
    // re-runs tryRunTurn from rebuilt clean history (browserx records history
    // only on turn success — orphan-free by construction).
    try {
      return await withModelRetry(() => this.tryRunTurn(prompt), {
        maxRetries,
        unattended: this.turnContext.getUnattended(),
        resetCapMs: this.turnContext.getUnattendedResetCapMs(),
        currentModel: () => this.turnContext.getSelectedModelKey(),
        fallback: fallbackModelKey
          ? {
              // Only downgrade once: once we're on the fallback model,
              // resolve returns undefined so the orchestrator falls through
              // to normal retry/persistent handling.
              resolveFallbackModel: () =>
                fallbackModelKey &&
                this.turnContext.getSelectedModelKey() !== fallbackModelKey
                  ? fallbackModelKey
                  : undefined,
              applyFallbackModel: (model) => {
                this.session.updateTurnContext({ model });
                this.turnContext.setSelectedModelKey(model);
              },
              onDowngrade: async (from, to) => {
                await this.emitEvent({
                  type: 'ModelDowngraded',
                  data: {
                    from_model: from,
                    to_model: to,
                    reason:
                      'sustained provider overload (consecutive 529 responses)',
                  },
                });
              },
            }
          : undefined,
        isCancelled: () => this.cancelled,
        isNonRetryable: (error) => this.isNonRetryableError(error),
        computeBackoffMs: (attempt, error) =>
          this.calculateRetryDelay(attempt, error),
        onRetryNotice: async (error, attempt, delayMs) => {
          const summary = this.extractStreamErrorSummary(error);
          await this.emitStreamError(
            `Stream error: ${summary}`,
            true,
            attempt,
            delayMs,
            this.config.maxRetries
          );
        },
        onWait: async (info) => {
          await this.emitEvent({
            type: 'RateLimitWaiting',
            data: {
              delay_ms: info.delayMs,
              attempt: info.attempt,
              status_code: info.statusCode,
              kind: info.kind,
            },
          });
        },
        sleep: (ms) => this.sleep(ms),
      });
    } catch (error) {
      if (this.cancelled) {
        throw new Error('Turn cancelled');
      }
      throw error;
    }
  }

  /**
   * Attempt to run a turn once (without retry logic)
   */
  private async tryRunTurn(prompt: ModelPrompt): Promise<TurnRunResult> {
    // Record turn context
    await this.recordTurnContext();

    // Process missing call IDs (calls that were interrupted)
    const processedPrompt = this.processMissingCalls(prompt);

    // Start model streaming (using new Prompt-based stream() API)
    const stream = await this.turnContext.getModelClient().stream(processedPrompt);

    const processedItems: ProcessedResponseItem[] = [];
    let totalTokenUsage: TokenUsage | undefined;

    // Track 11: only buffer/orchestrate when the feature is enabled. With
    // the flag off (default) the model is told not to parallelize, so there
    // is never more than one function_call — buffering would only add the
    // interrupt-before-Completed behavior change for zero benefit. Keep the
    // original immediate-execution path byte-for-byte in the default case.
    const parallelToolCallsEnabled =
      this.turnContext.getToolsConfig?.()?.parallelToolCalls === true;

    // Track 11: OpenAI Responses API / xAI emit N separate `function_call`
    // output items for parallel tool calls (Chat Completions providers
    // accumulate into one `message` item — handled by the orchestrator path
    // in handleResponseItem). Buffer the legacy items and run them through
    // Track 02's orchestrator at `Completed` instead of executing each
    // sequentially as it arrives.
    //
    // `bufferedEntries` are placeholder ProcessedResponseItem objects pushed
    // into processedItems at the stream position the function_call arrived,
    // so a non-tool item arriving between calls cannot reorder results
    // relative to it. Responses fill in at `Completed`.
    const bufferedToolCalls: any[] = [];
    const bufferedEntries: ProcessedResponseItem[] = [];

    try {
      // Process streaming response
      // Loop processes ResponseEvent items from the model stream.
      // We must inspect *both* Ok and Err cases so that transient stream failures
      // bubble up and trigger the caller's retry logic.
      for await (const event of stream) {
        // Check for cancellation
        if (this.cancelled) {
          throw new Error('Turn cancelled');
        }

        // Handle null/undefined event (stream closed without completion)
        if (!event) {
          throw new Error('stream closed before response.completed');
        }

        // Process the event based on ResponseEvent type
        switch (event.type) {
          case 'Created':
            // Initial event, no action needed
            break;

          case 'OutputItemDone': {
            // Annotate assistant messages with the composite model key (providerId:modelId)
            if (event.item?.type === 'message' && event.item?.role === 'assistant') {
              event.item.modelKey = this.turnContext.getSelectedModelKey();
            }

            // Track 11: when enabled, defer legacy `function_call` items so a
            // parallel batch runs through the concurrency orchestrator at
            // `Completed` rather than executing each one sequentially here.
            // Non-tool items (message/reasoning/web_search) keep immediate
            // handling. Push a placeholder now to lock the stream position;
            // its `response` is filled when the buffer flushes at `Completed`.
            if (parallelToolCallsEnabled && event.item?.type === 'function_call') {
              const entry: ProcessedResponseItem = { item: event.item };
              processedItems.push(entry);
              bufferedToolCalls.push(event.item);
              bufferedEntries.push(entry);
              break;
            }

            // Item (message or unified tool_calls) is complete
            const response = await this.handleResponseItem(event.item);
            processedItems.push({
              item: event.item,
              response,
            });
            break;
          }

          case 'WebSearchCallBegin':
            // Web search started
            await this.emitEvent({
              type: 'WebSearchBegin',
              data: { call_id: event.callId },
            });
            break;

          case 'RateLimits':
            // Track 12: forward the parsed snapshot to the session so the
            // dead-data fix + early warning actually fire (previously
            // dropped here, leaving TokenCount/RateLimitWarning inert).
            await this.session.recordRateLimits(event.snapshot);
            break;

          case 'Completed': {
            // Stream completed with final token usage
            totalTokenUsage = event.tokenUsage;

            // Track 18: compute this turn's USD cost from the model that
            // actually served it. getSelectedModelKey() reflects any Track 12
            // mid-turn downgrade (applyFallbackModel calls setSelectedModelKey),
            // so a fallback model is priced (or flagged estimated) correctly.
            let turnCostUSD: number | undefined;
            let turnCostEstimated: boolean | undefined;
            if (totalTokenUsage) {
              const cost = calculateUSDCost(
                this.turnContext.getSelectedModelKey(),
                totalTokenUsage,
              );
              turnCostUSD = cost.costUSD;
              turnCostEstimated = cost.estimated;
            }

            // Track 11: flush buffered legacy `function_call` items through
            // Track 02's orchestrator (safe calls concurrent, unsafe
            // sequential, results in original call order). Results are
            // written back into the position-preserving placeholders so
            // ordering relative to any interleaved item is exact. The
            // placeholders were already in processedItems, so the
            // `lastTurnHadToolCalls` detection below still sees them.
            if (bufferedToolCalls.length > 0) {
              const results = await this.executeBufferedToolCalls(bufferedToolCalls);
              // results, bufferedToolCalls, and bufferedEntries are
              // index-aligned by invariant (pushed in lockstep; the
              // orchestrator preserves input order). Drive the loop off
              // results.length as the single source of truth.
              for (let i = 0; i < results.length; i++) {
                bufferedEntries[i]!.response = results[i];
              }
              bufferedToolCalls.length = 0;
              bufferedEntries.length = 0;
            }

            // Track 05b: fire post-turn hooks before returning. Hooks are
            // owned by Session (since TurnManager is per-task but post-turn
            // listeners — notably the session-summary extractor — live the
            // length of the session). Errors are swallowed inside
            // firePostTurnHooks so a misbehaving hook can't break the turn.
            //
            // Defensive `typeof` checks: many existing test fixtures mock
            // Session without these methods. In production the real Session
            // class always provides them; in tests we no-op gracefully.
            const sess = this.session as unknown as {
              firePostTurnHooks?: (ctx: unknown) => Promise<void>;
              getSessionId?: () => string;
              getConversationHistory?: () => { items: unknown[] };
            };
            if (typeof sess.firePostTurnHooks === 'function') {
              const lastTurnHadToolCalls = processedItems.some(
                (p) =>
                  p.item?.type === 'function_call' ||
                  p.item?.type === 'custom_tool_call',
              );
              const historyItems =
                typeof sess.getConversationHistory === 'function'
                  ? sess.getConversationHistory().items
                  : [];
              const sessionId =
                typeof sess.getSessionId === 'function'
                  ? sess.getSessionId()
                  : '';
              await sess.firePostTurnHooks({
                sessionId,
                history: historyItems,
                totalTokenUsage,
                lastTurnHadToolCalls,
              });
            }

            return {
              processedItems,
              totalTokenUsage,
              turnCostUSD,
              turnCostEstimated,
            };
          }

          case 'OutputTextDelta':
            // Streaming text delta
            await this.emitEvent({
              type: 'AgentMessageDelta',
              data: { delta: event.delta },
            });
            break;

          case 'ReasoningSummaryDelta':
            // Reasoning summary delta (for o1/o3 models)
            // Map to AgentReasoningDelta so the UI can accumulate into a single reasoning block
            await this.emitEvent({
              type: 'AgentReasoningDelta',
              data: { delta: event.delta },
            });
            break;

          case 'ReasoningContentDelta':
            // Reasoning content delta (for o1/o3 models)
            await this.emitEvent({
              type: 'AgentReasoningDelta',
              data: { delta: event.delta },
            });
            break;

          case 'ReasoningSummaryPartAdded':
            // Reasoning summary section break - UI handles accumulation
            await this.emitEvent({
              type: 'AgentReasoningSectionBreak',
              data: {},
            });
            break;

          default:
            console.warn('Unknown ResponseEvent type:', event);
        }
      }

      // If loop exits without Completed event, stream was closed prematurely
      throw new Error('stream closed before response.completed');

    } catch (error) {
      // Handle streaming errors
      if (error instanceof Error && (error.message?.includes('stream closed') || error.name === 'StreamError')) {
        throw new Error(`Stream error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Build tools list from turn context and session
   */
  private async buildToolsFromContext(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    // Get tools configuration from turn context
    const toolsConfig = this.turnContext.getToolsConfig() as IToolsConfig;

    // Get all registered browser tools from ToolRegistry
    const registeredTools = this.toolRegistry.listTools();

    // Check if all tools should be enabled
    const enableAllTools = toolsConfig.enable_all_tools ?? false;

    // Add browser tools from registry based on config
    for (const toolDef of registeredTools) {
      // Extract tool name based on type
      let toolName: string;
      if (toolDef.type === 'function') {
        toolName = toolDef.function.name;
      } else if (toolDef.type === 'local_shell') {
        toolName = 'local_shell';
      } else if (toolDef.type === 'web_search') {
        toolName = 'web_search';
      } else if (toolDef.type === 'custom') {
        toolName = toolDef.custom.name;
      } else {
        console.warn('[TurnManager] Unknown tool type, skipping:', toolDef);
        continue;
      }

      // Check if tool is explicitly disabled
      const isDisabled = toolsConfig.disabled?.includes(toolName);

      if (!isDisabled) {
        // Tools are already in the correct ToolDefinition format
        // Just pass them through directly
        tools.push(toolDef);
      }
    }

    // Add agent execution tools based on config
    // Only add web_search if not already registered in ToolRegistry
    const hasWebSearch = tools.some(t =>
      (t.type === 'function' && t.function.name === 'web_search') || t.type === 'web_search'
    );
    if (!hasWebSearch && (enableAllTools || toolsConfig.webSearch)) {
      const modelClient = this.turnContext.getModelClient();
      const useNative = toolsConfig.useNativeWebSearch !== false;
      this.nativeWebSearchEnabled = useNative && modelClient.supportsNativeWebSearch();

      if (this.nativeWebSearchEnabled) {
        // Native provider web search — handled server-side
        tools.push({ type: 'web_search' });
      } else {
        // CDP fallback — function tool triggers local scraping
        tools.push({
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web for information',
            strict: false,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
              required: ['query'],
            },
          },
        });
      }
    }

    // Memory tools are registered in the ToolRegistry by RepublicAgent.initialize()
    // and will be included automatically via the registry tool collection above.

    // Add MCP tools if enabled and available
    // Guard MCP calls with capability check to prevent "is not a function" errors
    const mcpSession = this.session as unknown as Partial<MCPCapableSession>;
    if (
      (enableAllTools || toolsConfig.mcpTools === true) &&
      typeof mcpSession.getMcpTools === 'function'
    ) {
      const mcpTools = await mcpSession.getMcpTools();
      // Convert MCP tools to ModelClient format
      const convertedMcpTools = mcpTools.map((tool: any) => ({
        type: 'function' as const,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          strict: tool.function.strict ?? false,
          parameters: tool.function.parameters || { type: 'object' as const, properties: {} },
        },
      }));
      tools.push(...convertedMcpTools);
    }

    // Add custom tools if configured
    if (toolsConfig.customTools) {
      for (const [toolName, isEnabled] of Object.entries(toolsConfig.customTools)) {
        if (isEnabled || enableAllTools) {
          // Custom tools would be loaded from registry or another source
          const customTool = this.toolRegistry.getTool(toolName);
          if (customTool) {
            if (customTool.type === 'function') {
              tools.push({
                type: 'function',
                function: {
                  name: customTool.function.name,
                  description: customTool.function.description,
                  strict: customTool.function.strict ?? false,
                  parameters: customTool.function.parameters || { type: 'object' as const, properties: {} },
                },
              });
            }
          }
        }
      }
    }

    return tools;
  }

  /**
   * Process missing call IDs and add synthetic aborted responses
   */
  private processMissingCalls(prompt: ModelPrompt): ModelPrompt {
    const completedCallIds = new Set<string>();
    const pendingCallIds = new Set<string>();

    // Collect call IDs
    for (const item of prompt.input) {
      if (item.type === 'function_call_output' && item.call_id) {
        completedCallIds.add(item.call_id);
      }
      if (item.type === 'function_call' && item.call_id) {
        pendingCallIds.add(item.call_id);
      }
    }

    // Find missing calls
    const missingCallIds = [...pendingCallIds].filter(id => !completedCallIds.has(id));

    if (missingCallIds.length === 0) {
      return prompt;
    }

    // Add synthetic aborted responses for missing calls
    const syntheticResponses = missingCallIds.map(callId => ({
      type: 'function_call_output' as const,
      call_id: callId,
      output: 'aborted',
    }));

    return {
      ...prompt,
      input: [...syntheticResponses, ...prompt.input],
    };
  }

  /**
   * Handle a complete response item from the model
   */
  private async handleResponseItem(item: any): Promise<any | undefined> {
    // Check item type and handle accordingly
    if (item.type === 'function_call') {
      // Legacy function_call item - execute and return response
      const { name, arguments: args, call_id } = item;

      try {
        const result = await this.executeToolCall(name, args, call_id);
        return result;
      } catch (error) {
        return {
          type: 'function_call_output',
          call_id,
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else if (item.type === 'message' || item.type === 'reasoning' || item.type === 'web_search_call') {
      const showRawReasoning = this.session.showRawAgentReasoning() ?? false;
      const eventMsgs = mapResponseItemToEventMessages(item as ResponseItem, showRawReasoning);

      // Emit all mapped events
      for (const msg of eventMsgs) {
        if (msg && 'type' in msg) {
          await this.emitEvent(msg);
        } else {
          console.warn('Skipping malformed event from mapResponseItemToEventMessages:', msg);
        }
      }

      // Handle tool_calls embedded in message items (unified format)
      // Gemini 3 may send parallel tool calls — we must execute ALL of them.
      // Safe calls run concurrently (bounded); unsafe calls run sequentially.
      if (item.type === 'message' && item.tool_calls && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
        // Step 1: Prepare all calls (parse args once, classify concurrency)
        const prepared = item.tool_calls.map((tc: any) =>
          prepareToolCall(tc, this.toolRegistry)
        );

        // Step 2: Partition into batches
        const batches = partitionToolCalls(prepared);

        // Step 3: Execute batches (safe=concurrent, unsafe=sequential)
        const toolCallResults = await executeToolCallBatches(
          batches,
          async (call: PreparedToolCall) => {
            try {
              return await this.executeToolCall(
                call.name,
                call.parsedArguments,
                call.id,
              );
            } catch (error) {
              return {
                type: 'function_call_output',
                call_id: call.id,
                output: `Error: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          },
        );

        // Track 09: tier-2 aggregate budget. Tier-1 (in executeToolCall) has
        // already persisted any individually-oversized results. Tier-2 catches
        // the case where N parallel results collectively exceed the per-turn
        // budget. Both tiers share state via ContentReplacementState.
        const enforced = await this.maybeEnforceTier2(toolCallResults, prepared);

        // Return results preserving original order
        if (enforced.length === 1) {
          return enforced[0];
        }
        return enforced;
      }

      // Handle web search response if needed
      if (item.type === 'web_search_call') {
        if (this.nativeWebSearchEnabled) {
          // Native web search — results are already in the model response
          await this.emitEvent({
            type: 'WebSearchEnd',
            data: {
              query: item.action?.query || '',
              results_count: 0,
            },
          });
          return undefined;
        }

        // CDP fallback — execute local scraping
        const callId = item.id || item.call_id;
        const { action } = item;
        if (action?.type === 'search') {
          try {
            const result = await this.executeWebSearch(action.query);
            return {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(result),
            };
          } catch (error) {
            return {
              type: 'function_call_output',
              call_id: callId,
              output: `Error: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      }

      return undefined;
    }

    // Other item types don't require responses
    return undefined;
  }

  /**
   * Execute a tool call and return the response
   */
  private async executeToolCall(toolName: string, parameters: any, callId: string): Promise<any> {
    try {
      // Parse parameters if they're a JSON string (common with OpenAI API)
      let parsedParams = parameters;
      if (typeof parameters === 'string') {
        try {
          parsedParams = JSON.parse(parameters);
        } catch (error) {
          throw new Error(`Failed to parse tool parameters: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // ── PreToolUse hooks ──
      if (this.hookDispatcher) {
        const hookInput: HookInput = {
          hook_event_name: 'PreToolUse',
          session_id: this.session.sessionId,
          tool_name: toolName,
          tool_input: typeof parsedParams === 'object' ? parsedParams : {},
        };
        const preResult = await this.hookDispatcher.fire('PreToolUse', hookInput);
        if (!preResult.shouldContinue) {
          return {
            type: 'function_call_output',
            call_id: callId,
            output: `Hook blocked: ${preResult.stopReason ?? 'PreToolUse hook denied this tool call'}`,
          };
        }
        if (preResult.updatedInput) {
          parsedParams = { ...parsedParams, ...preResult.updatedInput };
        }
      }

      let result: any;

      switch (toolName) {
        case 'web_search':
          result = await this.executeWebSearch(parsedParams.query);
          break;

        default: {
          // Check ToolRegistry for browser tools BEFORE falling back to MCP
          const browserTool = this.toolRegistry.getTool(toolName);
          if (browserTool) {
            result = await this.executeBrowserTool(browserTool, parsedParams, callId);
            break;
          }

          // Guard MCP execution with capability + config checks
          const toolsConfig = this.turnContext.getToolsConfig();
          const mcpEnabled = toolsConfig.mcpTools === true;

          if (!mcpEnabled) {
            throw new Error(`Tool '${toolName}' not found in ToolRegistry and mcpTools disabled`);
          }

          // Only reach here if MCP is supported AND enabled
          result = await this.executeMcpTool(toolName, parsedParams);
          break;
        }
      }

      // ── PostToolUse hooks ──
      if (this.hookDispatcher) {
        const postHookInput: HookInput = {
          hook_event_name: 'PostToolUse',
          session_id: this.session.sessionId,
          tool_name: toolName,
          tool_input: typeof parsedParams === 'object' ? parsedParams : {},
          tool_output: result,
        };
        const postResult = await this.hookDispatcher.fire('PostToolUse', postHookInput);
        if (postResult.updatedOutput !== undefined) {
          result = postResult.updatedOutput;
        }
      }

      // Format result as function_call_output
      // If result is already a string (e.g. from MCP text content), use it directly
      // to avoid double-encoding (JSON.stringify on a string adds quotes + escapes)
      const output = typeof result === 'string' ? result : JSON.stringify(result);

      // Track 09: tier-1 persistence. Apply per-tool threshold AFTER
      // serialization so object results (e.g. DOM snapshots) are measured
      // correctly. The decision is recorded on the session's replacement
      // state and written to the rollout, so resume produces byte-identical
      // wire bytes.
      const persistedOutput = await this.maybePersistToolResult(toolName, callId, output);

      return {
        type: 'function_call_output',
        call_id: callId,
        output: persistedOutput,
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Handle approval denial with a descriptive message for the LLM
      // Check this first — denials are normal control flow, not tool failures.
      if (errorMsg.includes('denied by the approval system')) {
        const reason = (error as any).reason;
        console.warn(`[TurnManager] executeToolCall ${toolName} denied by approval system${reason ? `: ${reason}` : ''}`);
        const output = reason
          ? `Action denied: The user paused this action and said: "${reason}". Please respond to the user's message directly.`
          : `Action denied: The user's approval system blocked this ${toolName} call. The action was assessed as too risky or was explicitly denied by the user. Please inform the user and suggest an alternative approach.`;
        return {
          type: 'function_call_output',
          call_id: callId,
          output,
        };
      }

      // ── PostToolUseFailure hooks (real failures only, not denials) ──
      if (this.hookDispatcher) {
        const failHookInput: HookInput = {
          hook_event_name: 'PostToolUseFailure',
          session_id: this.session.sessionId,
          tool_name: toolName,
          tool_input: typeof parameters === 'object' ? parameters : {},
          tool_error: errorMsg,
        };
        this.hookDispatcher.fire('PostToolUseFailure', failHookInput).catch(() => {});
      }

      console.error(`[TurnManager] executeToolCall ${toolName} failed:`, errorMsg);

      return {
        type: 'function_call_output',
        call_id: callId,
        output: `Error: ${errorMsg}`,
      };
    }
  }


  /**
   * Tier-1 tool result persistence (track 09).
   *
   * If the serialized output exceeds the tool's threshold, persist the full
   * content to the platform-appropriate backing store and return a
   * <persisted-output> preview message instead. Returns the output unchanged
   * when persistence is disabled, the tool opted out (Infinity), the output
   * is under threshold, or persistence fails (in which case we fall back to
   * legacy truncation so the turn keeps moving).
   */
  private async maybePersistToolResult(
    toolName: string,
    callId: string,
    output: string,
  ): Promise<string> {
    const store = this.session.getToolResultStore?.();
    const state = this.session.getContentReplacementState?.();
    if (!store || !state) return output;

    const profile = this.toolRegistry.getResultProfile(toolName);
    const threshold = getPersistenceThreshold(toolName, profile?.maxResultSizeChars);

    // Infinity opt-out (e.g. cache_storage_tool, read_persisted_result).
    if (!Number.isFinite(threshold)) return output;
    if (output.length <= threshold) return output;

    // Replay path: same call_id was already decided on a prior turn. Reuse
    // the exact preview string the model saw — byte-identical re-apply means
    // the prompt cache stays warm.
    const cached = state.reapply(callId);
    if (cached !== undefined) return cached;

    try {
      const persisted = await store.persist(this.session.sessionId, callId, output);
      const message = buildPersistedOutputMessage(persisted);
      state.record(callId, message);
      return message;
    } catch (err) {
      // Persistence failed (quota, disk error, item-too-large for cache).
      // Fall back to legacy truncation with a marker so the agent still gets
      // *something* and the turn doesn't fail. We deliberately do NOT update
      // the replacement state — next turn can retry.
      const reason =
        err instanceof ToolResultTooLargeForStoreError
          ? 'result exceeds store item limit'
          : err instanceof Error
            ? err.message
            : String(err);
      console.warn(
        `[TurnManager] tier-1 persistence failed for ${toolName} (${callId}): ${reason}`,
      );
      return (
        output.slice(0, threshold) +
        `\n\n[Result truncated from ${output.length} to ${threshold} chars — persistence failed: ${reason}]`
      );
    }
  }

  /**
   * Track 11: run buffered legacy `function_call` items through Track 02's
   * concurrency orchestrator. Returns one result per input call in original
   * order. Mirrors the unified-format (`message` + `tool_calls[]`) path in
   * handleResponseItem, including the Track 09 tier-2 aggregate budget.
   */
  private async executeBufferedToolCalls(calls: any[]): Promise<any[]> {
    const prepared = calls.map((tc) =>
      // tc.arguments may be a JSON string or an already-parsed object;
      // prepareToolCall handles both shapes.
      prepareToolCall(
        { id: tc.call_id, function: { name: tc.name, arguments: tc.arguments } },
        this.toolRegistry,
      ),
    );
    const batches = partitionToolCalls(prepared);
    const results = await executeToolCallBatches(
      batches,
      async (call: PreparedToolCall) => {
        try {
          return await this.executeToolCall(
            call.name,
            call.parsedArguments,
            call.id,
          );
        } catch (error) {
          return {
            type: 'function_call_output',
            call_id: call.id,
            output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    );
    return this.maybeEnforceTier2(results, prepared);
  }

  /**
   * Tier-2 per-message aggregate budget (track 09). No-op when persistence
   * is disabled (no store/state on session). Builds a call_id → tool_name
   * map from the `prepared` array so the budget enforcer can skip
   * Infinity-opt-out tools by name.
   */
  private async maybeEnforceTier2(
    toolCallResults: any[],
    prepared: PreparedToolCall[],
  ): Promise<any[]> {
    const store = this.session.getToolResultStore?.();
    const state = this.session.getContentReplacementState?.();
    if (!store || !state) return toolCallResults;

    const nameByCallId = new Map<string, string>();
    for (const p of prepared) nameByCallId.set(p.id, p.name);
    const skipToolNames = this.toolRegistry.getInfinityTools();

    // Only the items that are actually `function_call_output` are subject to
    // the budget; errors / hook-blocked results are passed through as-is.
    const enforced = await enforceToolResultBudget(
      toolCallResults as FunctionCallOutputItem[],
      state,
      {
        store,
        sessionId: this.session.sessionId,
        limit: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
        skipToolNames,
        toolNameByCallId: (id) => nameByCallId.get(id),
      },
    );
    return enforced;
  }

  /** WebSearchTool instance for executing searches */
  private webSearchTool = new WebSearchTool();

  /**
   * Execute web search using WebSearchTool
   */
  private async executeWebSearch(query: string): Promise<any> {
    await this.emitEvent({
      type: 'WebSearchBegin',
      data: { query },
    });

    try {
      const result = await this.webSearchTool.execute({ query });

      if (!result.success) {
        throw new Error(result.error || 'Web search failed');
      }

      const searchData = result.data;

      await this.emitEvent({
        type: 'WebSearchEnd',
        data: {
          query,
          results_count: searchData.results?.length || 0,
        },
      });

      return searchData;
    } catch (error) {
      await this.emitEvent({
        type: 'WebSearchEnd',
        data: {
          query,
          results_count: 0,
        },
      });
      throw error;
    }
  }

  /**
   * Execute MCP tool
   */
  private async executeMcpTool(toolName: string, parameters: any): Promise<any> {
    await this.emitEvent({
      type: 'McpToolCallBegin',
      data: {
        tool_name: toolName,
        params: parameters,
      },
    });

    try {
      const mcpSession = this.session as unknown as Partial<MCPCapableSession>;
      if (typeof mcpSession.executeMcpTool !== 'function') {
        throw new Error(`MCP tool execution not available on this session`);
      }
      const result = await mcpSession.executeMcpTool(toolName, parameters);

      await this.emitEvent({
        type: 'McpToolCallEnd',
        data: {
          tool_name: toolName,
          result,
        },
      });

      return result;
    } catch (error) {
      await this.emitEvent({
        type: 'McpToolCallEnd',
        data: {
          tool_name: toolName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /**
   * Execute a browser tool from ToolRegistry.
   *
   * Lifecycle events (ToolExecutionStart/End/Error/Timeout) are emitted by
   * ToolRegistry.execute() — TurnManager does not duplicate them.
   */
  private async executeBrowserTool(tool: any, parameters: any, callId?: string): Promise<any> {
    const toolName = this.getToolNameFromDefinition(tool);

    try {
      // Execute tool via ToolRegistry
      // Get tabId from Session to pass to tool execution
      const tabId = this.session.getTabId();

      // Build metadata for approval context
      let currentUrl: string | undefined;
      let currentDomain: string | undefined;
      try {
        if (tabId && tabId > 0 && typeof chrome !== 'undefined' && chrome.tabs) {
          const tab = await chrome.tabs.get(tabId);
          currentUrl = tab.url;
          if (currentUrl) {
            try { currentDomain = new URL(currentUrl).hostname; } catch { /* ignore */ }
          }
        }
      } catch { /* tab may not exist in desktop mode */ }

      // SubmitPlanForReview (Track 14) blocks on human plan approval, which
      // can take far longer than a tool call. Give it an effectively
      // unbounded execution timeout so the registry's handler race does not
      // abort a pending review; everything else keeps the 5-min default
      // (MCP lazy connection + tool execution).
      const executionTimeout =
        toolName === SUBMIT_PLAN_TOOL_NAME ? 24 * 60 * 60 * 1000 : 300000;

      const request = {
        toolName,
        parameters,
        sessionId: this.session.getSessionId(),
        turnId: `turn_${Date.now()}`,
        callId,
        tabId, // Pass tabId in request for tools that need it
        timeout: executionTimeout,
        metadata: {
          currentUrl,
          currentDomain,
          // Per-session handles for the file-access tools (design §4.5). Live
          // in-process object refs; the session-less tools/index.ts path simply
          // omits these and the tools degrade gracefully.
          workspaceRoot: this.session.getWorkspaceRoot(),
          fileStateCache: this.session.getFileStateCache?.(),
          agentMode: this.session.getAgentMode?.(), // §4.2: file tools are code-mode only
        },
      };

      const response = await this.toolRegistry.execute(request);

      if (!response.success) {
        console.error(`[TurnManager] executeBrowserTool: ${toolName} failed:`, response.error);
        const err = new Error(response.error?.message || 'Tool execution failed');
        // Thread user's alternative text from approval denial
        if (response.error?.details?.reason) {
          (err as any).reason = response.error.details.reason;
        }
        throw err;
      }

      // Emit TaskUpdate through platform-agnostic event path
      if (toolName === 'planning_tool' && response.data?._taskEvent) {
        await this.emitEvent({
          type: 'TaskUpdate',
          data: response.data._taskEvent,
        });
      }

      return response.data;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[TurnManager] executeBrowserTool: ${toolName} threw:`, errorMsg);
      // ToolRegistry.execute() already emitted ToolExecutionError — do not duplicate
      throw error;
    }
  }

  /**
   * Extract tool name from ToolDefinition
   */
  private getToolNameFromDefinition(tool: any): string {
    if (tool.type === 'function') {
      return tool.function.name;
    } else if (tool.type === 'custom') {
      return tool.custom.name;
    } else if (tool.type === 'local_shell') {
      return 'local_shell';
    } else if (tool.type === 'web_search') {
      return 'web_search';
    }
    return 'unknown_tool';
  }

  /**
   * Record turn context for rollout/history
   */
  private async recordTurnContext(): Promise<void> {
    const turnContextItem = {
      tabId: this.session.getTabId(), // Get tabId from session (stored in SessionState)
      sessionId: this.turnContext.getSessionId(),
      approval_policy: this.turnContext.getApprovalPolicy(),
      sandbox_policy: this.turnContext.getSandboxPolicy(),
      model: this.turnContext.getModel(),
      effort: this.turnContext.getEffort(),
      summary: this.turnContext.getSummary(),
    };

    await this.session.recordTurnContext(turnContextItem);
  }

  /**
   * Check if error is non-retryable
   */
  private isNonRetryableError(error: any): boolean {
    const message = error.message?.toLowerCase() || '';
    return (
      message.includes('interrupted') ||
      message.includes('cancelled') ||
      message.includes('usage limit') ||
      message.includes('unauthorized') ||
      error.name === 'AuthenticationError'
    );
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempt: number, error: any): number {
    // Check if error specifies a delay
    if (error.retryAfter) {
      return Math.min(error.retryAfter * 1000, this.config.maxRetryDelayMs || 30000);
    }

    // Exponential backoff
    const baseDelay = this.config.retryDelayMs || 1000;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const maxDelay = this.config.maxRetryDelayMs || 30000;

    return Math.min(exponentialDelay, maxDelay);
  }

  /**
   * Convert model client token usage to protocol format
   */
  private convertTokenUsage(usage: any): TokenUsage {
    return {
      input_tokens: usage.prompt_tokens || 0,
      cached_input_tokens: usage.cached_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      reasoning_output_tokens: usage.reasoning_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    };
  }

  /**
   * Get current browser tab ID
   */
  private async getCurrentTabId(): Promise<number | undefined> {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab?.id;
      } catch (error) {
        console.warn('Failed to get current tab ID:', error);
      }
    }
    return undefined;
  }

  /**
   * Get current page URL
   */
  private async getCurrentUrl(): Promise<string | undefined> {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab?.url;
      } catch (error) {
        console.warn('Failed to get current URL:', error);
      }
    }
    return undefined;
  }

  /**
   * Emit an event through the session
   */
  private async emitEvent(msg: EventMsg): Promise<void> {
    const event: Event = {
      id: uuidv4(),
      msg,
    };
    await this.session.emitEvent(event);
  }

  /**
   * Emit stream error event
   */
  private async emitStreamError(
    error: string,
    retrying: boolean,
    attempt?: number,
    delayMs?: number,
    maxRetries?: number
  ): Promise<void> {
    const data: StreamErrorEvent = {
      error,
      retrying,
    };

    if (typeof attempt === 'number') {
      data.attempt = attempt;
    }
    if (typeof delayMs === 'number') {
      data.delayMs = delayMs;
    }
    if (typeof maxRetries === 'number') {
      data.maxRetries = maxRetries;
    }

    await this.emitEvent({
      type: 'StreamError',
      data,
    });
  }

  /**
   * Extract a concise summary for the current stream error.
   */
  private extractStreamErrorSummary(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }

    if (!error) {
      return 'Unknown stream error';
    }

    const visited = new Set<unknown>();
    let current: unknown = error;
    let description = '';

    while (current && !visited.has(current)) {
      visited.add(current);
      description = this.describeError(current);

      const next = this.getErrorCause(current);
      if (!next) {
        break;
      }

      current = next;
    }

    return description || 'Unknown stream error';
  }

  /**
   * Describe an error-like value as a readable string.
   */
  private describeError(value: unknown): string {
    if (value instanceof Error) {
      const name = value.name && value.name !== 'Error' ? `${value.name}: ` : '';
      const message = value.message || '(no message)';
      return `${name}${message}`;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (value && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '[object Object]';
      }
    }

    return 'Unknown stream error';
  }

  /**
   * Retrieve the `cause` field from an error-like value when available.
   */
  private getErrorCause(value: unknown): unknown | undefined {
    if (value instanceof Error && 'cause' in value) {
      return (value as Error & { cause?: unknown }).cause;
    }

    if (value && typeof value === 'object' && 'cause' in (value as any)) {
      return (value as { cause?: unknown }).cause;
    }

    return undefined;
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
