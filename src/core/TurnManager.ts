/**
 * TurnManager implementation
 * Manages individual conversation turns, handles model streaming, and coordinates tool calls
 */

import { Session } from './Session';
import type { ToolDefinition } from '../tools/BaseTool';
import { TurnContext } from './TurnContext';
import type { CompletionRequest, CompletionResponse } from './models/ModelClient';
import { loadPrompt, loadUserInstructions } from './PromptLoader';
import type { EventMsg, TokenUsage, StreamErrorEvent } from './protocol/events';
import type { Event, InputItem } from './protocol/types';
import type { ResponseEvent } from './models/types/ResponseEvent';
import type { Prompt as ModelPrompt } from './models/types/ResponsesAPI';
import { v4 as uuidv4 } from 'uuid';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { IToolsConfig } from '../config/types';
import { mapResponseItemToEventMessages } from './events/EventMapping';
import type { ResponseItem } from './protocol/types';
import { WebSearchTool } from '../tools/WebSearchTool';

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

    const prompt: ModelPrompt = {
      input,
      tools,
      base_instructions_override: this.turnContext.getBaseInstructions(),
      user_instructions: this.turnContext.getUserInstructions(),
    };

    let retries = 0;

    while (!this.cancelled) {
      try {
        return await this.tryRunTurn(prompt);
      } catch (error) {
        // Check for non-retryable errors
        if (this.cancelled) {
          throw new Error('Turn cancelled');
        }

        if (this.isNonRetryableError(error)) {
          throw error;
        }

        // Apply retry logic
        if (retries < (this.config.maxRetries || 3)) {
          retries++;
          const delay = this.calculateRetryDelay(retries, error);

          const summary = this.extractStreamErrorSummary(error);

          // Notify about retry attempt
          await this.emitStreamError(
            `Stream error: ${summary}`,
            true,
            retries,
            delay,
            this.config.maxRetries
          );

          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }

    throw new Error('Turn cancelled');
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
            // Item (message or tool call) is complete
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
            break;

          case 'Completed': {
            // Stream completed with final token usage
            totalTokenUsage = event.tokenUsage;

            return {
              processedItems,
              totalTokenUsage,
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
            await this.emitEvent({
              type: 'ReasoningSummaryDelta',
              data: { delta: event.delta },
            });
            break;

          case 'ReasoningContentDelta':
            // Reasoning content delta (for o1/o3 models)
            await this.emitEvent({
              type: 'ReasoningContentDelta',
              data: { delta: event.delta },
            });
            break;

          case 'ReasoningSummaryPartAdded':
            // Reasoning summary part added
            await this.emitEvent({
              type: 'ReasoningSummaryPartAdded',
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
    const hasWebSearch = tools.some(t => t.type === 'function' && t.function.name === 'web_search');
    if (!hasWebSearch && (enableAllTools || toolsConfig.webSearch)) {
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

    // Note: planning_tool is registered via ToolRegistry in src/tools/index.ts
    // It will be picked up automatically from registeredTools above

    // Add MCP tools if enabled and available
    // Guard MCP calls with capability check to prevent "is not a function" errors
    if (
      (enableAllTools || toolsConfig.mcpTools === true) &&
      typeof this.session.getMcpTools === 'function'
    ) {
      const mcpTools = await this.session.getMcpTools();
      // Convert MCP tools to ModelClient format
      const convertedMcpTools = mcpTools.map(tool => ({
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
            tools.push({
              type: 'function',
              function: {
                name: customTool.name,
                description: customTool.description,
                parameters: customTool.parameters || {},
              },
            });
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
      type: 'function_call_output',
      call_id: callId,
      output: 'aborted',
    }));

    return {
      ...prompt,
      input: [...syntheticResponses, ...prompt.input],
    };
  }

  /**
   * Build completion request for model client
   */
  private async buildCompletionRequest(prompt: ModelPrompt): Promise<CompletionRequest> {
    const model = this.turnContext.getModel();
    const request: CompletionRequest = {
      model,
      messages: await this.convertPromptToMessages(prompt),
      tools: prompt.tools,
      stream: true,
      maxTokens: 4096,
    };

    // For gpt-5, temperature must be 1 (default) or omitted
    // For other models, use 0.7
    if (model !== 'gpt-5') {
      request.temperature = 0.7;
    }

    return request;
  }

  /**
   * Convert prompt format to model client message format
   */
  private async convertPromptToMessages(prompt: ModelPrompt): Promise<any[]> {
    const messages: any[] = [];

    // Load and add the agent prompt as system message
    const systemPrompt = await loadPrompt();
    messages.push({ role: 'system', content: systemPrompt });

    // Add user instructions (development guidelines from user_instruction.md)
    const userInstructions = this.turnContext.getUserInstructions();
    if (userInstructions) {
      messages.push({
        role: 'system',
        content: `<user_instructions>\n${userInstructions}\n</user_instructions>`,
      });
    }

    // Add base instructions if provided (as override)
    if (prompt.base_instructions_override) {
      messages.push({
        role: 'system',
        content: prompt.base_instructions_override,
      });
    }

    // Convert input items to messages
    for (const item of prompt.input) {
      if (item.role && item.content) {
        messages.push({
          role: item.role,
          content: item.content,
          toolCalls: item.toolCalls,
          toolCallId: item.toolCallId,
        });
      }
    }

    return messages;
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
      // NEW: Assistant messages can now contain tool_calls directly
      // IMPORTANT: Gemini 3 may send parallel tool calls - we must execute ALL of them
      // and return ALL responses, otherwise Gemini will return empty on next turn
      if (item.type === 'message' && item.tool_calls && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
        const toolCallResults: any[] = [];

        // Execute ALL tool calls sequentially (Gemini expects responses for all)
        for (const toolCall of item.tool_calls) {
          try {
            const result = await this.executeToolCall(
              toolCall.function.name,
              toolCall.function.arguments,
              toolCall.id
            );
            toolCallResults.push(result);
          } catch (error) {
            toolCallResults.push({
              type: 'function_call_output',
              call_id: toolCall.id,
              output: `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        // Return all tool call results (will be added to conversation history)
        // If single result, return as-is for backward compatibility
        // If multiple results, return as array
        if (toolCallResults.length === 1) {
          return toolCallResults[0];
        }
        return toolCallResults;
      }

      // Handle web search response if needed
      if (item.type === 'web_search_call') {
        const { call_id, action } = item;
        if (action?.type === 'search') {
          try {
            const result = await this.executeWebSearch(action.query);
            return {
              type: 'function_call_output',
              call_id,
              output: JSON.stringify(result),
            };
          } catch (error) {
            return {
              type: 'function_call_output',
              call_id,
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

      let result: any;

      switch (toolName) {
        case 'web_search':
          result = await this.executeWebSearch(parsedParams.query);
          break;

        case 'planning_tool':
          // Planning tool - emit PlanUpdate event and return success
          result = await this.updatePlan(parsedParams.plan, parsedParams.explanation);
          break;

        default: {
          // Check ToolRegistry for browser tools BEFORE falling back to MCP
          const browserTool = this.toolRegistry.getTool(toolName);
          if (browserTool) {
            result = await this.executeBrowserTool(browserTool, parsedParams);
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

      // Format result as function_call_output
      // If result is already a string (e.g. from MCP text content), use it directly
      // to avoid double-encoding (JSON.stringify on a string adds quotes + escapes)
      const output = typeof result === 'string' ? result : JSON.stringify(result);

      return {
        type: 'function_call_output',
        call_id: callId,
        output,
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Handle approval denial with a descriptive message for the LLM
      if (errorMsg.includes('denied by the approval system')) {
        console.warn(`[TurnManager] executeToolCall ${toolName} denied by approval system`);
        return {
          type: 'function_call_output',
          call_id: callId,
          output: `Action denied: The user's approval system blocked this ${toolName} call. The action was assessed as too risky or was explicitly denied by the user. Please inform the user and suggest an alternative approach.`,
        };
      }

      console.error(`[TurnManager] executeToolCall ${toolName} failed:`, errorMsg);

      return {
        type: 'function_call_output',
        call_id: callId,
        output: `Error: ${errorMsg}`,
      };
    }
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
   * Update task plan
   */
  private async updatePlan(plan: any[], explanation?: string): Promise<any> {
    await this.emitEvent({
      type: 'PlanUpdate',
      data: { plan, explanation },
    });

    return { success: true, plan };
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
      const result = await this.session.executeMcpTool(toolName, parameters);

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
   * Execute a browser tool from ToolRegistry
   */
  private async executeBrowserTool(tool: any, parameters: any): Promise<any> {
    // Emit browser tool execution event
    const toolName = this.getToolNameFromDefinition(tool);

    await this.emitEvent({
      type: 'ToolExecutionStart',
      data: {
        tool_name: toolName,
        session_id: this.session.getSessionId(),
      },
    });

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

      const request = {
        toolName,
        parameters,
        sessionId: this.session.getSessionId(),
        turnId: `turn_${Date.now()}`,
        tabId, // Pass tabId in request for tools that need it
        timeout: 300000, // 5 min — allows for MCP lazy connection + tool execution
        metadata: {
          currentUrl,
          currentDomain,
        },
      };

      const response = await this.toolRegistry.execute(request);

      if (!response.success) {
        console.error(`[TurnManager] executeBrowserTool: ${toolName} failed:`, response.error);
        throw new Error(response.error?.message || 'Tool execution failed');
      }

      await this.emitEvent({
        type: 'ToolExecutionEnd',
        data: {
          tool_name: toolName,
          session_id: this.session.getSessionId(),
          success: true,
        },
      });

      return response.data;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[TurnManager] executeBrowserTool: ${toolName} threw:`, errorMsg);

      await this.emitEvent({
        type: 'ToolExecutionError',
        data: {
          tool_name: toolName,
          session_id: this.session.getSessionId(),
          error: errorMsg,
        },
      });
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
