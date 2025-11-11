/**
 * Logging utilities for BrowserX Chrome Extension
 * Provides trace-level logging for Gemini streaming debugging
 */

/**
 * Environment variable check for Gemini debug logging
 * Set GEMINI_DEBUG=true in environment to enable trace logs
 */
const isGeminiDebugEnabled = (): boolean => {
  // Check multiple sources for debug flag
  if (typeof process !== 'undefined' && process.env?.GEMINI_DEBUG === 'true') {
    return true;
  }
  // Check localStorage for browser environment
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem('GEMINI_DEBUG') === 'true';
    } catch {
      return false;
    }
  }
  return false;
};

/**
 * Gemini-specific logger for streaming event debugging
 * Only logs when GEMINI_DEBUG environment variable is set to 'true'
 */
export class GeminiLogger {
  private static enabled = isGeminiDebugEnabled();

  /**
   * Log stream start event
   */
  static streamStart(modelName: string, conversationId: string): void {
    if (!this.enabled) return;
    console.log(`[Gemini] Stream starting - Model: ${modelName}, Conversation: ${conversationId}`);
  }

  /**
   * Log stream end event
   */
  static streamEnd(conversationId: string, totalChunks?: number): void {
    if (!this.enabled) return;
    const chunksInfo = totalChunks !== undefined ? `, Total chunks: ${totalChunks}` : '';
    console.log(`[Gemini] Stream ended - Conversation: ${conversationId}${chunksInfo}`);
  }

  /**
   * Log streaming chunk received
   */
  static chunkReceived(chunkData: any): void {
    if (!this.enabled) return;
    console.log('[Gemini] Stream chunk received:', JSON.stringify(chunkData, null, 2));
  }

  /**
   * Log text delta emission
   */
  static textDelta(delta: string, accumulatedLength: number): void {
    if (!this.enabled) return;
    console.log(`[Gemini] Text delta emitted: "${delta}" (accumulated ${accumulatedLength} chars)`);
  }

  /**
   * Log text accumulation
   */
  static textAccumulated(deltaText: string, totalAccumulated: number): void {
    if (!this.enabled) return;
    console.log(`[Gemini] Text accumulated: +${deltaText.length} chars, total: ${totalAccumulated} chars`);
  }

  /**
   * Log tool call delta accumulation
   */
  static toolCallDelta(index: number, functionName: string | undefined, argsLength: number): void {
    if (!this.enabled) return;
    const funcInfo = functionName ? ` function="${functionName}"` : '';
    console.log(`[Gemini] Tool call delta [${index}]:${funcInfo} args_length=${argsLength}`);
  }

  /**
   * Log tool call accumulation complete
   */
  static toolCallAccumulated(toolCalls: any[]): void {
    if (!this.enabled) return;
    const summary = toolCalls.map(tc => `${tc.function?.name}(${tc.function?.arguments?.length || 0} chars)`).join(', ');
    console.log(`[Gemini] Tool calls accumulated: [${summary}]`);
  }

  /**
   * Log finish reason received
   */
  static finishReason(reason: string, hasContent: boolean, hasToolCalls: boolean): void {
    if (!this.enabled) return;
    console.log(`[Gemini] Finish reason: "${reason}", hasContent=${hasContent}, hasToolCalls=${hasToolCalls}`);
  }

  /**
   * Log OutputItemDone emission with message
   */
  static messageItemEmitted(textLength: number): void {
    if (!this.enabled) return;
    console.log(`[Gemini] Emitting OutputItemDone: message (${textLength} chars)`);
  }

  /**
   * Log OutputItemDone emission with function calls
   */
  static functionCallItemEmitted(toolCount: number, toolNames: string[]): void {
    if (!this.enabled) return;
    console.log(`[Gemini] Emitting OutputItemDone: function_calls (${toolCount} tools: ${toolNames.join(', ')})`);
  }

  /**
   * Log Completed event emission
   */
  static completedEmitted(tokenUsage?: any): void {
    if (!this.enabled) return;
    const usageInfo = tokenUsage ? ` tokens: ${JSON.stringify(tokenUsage)}` : '';
    console.log(`[Gemini] Emitting Completed${usageInfo}`);
  }

  /**
   * Log validation warning
   */
  static validationWarning(message: string, context?: any): void {
    if (!this.enabled) return;
    const contextInfo = context ? ` - ${JSON.stringify(context)}` : '';
    console.warn(`[Gemini] VALIDATION WARNING: ${message}${contextInfo}`);
  }

  /**
   * Log state reset
   */
  static stateReset(): void {
    if (!this.enabled) return;
    console.log('[Gemini] State reset: chatCompletionTextContent and chatCompletionToolCalls cleared');
  }

  /**
   * Generic debug log
   */
  static debug(message: string, data?: any): void {
    if (!this.enabled) return;
    const dataInfo = data !== undefined ? ` - ${JSON.stringify(data)}` : '';
    console.log(`[Gemini] ${message}${dataInfo}`);
  }

  /**
   * Enable logging at runtime
   */
  static enable(): void {
    this.enabled = true;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('GEMINI_DEBUG', 'true');
    }
    console.log('[Gemini] Debug logging ENABLED');
  }

  /**
   * Disable logging at runtime
   */
  static disable(): void {
    console.log('[Gemini] Debug logging DISABLED');
    this.enabled = false;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('GEMINI_DEBUG');
    }
  }

  /**
   * Check if logging is enabled
   */
  static isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Export convenience function for checking debug status
 */
export const isGeminiDebugEnabled_export = isGeminiDebugEnabled;
