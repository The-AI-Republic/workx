/**
 * Groq API client implementation for pi
 * Extends OpenAIResponsesClient with Groq-specific behavior
 *
 * Key Groq Differences:
 * - Omits 'store', 'include', and 'prompt_cache_key' parameters (not supported)
 * - Uses nested reasoning object format: { effort: "low" | "medium" | "high" }
 * - Does NOT support reasoning.summary parameter
 * - Returns reasoning content in 'reasoning_content' field instead of 'content' array
 */

import type {
  ResponseEvent,
  ResponsesApiRequest,
  Prompt,
  Reasoning,
} from '../types/ResponsesAPI';
import { OpenAIResponsesClient, type OpenAIResponsesConfig } from './OpenAIResponsesClient';
import { get_formatted_input } from '../PromptHelpers';

/**
 * Groq API client using Responses API
 * Supports Qwen 3 32B (131K context) and Kimi K2 Instruct (262K context)
 */
export class GroqClient extends OpenAIResponsesClient {
  constructor(config: OpenAIResponsesConfig) {
    super(config);

    // Validate that this is actually a Groq provider
    if (config.provider.name !== 'groq') {
      console.warn(`[GroqClient] Warning: GroqClient instantiated with non-Groq provider: ${config.provider.name}`);
    }
  }

  /**
   * Override to build Groq-specific request payload
   * Groq doesn't support: store, include, prompt_cache_key parameters
   */
  protected async buildRequestPayload(prompt: Prompt): Promise<ResponsesApiRequest> {
    const fullInstructions = this.getFullInstructions(prompt);
    const toolsJson = this.createToolsJsonForResponsesApi(prompt.tools);
    const textControls = this.createTextParam(prompt.output_schema);

    // Build base payload - omit Groq-unsupported parameters
    const payload: any = {
      model: this.currentModel,
      instructions: fullInstructions,
      input: await get_formatted_input(prompt),
      tools: toolsJson,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      // Groq-specific omissions:
      // - store: not supported (omitted entirely)
      // - include: not supported (omitted entirely)
      // - prompt_cache_key: not supported (omitted entirely)
      stream: true,
      text: textControls,
    };

    // Add reasoning parameter if model supports it
    if (this.modelFamily.supports_reasoning && this.reasoningEffort) {
      payload.reasoning = this.buildReasoningParam();
    }

    return payload;
  }

  /**
   * Override to build Groq-specific reasoning parameter
   * Groq uses nested object format but does NOT support reasoning.summary
   */
  protected buildReasoningParam(): Reasoning | undefined {
    if (!this.reasoningEffort) {
      return undefined;
    }

    // Groq format: { effort: "low" | "medium" | "high" }
    // Does NOT support summary parameter (unlike OpenAI/xAI)
    return {
      effort: this.reasoningEffort
    } as Reasoning;
  }

  /**
   * Override SDK event conversion to handle Groq's reasoning_content field
   * Groq sends reasoning content in a different field than OpenAI
   */
  protected convertSDKEventToResponseEvent(sdkEvent: any): ResponseEvent[] {
    if (!sdkEvent || !sdkEvent.type) {
      return [];
    }

    const events: ResponseEvent[] = [];

    // Handle response.completed specially for Groq
    if (sdkEvent.type === 'response.completed' || sdkEvent.type === 'response.done') {
      // Extract output items from response
      if (sdkEvent.response?.output && Array.isArray(sdkEvent.response.output)) {
        for (const outputItem of sdkEvent.response.output) {
          if (outputItem && outputItem.type) {
            // Transform Groq reasoning format to standard format
            if (outputItem.type === 'reasoning') {
              this.transformGroqReasoningItem(outputItem);
            }

            events.push({
              type: 'OutputItemDone',
              item: outputItem
            });
          }
        }
      }

      // Emit the Completed event
      events.push({
        type: 'Completed',
        responseId: sdkEvent.response?.id || sdkEvent.id || '',
        tokenUsage: sdkEvent.usage ? this.convertTokenUsage(sdkEvent.usage) : undefined,
      });

      return events;
    }

    // For all other events, use parent class conversion
    return super.convertSDKEventToResponseEvent(sdkEvent);
  }

  /**
   * Transform Groq reasoning item to standard format
   * Groq uses 'reasoning_content' field (string) instead of 'content' array
   */
  private transformGroqReasoningItem(outputItem: any): void {
    if (outputItem.reasoning_content && typeof outputItem.reasoning_content === 'string') {
      // Convert Groq's reasoning_content string to standard content array format
      outputItem.content = [
        { type: 'reasoning_text', text: outputItem.reasoning_content }
      ];

      // Remove the Groq-specific field to avoid confusion
      delete outputItem.reasoning_content;
    }
  }

  /**
   * Expose protected method for token usage conversion
   */
  protected convertTokenUsage(usage: any): any {
    return (this as any).convertTokenUsage(usage);
  }
}
