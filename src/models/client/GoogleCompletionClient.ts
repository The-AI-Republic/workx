/**
 * Google AI Studio (Gemini) Chat Completion API client implementation
 * Uses the native @google/genai SDK
 */

import { GoogleGenAI } from '@google/genai';
import { GeminiLogger } from '../../utils/logger';
import type { ResponseEvent, Prompt, ModelProviderInfo } from '../types/ResponsesAPI';
import { ModelClient, ModelClientError, type RetryConfig, type CompletionRequest, type CompletionResponse } from '../ModelClient';
import { get_full_instructions, get_formatted_input } from '../PromptHelpers';
import { ResponseStream } from '../ResponseStream';
import type { RateLimitSnapshot } from '../types/RateLimits';
import type { ToolDefinition } from '../../tools/BaseTool';

export interface GoogleGenAIConfig {
  apiKey: string | null;
  baseUrl?: string;
  provider: ModelProviderInfo;
  modelFamily: any;
}

/**
 * Google AI Studio (Gemini) client using native SDK
 */
export class GoogleCompletionClient extends ModelClient {
  private client: GoogleGenAI;
  private apiKey: string;
  private provider: ModelProviderInfo;
  private modelFamily: any;
  private currentModel: string = 'gemini-2.0-flash-exp'; // Default

  constructor(config: GoogleGenAIConfig, retryConfig?: Partial<RetryConfig>) {
    super(retryConfig);

    if (!config.apiKey) {
      throw new Error('API key is required for GoogleCompletionClient');
    }

    this.apiKey = config.apiKey;
    this.provider = config.provider;
    this.modelFamily = config.modelFamily;

    // Set model from family config if available
    if (this.modelFamily && this.modelFamily.family) {
      this.currentModel = this.modelFamily.family;
    }

    // Initialize Google GenAI client
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
  }

  getProvider(): ModelProviderInfo {
    return this.provider;
  }

