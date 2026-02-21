/**
 * Fireworks AI API client implementation for pi
 * Extends OpenAIResponsesClient with Fireworks-specific behavior
 *
 * Key Fireworks Differences:
 * - Omits 'store' parameter (not supported, similar to xAI)
 * - Omits 'include' parameter (not supported)
 * - Omits 'prompt_cache_key' parameter (not supported)
 * - Uses nested reasoning object format: { effort: "low" | "medium" | "high" }
 * - Does NOT support reasoning.summary parameter
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
 * Fireworks AI API client using Responses API
 * Supports Kimi K2 Thinking model with 262K context
 */
export class FireworksClient extends OpenAIResponsesClient {
  constructor(config: OpenAIResponsesConfig) {
    super(config);

    // Validate that this is actually a Fireworks provider
    if (config.provider.name !== 'Fireworks AI') {
      console.warn(`[FireworksClient] Warning: FireworksClient instantiated with non-Fireworks provider: ${config.provider.name}`);
    }
  }

  /**
   * Override to build Fireworks-specific request payload
   * Fireworks doesn't support: store, include, prompt_cache_key parameters
   */
  protected async buildRequestPayload(prompt: Prompt): Promise<ResponsesApiRequest> {
    const fullInstructions = this.getFullInstructions(prompt);
    const toolsJson = this.createToolsJsonForResponsesApi(prompt.tools);
    const textControls = this.createTextParam(prompt.output_schema);
    const formattedInput = await get_formatted_input(prompt);

    // Build base payload - omit Fireworks-unsupported parameters
    const payload: any = {
      model: this.currentModel,
      instructions: fullInstructions,
      input: formattedInput,
      tools: toolsJson,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      // Fireworks-specific omissions:
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
   * Override to build Fireworks-specific reasoning parameter
   * Fireworks uses nested object format but does NOT support reasoning.summary
   */
  protected buildReasoningParam(): Reasoning | undefined {
    if (!this.reasoningEffort) {
      return undefined;
    }

    // Fireworks format: { effort: "low" | "medium" | "high" }
    // Does NOT support summary parameter (similar to Groq)
    return {
      effort: this.reasoningEffort
    } as Reasoning;
  }

  /**
   * Override SDK event conversion to handle Fireworks-specific response format
   * Fireworks sends reasoning content in 'reasoning_content' field (similar to Groq)
   */
  protected convertSDKEventToResponseEvent(sdkEvent: any): ResponseEvent[] {
    if (!sdkEvent || !sdkEvent.type) {
      return [];
    }

    const events: ResponseEvent[] = [];

    // Handle response.completed specially for Fireworks
    if (sdkEvent.type === 'response.completed' || sdkEvent.type === 'response.done') {

      // Extract output items from response
      if (sdkEvent.response?.output && Array.isArray(sdkEvent.response.output)) {

        for (const outputItem of sdkEvent.response.output) {
          if (outputItem && outputItem.type) {
            // Transform Fireworks reasoning format to standard format
            if (outputItem.type === 'reasoning') {
              this.transformFireworksReasoningItem(outputItem);
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
    const parentEvents = super.convertSDKEventToResponseEvent(sdkEvent);

    return parentEvents;
  }

  /**
   * Transform Fireworks reasoning item to standard format
   * Fireworks uses 'reasoning_content' field (string) instead of 'content' array
   */
  private transformFireworksReasoningItem(outputItem: any): void {

    if (outputItem.reasoning_content && typeof outputItem.reasoning_content === 'string') {
      // Convert Fireworks's reasoning_content string to standard content array format
      outputItem.content = [
        { type: 'reasoning_text', text: outputItem.reasoning_content }
      ];

      // Remove the Fireworks-specific field to avoid confusion
      delete outputItem.reasoning_content;
    }
  }

  /**
   * Helper to convert token usage (exposed from parent class)
   */
  protected convertTokenUsage(usage: any): any {
    return {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    };
  }
}
