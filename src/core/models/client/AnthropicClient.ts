/**
 * Anthropic (Claude) API client implementation for WorkX
 *
 * Uses the official `@anthropic-ai/sdk` Messages API. Extends OpenAIResponsesClient
 * to reuse the shared plumbing (model/provider accessors, retry loop, ResponseStream
 * population, reasoning getters/setters, error normalization) while overriding the
 * three seams where Anthropic's wire protocol differs from OpenAI's Responses API:
 *
 *   1. buildRequestPayload()            -> builds Anthropic MessageCreateParams
 *   2. attemptStreamResponses()         -> calls the Anthropic SDK instead of OpenAI
 *   3. convertSDKEventToResponseEvent() -> maps Anthropic stream events to ResponseEvent
 *
 * Key Anthropic differences handled here:
 * - `system` is a top-level parameter, NOT a message in the `messages` array.
 * - `max_tokens` is REQUIRED on every request.
 * - Messages use typed content blocks (text / image / tool_use / tool_result / thinking).
 * - Tool results are carried as `tool_result` blocks inside `user` messages.
 * - Extended thinking streams `thinking_delta` events mapped to ReasoningContentDelta.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ModelClientError,
  type CompletionRequest,
  type CompletionResponse,
} from '../ModelClient';
import { ResponseStream } from '../ResponseStream';
import { OpenAIResponsesClient, type OpenAIResponsesConfig } from './OpenAIResponsesClient';
import { get_formatted_input } from '../PromptHelpers';
import type { Prompt, ReasoningEffortConfig } from '../types/ResponsesAPI';
import type { ResponseEvent } from '../types/ResponseEvent';
import type { TokenUsage } from '../types/TokenUsage';
import type { ResponseItem, ContentItem } from '../../protocol/types';

/** Default max output tokens when a model config does not specify one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Anthropic's minimum extended-thinking budget. */
const MIN_THINKING_BUDGET = 1024;

/** Tokens reserved for the visible answer when thinking is enabled. */
const THINKING_OUTPUT_HEADROOM = 1024;

/** Mapping from reasoning effort to a target thinking budget (in tokens). */
const THINKING_BUDGET_BY_EFFORT: Record<ReasoningEffortConfig, number> = {
  low: 4000,
  medium: 10000,
  high: 24000,
};

/** Models where Anthropic supports adaptive thinking through thinking.type=adaptive. */
const ADAPTIVE_THINKING_MODELS = new Set([
  'claude-opus-4-8',
  'claude-sonnet-4-6',
]);

/** Models where adaptive thinking is always enabled and the thinking field must be omitted. */
const ALWAYS_ON_ADAPTIVE_THINKING_MODELS = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
]);

/**
 * Per-content-block accumulator used while streaming a single Anthropic message.
 * Anthropic streams deltas per block index; we accumulate text / thinking / tool
 * input and emit a single OutputItemDone when the block stops.
 */
interface BlockAccumulator {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'other';
  text: string;
  toolId?: string;
  toolName?: string;
  toolInputJson: string;
  signature: string;
  redactedData: string;
}

/**
 * Anthropic Messages API client using the official SDK.
 */
export class AnthropicClient extends OpenAIResponsesClient {
  /** Official Anthropic SDK instance (separate from the inherited, unused OpenAI client). */
  private anthropic: Anthropic;

  // --- Streaming accumulation state (single in-flight stream per client instance) ---
  private blocks: Map<number, BlockAccumulator> = new Map();
  private currentResponseId = '';
  private usageInputTokens = 0;
  private usageCacheReadTokens = 0;
  private usageCacheCreationTokens = 0;
  private usageOutputTokens = 0;