  getModel(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getAutoCompactTokenLimit(): number | undefined {
    return 1000000; // Large context window for Gemini
  }

  getModelFamily(): any {
    return this.modelFamily;
  }

  getAuthManager(): any {
    return undefined;
  }

  getReasoningEffort(): any {
    return undefined;
  }

  setReasoningEffort(effort: any): void {
    // Not supported
  }

  getReasoningSummary(): any {
    return undefined;
  }

  setReasoningSummary(summary: any): void {
    // Not supported
  }

  countTokens(text: string, model: string): number {
    // Rough estimation if SDK doesn't expose synchronous count
    return Math.ceil(text.length / 4);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    throw new Error('Method not implemented. Use stream() instead.');
  }

  async stream(prompt: Prompt): Promise<ResponseStream> {
    // Reset state
    GeminiLogger.stateReset();
    GeminiLogger.streamStart(this.currentModel, 'conversation-' + Date.now());

    // Create stream and start processing asynchronously
    const stream = new ResponseStream(undefined, { eventTimeout: 1800000 });

    // Spawn async task to populate stream
    (async () => {
      try {
        await this.generateContentStream(prompt, stream);
        stream.complete();
      } catch (error: any) {
        console.error('[GoogleCompletionClient] Stream error:', error);
        stream.error(new ModelClientError(error.message || 'Stream failed', error.status || 500, this.provider.name));
      }
    })();

    return stream;
  }

  private async generateContentStream(prompt: Prompt, stream: ResponseStream) {
    // Prepare system instructions
    const fullInstructions = get_full_instructions(prompt, this.modelFamily);

    // Prepare tools
    const tools = this.mapTools(prompt.tools);

    // Prepare contents
    const contents = await this.mapPromptToContents(prompt);

    const config: any = {
      systemInstruction: fullInstructions,
      tools: tools ? [tools] : undefined,
    };

    // Add tool config if tools are present
    if (tools) {
      config.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }

    let accumulatedText = '';
    const accumulatedToolCalls: any[] = [];
    let usageMetadata: any = undefined;

    let retryCount = 0;
    const maxRetries = 3;
    const baseDelay = 2000;

    while (true) {
      try {
        // Use the models namespace from the new SDK
        const result = await this.client.models.generateContentStream({
          model: this.currentModel,
          contents,
          config
        });

        for await (const chunk of result) {
          // Capture usage metadata if present
          if (chunk.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }

          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;

          // Handle content parts
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                accumulatedText += part.text;
                stream.addEvent({
                  type: 'OutputTextDelta',
                  delta: part.text
                });
              }

              if (part.functionCall) {
                // Gemini returns full function call in the part usually
                // Capture thoughtSignature for Gemini 2.0+/3.0 models (required for function calling)
                const toolCall: any = {
                  id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args)
                  }
                };

                // Store thoughtSignature if present (required for Gemini 3.0+ function calls)
                if ((part as any).thoughtSignature) {
                  toolCall.thoughtSignature = (part as any).thoughtSignature;
                }

                accumulatedToolCalls.push(toolCall);
              }
            }
          }
        }

        // Success, break the retry loop
        break;

      } catch (error: any) {
        // Check for rate limit error (429)
        if (error.status === 429 || error.code === 429 || error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
          retryCount++;
          if (retryCount > maxRetries) {
            throw error;
          }

          console.warn(`[GoogleCompletionClient] Rate limit hit. Retrying (${retryCount}/${maxRetries})...`);

          // Calculate delay
          let delay = baseDelay * Math.pow(2, retryCount - 1);

          // Try to parse retry delay from error details if available
          // Error format: { error: { details: [ { retryDelay: "45s" } ] } }
          try {
            if (error.message) {
              const messageJson = JSON.parse(error.message);
              const details = messageJson.error?.details;
              if (Array.isArray(details)) {
                const retryInfo = details.find((d: any) => d.retryDelay);
                if (retryInfo && retryInfo.retryDelay) {
                  const seconds = parseFloat(retryInfo.retryDelay.replace('s', ''));
                  if (!isNaN(seconds)) {
                    delay = seconds * 1000;
                  }
                }
              }
            }
          } catch (e) {
            // Ignore parsing errors
          }

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Re-throw other errors
        throw error;
      }
    }
    // Stream finished. Emit OutputItemDone if we have content/tools.
    if (accumulatedText || accumulatedToolCalls.length > 0) {
      const messageItem: any = {
        type: 'message',
        role: 'assistant',
        content: []
      };

      if (accumulatedText) {
        messageItem.content.push({ type: 'output_text', text: accumulatedText });
      }

      if (accumulatedToolCalls.length > 0) {
        messageItem.tool_calls = accumulatedToolCalls;
      }

      stream.addEvent({
        type: 'OutputItemDone',
        item: messageItem
      });
    }

    // Emit Completed
    stream.addEvent({
      type: 'Completed',
      responseId: 'gemini-response', // TODO: Get actual ID if available
      tokenUsage: usageMetadata ? {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        total_tokens: usageMetadata.totalTokenCount || 0,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0
      } : undefined
    });

  }

  private mapTools(tools?: ToolDefinition[]): any {
    if (!tools || tools.length === 0) return undefined;

    return {
      functionDeclarations: tools
        .filter(tool => tool.type === 'function')
        .map(tool => {
          // We checked type above, so cast is safe or TS infers it
          const fnTool = tool as Extract<ToolDefinition, { type: 'function' }>;

          // Sanitize schema
          const parameters = this.sanitizeSchema(fnTool.function.parameters);

          return {
            name: fnTool.function.name,
            description: fnTool.function.description,
            parameters: parameters
          };
        })
    };
  }

  private async mapPromptToContents(prompt: Prompt): Promise<any[]> {
    const formattedInput = await get_formatted_input(prompt);
    const contents: any[] = [];

    if (!formattedInput) return contents;

    // Build call_id to name map for function responses
    const callIdToName = new Map<string, string>();
    for (const item of prompt.input) {
      if (item.type === 'message' && item.tool_calls) {
        for (const tc of item.tool_calls) {
          callIdToName.set(tc.id, tc.function.name);
        }
      } else if (item.type === 'function_call') {
        callIdToName.set(item.call_id || item.id || '', item.name);
      }
    }

    for (const item of formattedInput) {
      if (item.type === 'message') {
        const role = item.role === 'assistant' ? 'model' : 'user';

        // Handle tool calls in assistant message
        if (item.tool_calls && item.tool_calls.length > 0) {
          const parts: any[] = [];

          // Add text content if present (thought/reasoning)
          if (item.content) {
            if (Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.type === 'text' || part.type === 'output_text') {
                  parts.push({ text: part.text });
                }
              }
            } else if (typeof item.content === 'string') {
              parts.push({ text: item.content });
            }
          }

          // Add function calls with thoughtSignature if present (required for Gemini 3.0+)
          const toolParts = item.tool_calls.map((tc: any) => {
            const part: any = {
              functionCall: {
                name: tc.function.name,
                args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
              }
            };
            // Pass back thoughtSignature exactly as received (required for Gemini 3.0+ function calls)
            if (tc.thoughtSignature) {
              part.thoughtSignature = tc.thoughtSignature;
            }
            return part;
          });
          parts.push(...toolParts);

          contents.push({ role, parts });
          continue;
        }

        // Handle text content
        let parts: any[] = [];
        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
              parts.push({ text: part.text });
            } else if (part.type === 'input_image') {
              if (part.image_url.startsWith('data:')) {
                const [mimeType, base64] = part.image_url.split(';base64,');
                parts.push({
                  inlineData: {
                    mimeType: mimeType.replace('data:', ''),
                    data: base64
                  }
                });
              }
            }
          }
        } else if (typeof item.content === 'string') {
          parts.push({ text: item.content });
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }

      } else if (item.type === 'function_call_output') {
        const functionName = callIdToName.get(item.call_id);
        if (functionName) {
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: functionName,
                response: {
                  name: functionName,
                  content: item.output
                }
              }
            }]
          });
        } else {
          console.warn(`[GoogleCompletionClient] Could not find function name for call_id: ${item.call_id}`);
        }
      }
    }

    return contents;
  }

  /**
   * Sanitize JSON schema for Gemini compatibility
   */
  private sanitizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const sanitized = { ...schema };

    if ('title' in sanitized) delete sanitized.title;

    if (sanitized.description && typeof sanitized.description === 'string' && sanitized.description.length > 1024) {
      sanitized.description = sanitized.description.substring(0, 1021) + '...';
    }

    if (sanitized.type === 'object') {
      if (!sanitized.properties) {
        sanitized.properties = {};
        sanitized.additionalProperties = true;
      }
    }

    if (sanitized.properties && schema.properties) {
      const sanitizedProps: any = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        sanitizedProps[key] = this.sanitizeSchema(value);
      }
      sanitized.properties = sanitizedProps;
      if (sanitized.additionalProperties === undefined) {
        sanitized.additionalProperties = false;
      }
    }

    if (sanitized.type === 'array' && sanitized.items) {
      sanitized.items = this.sanitizeSchema(sanitized.items);
    }

    return sanitized;
  }

  // Required abstract methods

  async * streamCompletion(request: CompletionRequest): AsyncGenerator<any> {
    // Convert CompletionRequest to Prompt and use stream()
    // Or just throw if not supported
    throw new Error('streamCompletion not implemented. Use stream() instead.');
  }

  protected async * streamResponses(request: CompletionRequest): AsyncGenerator<ResponseEvent> {
    throw new Error('streamResponses not implemented. Use stream() instead.');
  }

  protected async * streamChat(request: CompletionRequest): AsyncGenerator<ResponseEvent> {
    throw new Error('streamChat not implemented. Use stream() instead.');
  }

  protected async attemptStreamResponses(attempt: number, payload: any): Promise<ResponseStream> {
    throw new Error('attemptStreamResponses not implemented. Use stream() instead.');
  }

  protected async * processSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ResponseEvent> {
    throw new Error('processSSE not implemented.');
  }

  protected parseRateLimitSnapshot(headers?: Headers): RateLimitSnapshot | undefined {
    return undefined;
  }
}
