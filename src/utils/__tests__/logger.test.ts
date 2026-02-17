/**
 * Unit tests for GeminiLogger
 * Target: src/utils/logger.ts
 *
 * Tests the GeminiLogger class methods, enable/disable toggling,
 * environment detection, and all log format outputs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to control the `enabled` state. The module evaluates
// isGeminiDebugEnabled() at import time (static initializer), so we
// re-import after manipulating environment in some tests.

describe('GeminiLogger', () => {
  let GeminiLogger: typeof import('@/utils/logger').GeminiLogger;
  let isGeminiDebugEnabled_export: typeof import('@/utils/logger').isGeminiDebugEnabled_export;

  beforeEach(async () => {
    // Fresh import each time so static `enabled` is re-evaluated
    vi.resetModules();
    const mod = await import('@/utils/logger');
    GeminiLogger = mod.GeminiLogger;
    isGeminiDebugEnabled_export = mod.isGeminiDebugEnabled_export;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ======================================================================
  // isGeminiDebugEnabled
  // ======================================================================

  describe('isGeminiDebugEnabled', () => {
    it('should return false when no debug flags are set', () => {
      expect(isGeminiDebugEnabled_export()).toBe(false);
    });

    it('should return true when process.env.GEMINI_DEBUG is "true"', async () => {
      vi.resetModules();
      process.env.GEMINI_DEBUG = 'true';
      const mod = await import('@/utils/logger');
      expect(mod.isGeminiDebugEnabled_export()).toBe(true);
      delete process.env.GEMINI_DEBUG;
    });

    it('should return false when process.env.GEMINI_DEBUG is not "true"', () => {
      process.env.GEMINI_DEBUG = 'false';
      expect(isGeminiDebugEnabled_export()).toBe(false);
      delete process.env.GEMINI_DEBUG;
    });

    it('should check localStorage when process.env is not set', () => {
      // localStorage is available in jsdom
      localStorage.setItem('GEMINI_DEBUG', 'true');
      expect(isGeminiDebugEnabled_export()).toBe(true);
      localStorage.removeItem('GEMINI_DEBUG');
    });

    it('should return false when localStorage GEMINI_DEBUG is not "true"', () => {
      localStorage.setItem('GEMINI_DEBUG', 'false');
      expect(isGeminiDebugEnabled_export()).toBe(false);
      localStorage.removeItem('GEMINI_DEBUG');
    });

    it('should return false when localStorage throws', () => {
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(isGeminiDebugEnabled_export()).toBe(false);
      getItemSpy.mockRestore();
    });
  });

  // ======================================================================
  // enable / disable / isEnabled
  // ======================================================================

  describe('enable / disable / isEnabled', () => {
    it('should start disabled by default', () => {
      expect(GeminiLogger.isEnabled()).toBe(false);
    });

    it('should enable logging at runtime', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      GeminiLogger.enable();
      expect(GeminiLogger.isEnabled()).toBe(true);
      expect(logSpy).toHaveBeenCalledWith('[Gemini] Debug logging ENABLED');
    });

    it('should set localStorage when enabling', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      GeminiLogger.enable();
      expect(localStorage.getItem('GEMINI_DEBUG')).toBe('true');
      localStorage.removeItem('GEMINI_DEBUG');
    });

    it('should disable logging at runtime', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      GeminiLogger.enable();
      GeminiLogger.disable();
      expect(GeminiLogger.isEnabled()).toBe(false);
      expect(logSpy).toHaveBeenCalledWith('[Gemini] Debug logging DISABLED');
    });

    it('should remove localStorage when disabling', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      GeminiLogger.enable();
      expect(localStorage.getItem('GEMINI_DEBUG')).toBe('true');
      GeminiLogger.disable();
      expect(localStorage.getItem('GEMINI_DEBUG')).toBeNull();
    });
  });

  // ======================================================================
  // Log methods — when disabled (should be silent)
  // ======================================================================

  describe('when disabled (all methods should be silent)', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Ensure disabled
      expect(GeminiLogger.isEnabled()).toBe(false);
    });

    it('streamStart should not log', () => {
      GeminiLogger.streamStart('gemini-pro', 'conv-1');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('streamEnd should not log', () => {
      GeminiLogger.streamEnd('conv-1', 42);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('chunkReceived should not log', () => {
      GeminiLogger.chunkReceived({ text: 'hello' });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('textDelta should not log', () => {
      GeminiLogger.textDelta('hello', 5);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('textAccumulated should not log', () => {
      GeminiLogger.textAccumulated('chunk', 100);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('toolCallDelta should not log', () => {
      GeminiLogger.toolCallDelta(0, 'search', 50);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('toolCallAccumulated should not log', () => {
      GeminiLogger.toolCallAccumulated([]);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('finishReason should not log', () => {
      GeminiLogger.finishReason('stop', true, false);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('messageItemEmitted should not log', () => {
      GeminiLogger.messageItemEmitted(100);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('functionCallItemEmitted should not log', () => {
      GeminiLogger.functionCallItemEmitted(2, ['search', 'read']);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('completedEmitted should not log', () => {
      GeminiLogger.completedEmitted({ input: 100, output: 50 });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('validationWarning should not warn', () => {
      GeminiLogger.validationWarning('bad input', { key: 'val' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('stateReset should not log', () => {
      GeminiLogger.stateReset();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('debug should not log', () => {
      GeminiLogger.debug('test message', { data: 1 });
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  // ======================================================================
  // Log methods — when enabled (should produce formatted output)
  // ======================================================================

  describe('when enabled (all methods should log)', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      GeminiLogger.enable();
      // Clear the enable log call
      logSpy.mockClear();
    });

    it('streamStart should log model and conversation', () => {
      GeminiLogger.streamStart('gemini-pro', 'conv-123');
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Stream starting - Model: gemini-pro, Conversation: conv-123'
      );
    });

    it('streamEnd should log conversation and chunks', () => {
      GeminiLogger.streamEnd('conv-123', 42);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Stream ended - Conversation: conv-123, Total chunks: 42'
      );
    });

    it('streamEnd should omit chunk info when not provided', () => {
      GeminiLogger.streamEnd('conv-123');
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Stream ended - Conversation: conv-123'
      );
    });

    it('chunkReceived should log JSON-formatted chunk data', () => {
      const chunkData = { text: 'hello', index: 0 };
      GeminiLogger.chunkReceived(chunkData);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Stream chunk received:',
        JSON.stringify(chunkData, null, 2)
      );
    });

    it('textDelta should log delta text and accumulated length', () => {
      GeminiLogger.textDelta('world', 10);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Text delta emitted: "world" (accumulated 10 chars)'
      );
    });

    it('textAccumulated should log char count and total', () => {
      GeminiLogger.textAccumulated('hello', 100);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Text accumulated: +5 chars, total: 100 chars'
      );
    });

    it('toolCallDelta should log index, function name, and args length', () => {
      GeminiLogger.toolCallDelta(0, 'search', 50);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Tool call delta [0]: function="search" args_length=50'
      );
    });

    it('toolCallDelta should omit function name when undefined', () => {
      GeminiLogger.toolCallDelta(1, undefined, 25);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Tool call delta [1]: args_length=25'
      );
    });

    it('toolCallAccumulated should log tool call summary', () => {
      const toolCalls = [
        { function: { name: 'search', arguments: '{"q":"test"}' } },
        { function: { name: 'read', arguments: '{"path":"/a"}' } },
      ];
      GeminiLogger.toolCallAccumulated(toolCalls);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Tool calls accumulated: [search(12 chars), read(13 chars)]'
      );
    });

    it('toolCallAccumulated should handle missing function arguments', () => {
      const toolCalls = [
        { function: { name: 'search' } },
      ];
      GeminiLogger.toolCallAccumulated(toolCalls);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Tool calls accumulated: [search(0 chars)]'
      );
    });

    it('finishReason should log reason and flags', () => {
      GeminiLogger.finishReason('stop', true, false);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Finish reason: "stop", hasContent=true, hasToolCalls=false'
      );
    });

    it('finishReason should log with tool_calls reason', () => {
      GeminiLogger.finishReason('tool_calls', false, true);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Finish reason: "tool_calls", hasContent=false, hasToolCalls=true'
      );
    });

    it('messageItemEmitted should log text length', () => {
      GeminiLogger.messageItemEmitted(256);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Emitting OutputItemDone: message (256 chars)'
      );
    });

    it('functionCallItemEmitted should log tool count and names', () => {
      GeminiLogger.functionCallItemEmitted(2, ['search', 'read']);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Emitting OutputItemDone: function_calls (2 tools: search, read)'
      );
    });

    it('completedEmitted should log token usage when provided', () => {
      const usage = { input: 100, output: 50 };
      GeminiLogger.completedEmitted(usage);
      expect(logSpy).toHaveBeenCalledWith(
        `[Gemini] Emitting Completed tokens: ${JSON.stringify(usage)}`
      );
    });

    it('completedEmitted should omit token info when not provided', () => {
      GeminiLogger.completedEmitted();
      expect(logSpy).toHaveBeenCalledWith('[Gemini] Emitting Completed');
    });

    it('validationWarning should use console.warn', () => {
      GeminiLogger.validationWarning('Missing field');
      expect(warnSpy).toHaveBeenCalledWith(
        '[Gemini] VALIDATION WARNING: Missing field'
      );
    });

    it('validationWarning should include context when provided', () => {
      const ctx = { field: 'name', value: null };
      GeminiLogger.validationWarning('Missing field', ctx);
      expect(warnSpy).toHaveBeenCalledWith(
        `[Gemini] VALIDATION WARNING: Missing field - ${JSON.stringify(ctx)}`
      );
    });

    it('stateReset should log reset message', () => {
      GeminiLogger.stateReset();
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] State reset: chatCompletionTextContent and chatCompletionToolCalls cleared'
      );
    });

    it('debug should log message without data', () => {
      GeminiLogger.debug('Simple message');
      expect(logSpy).toHaveBeenCalledWith('[Gemini] Simple message');
    });

    it('debug should log message with data', () => {
      GeminiLogger.debug('With data', { key: 'value' });
      expect(logSpy).toHaveBeenCalledWith(
        `[Gemini] With data - ${JSON.stringify({ key: 'value' })}`
      );
    });

    it('debug should handle undefined data explicitly passed', () => {
      GeminiLogger.debug('No data', undefined);
      expect(logSpy).toHaveBeenCalledWith('[Gemini] No data');
    });
  });

  // ======================================================================
  // Edge cases
  // ======================================================================

  describe('edge cases', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('enable then disable then enable should work', () => {
      GeminiLogger.enable();
      expect(GeminiLogger.isEnabled()).toBe(true);
      GeminiLogger.disable();
      expect(GeminiLogger.isEnabled()).toBe(false);
      GeminiLogger.enable();
      expect(GeminiLogger.isEnabled()).toBe(true);
    });

    it('chunkReceived should handle null chunk data', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      GeminiLogger.chunkReceived(null);
      expect(logSpy).toHaveBeenCalledWith('[Gemini] Stream chunk received:', 'null');
    });

    it('toolCallAccumulated should handle empty array', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      GeminiLogger.toolCallAccumulated([]);
      expect(logSpy).toHaveBeenCalledWith('[Gemini] Tool calls accumulated: []');
    });

    it('streamEnd with totalChunks of 0 should include chunk info', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      GeminiLogger.streamEnd('conv-1', 0);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Stream ended - Conversation: conv-1, Total chunks: 0'
      );
    });

    it('textAccumulated with empty delta should log 0 chars', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      GeminiLogger.textAccumulated('', 50);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Text accumulated: +0 chars, total: 50 chars'
      );
    });

    it('functionCallItemEmitted with empty tool names', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      GeminiLogger.functionCallItemEmitted(0, []);
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Emitting OutputItemDone: function_calls (0 tools: )'
      );
    });

    it('debug with complex nested data', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      const data = { nested: { deep: [1, 2, 3] } };
      GeminiLogger.debug('Complex', data);
      expect(logSpy).toHaveBeenCalledWith(
        `[Gemini] Complex - ${JSON.stringify(data)}`
      );
    });

    it('completedEmitted with empty object token usage', () => {
      GeminiLogger.enable();
      logSpy.mockClear();
      GeminiLogger.completedEmitted({});
      expect(logSpy).toHaveBeenCalledWith(
        '[Gemini] Emitting Completed tokens: {}'
      );
    });
  });
});