  constructor(config: OpenAIResponsesConfig) {
    super(config);

    if (config.provider.name.toLowerCase().indexOf('anthropic') === -1
      && config.provider.name !== 'Backend') {
      console.warn(`[AnthropicClient] Instantiated with non-Anthropic provider: ${config.provider.name}`);
    }

    // The Anthropic SDK appends `/v1/messages`, so baseURL must NOT already include `/v1`.
    this.anthropic = new Anthropic({
      apiKey: this.apiKey || 'dummy-key', // validated at request time
      baseURL: this.baseUrl,
      dangerouslyAllowBrowser: true, // required for Chrome extension / browser runtime
      maxRetries: 0, // single attempt; retry/backoff is owned by TurnManager.runTurn
      timeout: 600000, // 10 minutes for long thinking/tool turns
      defaultHeaders: {
        // Allow direct browser-origin requests from the extension runtime.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Request building
  // ---------------------------------------------------------------------------

  /**
   * Build the Anthropic Messages API request payload from the provider-agnostic Prompt.
   * Overrides the OpenAI Responses payload builder.
   */
  protected async buildRequestPayload(prompt: Prompt): Promise<any> {
    const system = this.getFullInstructions(prompt);
    const formattedInput = await get_formatted_input(prompt);
    const messages = this.convertInputToAnthropicMessages(formattedInput);
    const tools = this.convertToolsToAnthropic(prompt.tools);
    const maxTokens = this.getMaxOutputTokens();

    const payload: any = {
      model: this.currentModel,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };

    if (system && system.trim()) {
      payload.system = system;
    }

    if (tools.length > 0) {
      payload.tools = tools;
    }

    // Reasoning: prefer Anthropic's adaptive thinking + effort for current models,
    // and only fall back to manual budget_tokens for models that still require it.
    if (this.modelFamily.supports_reasoning && this.reasoningEffort) {
      if (this.usesAlwaysOnAdaptiveThinking()) {
        payload.output_config = { effort: this.reasoningEffort };
      } else if (this.supportsAdaptiveThinking()) {
        payload.thinking = { type: 'adaptive', display: 'summarized' };
        payload.output_config = { effort: this.reasoningEffort };
      } else {
        const budget = this.thinkingBudgetFromEffort(this.reasoningEffort, maxTokens);
        if (budget >= MIN_THINKING_BUDGET) {
          payload.thinking = { type: 'enabled', budget_tokens: budget, display: 'summarized' };
          // When thinking is enabled, Anthropic requires temperature to be unset (defaults to 1).
        }
      }
    }

    return payload;
  }

  private supportsAdaptiveThinking(): boolean {
    return ADAPTIVE_THINKING_MODELS.has(this.currentModel);
  }

  private usesAlwaysOnAdaptiveThinking(): boolean {
    return ALWAYS_ON_ADAPTIVE_THINKING_MODELS.has(this.currentModel);
  }

  /**
   * Resolve the required `max_tokens` for the current model.
   */
  private getMaxOutputTokens(): number {
    const configured = this.modelConfig?.maxOutputTokens;
    if (typeof configured === 'number' && configured > 0) {
      return configured;
    }
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /**
   * Derive an extended-thinking budget from the configured reasoning effort,
   * clamped so it always leaves headroom for the visible answer.
   */
  private thinkingBudgetFromEffort(effort: ReasoningEffortConfig, maxTokens: number): number {
    const target = THINKING_BUDGET_BY_EFFORT[effort] ?? THINKING_BUDGET_BY_EFFORT.medium;
    const ceiling = maxTokens - THINKING_OUTPUT_HEADROOM;
    if (ceiling < MIN_THINKING_BUDGET) {
      // Not enough room to enable thinking meaningfully.
      return 0;
    }
    return Math.max(MIN_THINKING_BUDGET, Math.min(target, ceiling));
  }

  /**
   * Convert internal ResponseItem[] history into Anthropic MessageParam[].
   * Adjacent items resolving to the same role are merged into a single message,
   * as Anthropic requires alternating user/assistant turns.
   */
  private convertInputToAnthropicMessages(items: ResponseItem[]): any[] {
    const messages: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];

    const push = (role: 'user' | 'assistant', blocks: any[]) => {
      if (blocks.length === 0) {
        return;
      }
      const last = messages[messages.length - 1];
      if (last && last.role === role) {
        last.content.push(...blocks);
      } else {
        messages.push({ role, content: blocks });
      }
    };

    for (const item of items) {
      switch (item.type) {
        case 'message': {
          const role: 'user' | 'assistant' = item.role === 'assistant' ? 'assistant' : 'user';
          const blocks = this.convertContentItems(item.content);

          // Assistant messages may carry Chat-format tool calls.
          if (item.role === 'assistant' && Array.isArray(item.tool_calls)) {
            for (const tc of item.tool_calls) {
              blocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: this.safeParseJson(tc.function.arguments),
              });
            }
          }
          push(role, blocks);
          break;
        }

        case 'function_call': {
          push('assistant', [{
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: this.safeParseJson(item.arguments),
          }]);
          break;
        }

        case 'function_call_output': {
          push('user', [{
            type: 'tool_result',
            tool_use_id: item.call_id,
            content: item.output ?? '',
          }]);
          break;
        }

        case 'custom_tool_call': {
          push('assistant', [{
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: this.convertCustomToolInput(item.input),
          }]);
          break;
        }

        case 'custom_tool_call_output': {
          push('user', [{
            type: 'tool_result',
            tool_use_id: item.call_id,
            content: item.output ?? '',
          }]);
          break;
        }

        case 'reasoning': {
          const block = this.convertReasoningToAnthropicBlock(item);
          if (block) {
            push('assistant', [block]);
          }
          break;
        }

        case 'web_search_call':
        case 'local_shell_call':
        case 'other':
        default:
          break;
      }
    }

    // Anthropic requires every thinking / redacted_thinking block to appear at the
    // START of an assistant message, before any text or tool_use block. Streamed
    // history is normally already in this order, but a turn that interleaves a
    // tool_use between two reasoning blocks (or records the message before the
    // reasoning) would otherwise emit a thinking block after tool_use and get a 400.
    // Stable-partition each assistant message so thinking blocks lead.
    for (const message of messages) {
      if (message.role !== 'assistant') {
        continue;
      }
      const thinking: any[] = [];
      const rest: any[] = [];
      for (const block of message.content) {
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          thinking.push(block);
        } else {
          rest.push(block);
        }
      }
      if (thinking.length > 0 && rest.length > 0) {
        message.content = [...thinking, ...rest];
      }
    }

    return messages;
  }

  /**
   * Convert internal ContentItem[] into Anthropic content blocks (text / image).
   */
  private convertContentItems(content: ContentItem[]): any[] {
    if (!Array.isArray(content)) {
      return [];
    }

    const blocks: any[] = [];
    for (const c of content) {
      switch (c.type) {
        case 'text':
        case 'input_text':
        case 'output_text':
          if (c.text) {
            blocks.push({ type: 'text', text: c.text });
          }
          break;
        case 'refusal':
          if (c.refusal) {
            blocks.push({ type: 'text', text: c.refusal });
          }
          break;
        case 'input_image': {
          const imageBlock = this.convertImage(c.image_url);
          if (imageBlock) {
            blocks.push(imageBlock);
          }
          break;
        }
        default:
          break;
      }
    }
    return blocks;
  }

  /**
   * Convert an image URL (data: URI or http(s) URL) to an Anthropic image block.
   */
  private convertImage(imageUrl: string): any | null {
    if (!imageUrl) {
      return null;
    }

    const dataUrlMatch = imageUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (dataUrlMatch) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrlMatch[1],
          data: dataUrlMatch[2],
        },
      };
    }

    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      return {
        type: 'image',
        source: { type: 'url', url: imageUrl },
      };
    }

    return null;
  }

  /**
   * Convert provider-agnostic ToolSpec[] into Anthropic tool definitions.
   */
  private convertToolsToAnthropic(tools: any[]): any[] {
    if (!Array.isArray(tools)) {
      return [];
    }

    const result: any[] = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') {
        continue;
      }

      if (tool.type === 'function' && tool.function?.name) {
        result.push({
          name: tool.function.name,
          description: tool.function.description ?? '',
          input_schema: tool.function.parameters || { type: 'object', properties: {} },
        });
      } else if (tool.type === 'custom' && tool.custom?.name) {
        result.push({
          name: tool.custom.name,
          description: tool.custom.description ?? '',
          input_schema: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Tool input' } },
            required: ['input'],
          },
        });
      }
      // local_shell / web_search are not mapped to Anthropic server tools yet.
    }
    return result;
  }

  private safeParseJson(raw: string | undefined): any {
    if (!raw || !raw.trim()) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      console.debug('[AnthropicClient] Failed to parse tool arguments JSON, using empty object');
      return {};
    }
  }

  private convertCustomToolInput(input: string | undefined): any {
    if (!input || !input.trim()) {
      return { input: '' };
    }
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if ('input' in parsed) {
          return parsed;
        }
        return { input };
      }
    } catch {
      // Freeform custom tool input is expected to be plain text.
    }
    return { input };
  }

  private convertReasoningToAnthropicBlock(
    item: Extract<ResponseItem, { type: 'reasoning' }>
  ): any | null {
    if (item.encrypted_content_type === 'redacted_thinking') {
      if (!item.encrypted_content) {
        return null;
      }
      return { type: 'redacted_thinking', data: item.encrypted_content };
    }

    if (item.encrypted_content_type !== 'signature' || !item.encrypted_content) {
      return null;
    }

    const thinking = item.content
      ?.map((content) => content.text)
      .join('') ?? '';

    return {
      type: 'thinking',
      thinking,
      signature: item.encrypted_content,
    };
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  /**
   * Override the SDK-call seam. Reuses the inherited processSDKStreamToResponseStream()
   * loop (which dispatches to our convertSDKEventToResponseEvent override) but sources
   * events from the Anthropic SDK rather than the OpenAI Responses API.
   */
  protected async attemptStreamResponses(
    _attempt: number,
    payload: any
  ): Promise<ResponseStream> {
    const sdkStream = await this.makeAnthropicRequest(payload);

    // 30-minute event timeout to accommodate long thinking turns.
    const stream = new ResponseStream(undefined, { eventTimeout: 1800000 });

    (async () => {
      try {
        await this.processSDKStreamToResponseStream(sdkStream, stream);
        stream.complete();
      } catch (error) {
        stream.error(error as Error);
      }
    })();

    return stream;
  }

  /**
   * Create the Anthropic streaming request. Resets per-stream accumulation state.
   */
  private async makeAnthropicRequest(payload: any): Promise<AsyncIterable<any>> {
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError(`No API key configured for provider: ${this.provider.name}`);
    }

    this.resetStreamState();

    try {
      // stream: true overload returns an async-iterable Stream of raw events.
      return (await this.anthropic.messages.create(payload)) as unknown as AsyncIterable<any>;
    } catch (error: any) {
      throw this.toModelClientError(error, `${this.provider.name} Messages API error`);
    }
  }

  private resetStreamState(): void {
    this.blocks.clear();
    this.currentResponseId = '';
    this.usageInputTokens = 0;
    this.usageCacheReadTokens = 0;
    this.usageCacheCreationTokens = 0;
    this.usageOutputTokens = 0;
  }

  /**
   * Map a single Anthropic stream event to zero or more ResponseEvents.
   * Stateful: accumulates block deltas across calls within one message.
   */
  protected convertSDKEventToResponseEvent(sdkEvent: any): ResponseEvent[] {
    if (!sdkEvent || !sdkEvent.type) {
      return [];
    }

    const events: ResponseEvent[] = [];

    switch (sdkEvent.type) {
      case 'message_start': {
        this.resetStreamState();
        const message = sdkEvent.message ?? {};
        this.currentResponseId = message.id ?? '';
        this.captureInputUsage(message.usage);
        events.push({ type: 'Created' });
        break;
      }

      case 'content_block_start': {
        const index: number = sdkEvent.index ?? 0;
        const block = sdkEvent.content_block ?? {};
        if (block.type === 'tool_use') {
          this.blocks.set(index, {
            type: 'tool_use',
            text: '',
            toolId: block.id,
            toolName: block.name,
            toolInputJson: '',
            signature: '',
            redactedData: '',
          });
        } else if (block.type === 'thinking') {
          this.blocks.set(index, {
            type: 'thinking',
            text: block.thinking ?? '',
            toolInputJson: '',
            signature: block.signature ?? '',
            redactedData: '',
          });
        } else if (block.type === 'redacted_thinking') {
          this.blocks.set(index, {
            type: 'redacted_thinking',
            text: '',
            toolInputJson: '',
            signature: '',
            redactedData: block.data ?? '',
          });
        } else if (block.type === 'text') {
          this.blocks.set(index, {
            type: 'text',
            text: block.text ?? '',
            toolInputJson: '',
            signature: '',
            redactedData: '',
          });
        } else {
          this.blocks.set(index, {
            type: 'other',
            text: '',
            toolInputJson: '',
            signature: '',
            redactedData: '',
          });
        }
        break;
      }

      case 'content_block_delta': {
        const index: number = sdkEvent.index ?? 0;
        const delta = sdkEvent.delta ?? {};
        const acc = this.blocks.get(index);
        if (delta.type === 'text_delta') {
          if (acc) acc.text += delta.text ?? '';
          events.push({ type: 'OutputTextDelta', delta: delta.text ?? '' });
        } else if (delta.type === 'thinking_delta') {
          if (acc) acc.text += delta.thinking ?? '';
          events.push({ type: 'ReasoningContentDelta', delta: delta.thinking ?? '' });
        } else if (delta.type === 'input_json_delta') {
          if (acc) acc.toolInputJson += delta.partial_json ?? '';
        } else if (delta.type === 'signature_delta') {
          if (acc) acc.signature += delta.signature ?? '';
        }
        break;
      }

      case 'content_block_stop': {
        const index: number = sdkEvent.index ?? 0;
        const acc = this.blocks.get(index);
        const item = acc ? this.finalizeBlock(acc) : null;
        if (item) {
          events.push({ type: 'OutputItemDone', item });
        }
        this.blocks.delete(index);
        break;
      }

      case 'message_delta': {
        if (sdkEvent.usage?.output_tokens != null) {
          this.usageOutputTokens = sdkEvent.usage.output_tokens;
        }
        break;
      }

      case 'message_stop': {
        events.push({
          type: 'Completed',
          responseId: this.currentResponseId,
          tokenUsage: this.buildTokenUsage(),
        });
        break;
      }

      // ping / unknown events: no-op
      default:
        break;
    }

    return events;
  }

  /**
   * Convert a finished content block into a provider-agnostic ResponseItem.
   */
  private finalizeBlock(acc: BlockAccumulator): ResponseItem | null {
    if (acc.type === 'text') {
      if (!acc.text) {
        return null;
      }
      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: acc.text }],
      };
    }

    if (acc.type === 'thinking') {
      if (!acc.text && !acc.signature) {
        return null;
      }
      return {
        type: 'reasoning',
        summary: [],
        content: acc.text ? [{ type: 'reasoning_text', text: acc.text }] : [],
        ...(acc.signature && {
          encrypted_content: acc.signature,
          encrypted_content_type: 'signature',
        }),
      };
    }

    if (acc.type === 'redacted_thinking') {
      if (!acc.redactedData) {
        return null;
      }
      return {
        type: 'reasoning',
        summary: [],
        content: [],
        encrypted_content: acc.redactedData,
        encrypted_content_type: 'redacted_thinking',
      };
    }

    if (acc.type === 'tool_use') {
      // Preserve the raw accumulated JSON string as the canonical arguments.
      const argumentsJson = acc.toolInputJson && acc.toolInputJson.trim()
        ? acc.toolInputJson
        : '{}';
      return {
        type: 'function_call',
        id: acc.toolId,
        name: acc.toolName ?? '',
        arguments: argumentsJson,
        call_id: acc.toolId ?? '',
      };
    }

    return null;
  }

  private captureInputUsage(usage: any): void {
    if (!usage) {
      return;
    }
    this.usageInputTokens = usage.input_tokens ?? 0;
    this.usageCacheReadTokens = usage.cache_read_input_tokens ?? 0;
    this.usageCacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    if (usage.output_tokens != null) {
      this.usageOutputTokens = usage.output_tokens;
    }
  }

  private buildTokenUsage(): TokenUsage {
    const totalInput =
      this.usageInputTokens + this.usageCacheReadTokens + this.usageCacheCreationTokens;
    return {
      input_tokens: totalInput,
      cached_input_tokens: this.usageCacheReadTokens,
      output_tokens: this.usageOutputTokens,
      // Anthropic bundles thinking tokens into output_tokens; not separately reported.
      reasoning_output_tokens: 0,
      total_tokens: totalInput + this.usageOutputTokens,
    };
  }

  /**
   * Convert Anthropic usage object to internal TokenUsage.
   * Overrides the OpenAI-shaped converter for any callers that pass usage directly.
   */
  protected convertTokenUsage(usage: any): TokenUsage {
    if (!usage) {
      return {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      };
    }
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const totalInput = input + cacheRead + cacheCreation;
    return {
      input_tokens: totalInput,
      cached_input_tokens: cacheRead,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: totalInput + output,
    };
  }

  // ---------------------------------------------------------------------------
  // Non-streaming completion
  // ---------------------------------------------------------------------------

  /**
   * Non-streaming completion using the Anthropic Messages API.
   * Overrides the OpenAI Chat Completions implementation.
   *
   * Text-only: this path maps user/assistant text and the system prompt. It does
   * NOT carry tool calls, tool results, images, or thinking blocks, and is only
   * used for simple text completions (e.g. memory merge/search). Agentic tool
   * turns go through stream().
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.validateRequest(request);

    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError(`No API key configured for provider: ${this.provider.name}`);
    }

    const systemMessage = request.messages.find(m => m.role === 'system');
    const conversational = request.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.content ?? '',
      }));

    const params: any = {
      model: request.model,
      max_tokens: request.maxTokens ?? this.getMaxOutputTokens(),
      messages: conversational,
      stream: false,
    };
    if (systemMessage?.content) {
      params.system = systemMessage.content;
    }
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    try {
      const response: any = await this.anthropic.messages.create(params);
      const text = Array.isArray(response.content)
        ? response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        : '';

      return {
        id: response.id,
        model: response.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finishReason: this.mapStopReason(response.stop_reason),
        }],
        usage: {
          promptTokens: response.usage?.input_tokens ?? 0,
          completionTokens: response.usage?.output_tokens ?? 0,
          totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
        },
      };
    } catch (error: any) {
      throw this.toModelClientError(error, `${this.provider.name} Messages API error`);
    }
  }

  private mapStopReason(
    stopReason: string | null | undefined
  ): CompletionResponse['choices'][0]['finishReason'] {
    switch (stopReason) {
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      case 'end_turn':
      case 'stop_sequence':
      default:
        return 'stop';
    }
  }
}
