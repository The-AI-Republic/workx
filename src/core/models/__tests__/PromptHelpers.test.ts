/**
 * Unit Tests: PromptHelpers
 *
 * Tests for get_full_instructions() and get_formatted_input() helper functions.
 * Covers instruction formatting, input conversion, and screenshot injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get_full_instructions, get_formatted_input } from '@/core/models/PromptHelpers';
import type { Prompt, ModelFamily } from '@/core/models/types/ResponsesAPI';
import type { ResponseItem } from '@/core/protocol/types';

// Mock the ScreenshotFileManager dependency
vi.mock('@/extension/tools/screenshot/ScreenshotFileManager', () => ({
  ScreenshotFileManager: {
    getScreenshot: vi.fn(),
  },
}));

// Import the mocked module so we can control its behavior per-test
import { ScreenshotFileManager } from '@/extension/tools/screenshot/ScreenshotFileManager';

const mockedGetScreenshot = vi.mocked(ScreenshotFileManager.getScreenshot);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeModel(overrides: Partial<ModelFamily> = {}): ModelFamily {
  return {
    family: 'gpt-4',
    base_instructions: 'You are a helpful assistant.',
    supports_reasoning: false,
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
    ...overrides,
  };
}

function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  return {
    input: [],
    tools: [],
    ...overrides,
  };
}

function makeScreenshotFunctionCallOutput(width = 1280, height = 720): ResponseItem {
  return {
    type: 'function_call_output',
    call_id: 'call_screenshot_1',
    output: JSON.stringify({
      success: true,
      action: 'screenshot',
      data: { image_file_id: 'img_1', width, height, format: 'png', viewport_bounds: { width, height, scroll_x: 0, scroll_y: 0 } },
      metadata: { duration_ms: 100, tab_id: 1, timestamp: '2025-01-01T00:00:00Z', tool_version: '1.0', toolName: 'page_vision', action: 'screenshot' },
    }),
  };
}

// -----------------------------------------------------------------------
// get_full_instructions
// -----------------------------------------------------------------------

describe('get_full_instructions', () => {
  it('should return model base_instructions when prompt has no overrides', () => {
    const prompt = makePrompt();
    const model = makeModel();

    const result = get_full_instructions(prompt, model);

    expect(result).toBe('You are a helpful assistant.');
  });

  it('should append user_instructions to base_instructions', () => {
    const prompt = makePrompt({ user_instructions: 'Follow coding best practices.' });
    const model = makeModel();

    const result = get_full_instructions(prompt, model);

    expect(result).toBe('You are a helpful assistant.\nFollow coding best practices.');
  });

  it('should use base_instructions_override instead of model base_instructions', () => {
    const prompt = makePrompt({ base_instructions_override: 'Custom system prompt.' });
    const model = makeModel();

    const result = get_full_instructions(prompt, model);

    expect(result).toBe('Custom system prompt.');
  });

  it('should combine base_instructions_override with user_instructions', () => {
    const prompt = makePrompt({
      base_instructions_override: 'Custom base.',
      user_instructions: 'Extra guidance.',
    });
    const model = makeModel();

    const result = get_full_instructions(prompt, model);

    expect(result).toBe('Custom base.\nExtra guidance.');
  });

  it('should not add extra newline when user_instructions is empty string', () => {
    const prompt = makePrompt({ user_instructions: '' });
    const model = makeModel();

    const result = get_full_instructions(prompt, model);

    // Empty string is falsy, so should not be appended
    expect(result).toBe('You are a helpful assistant.');
  });

  it('should handle model with empty base_instructions', () => {
    const prompt = makePrompt({ user_instructions: 'Only user instructions.' });
    const model = makeModel({ base_instructions: '' });

    const result = get_full_instructions(prompt, model);

    // Empty string base + user_instructions
    expect(result).toBe('\nOnly user instructions.');
  });

  it('should handle multiline user_instructions', () => {
    const prompt = makePrompt({ user_instructions: 'Line one.\nLine two.\nLine three.' });
    const model = makeModel();

    const result = get_full_instructions(prompt, model);

    expect(result).toContain('Line one.');
    expect(result).toContain('Line two.');
    expect(result).toContain('Line three.');
  });

  it('should prefer base_instructions_override even when model has instructions', () => {
    const prompt = makePrompt({ base_instructions_override: 'Override wins.' });
    const model = makeModel({ base_instructions: 'Model base.' });

    const result = get_full_instructions(prompt, model);

    expect(result).toBe('Override wins.');
    expect(result).not.toContain('Model base.');
  });
});

// -----------------------------------------------------------------------
// get_formatted_input
// -----------------------------------------------------------------------

describe('get_formatted_input', () => {
  beforeEach(() => {
    mockedGetScreenshot.mockReset();
  });

  it('should return a cloned copy of the input array', async () => {
    const input: ResponseItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    expect(result).not.toBe(prompt.input);
    expect(result).toEqual(prompt.input);
  });

  it('should return empty array for empty input', async () => {
    const prompt = makePrompt({ input: [] });

    const result = await get_formatted_input(prompt);

    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it('should not modify the original input array', async () => {
    const input: ResponseItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ];
    const prompt = makePrompt({ input });
    const originalLength = prompt.input.length;

    await get_formatted_input(prompt);

    expect(prompt.input).toHaveLength(originalLength);
  });

  it('should inject screenshot message after screenshot function_call_output', async () => {
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAUA';
    mockedGetScreenshot.mockResolvedValue(fakeBase64);

    const input: ResponseItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Take a screenshot' }] },
      { type: 'function_call', id: 'fc_1', name: 'page_vision', arguments: '{"action":"screenshot"}', call_id: 'call_screenshot_1' },
      makeScreenshotFunctionCallOutput(1280, 720),
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // Should have one additional item inserted after the screenshot output
    expect(result).toHaveLength(input.length + 1);

    // The injected message should be right after the function_call_output (index 3)
    const injected = result[3];
    expect(injected).toBeDefined();
    expect(injected.type).toBe('message');
    if (injected.type === 'message') {
      expect(injected.role).toBe('user');
      expect(injected.content).toHaveLength(2);
      expect(injected.content[0]).toEqual({
        type: 'input_text',
        text: 'Current Screenshot captured by page_vision tool: 1280x720',
      });
      expect(injected.content[1]).toEqual({
        type: 'input_image',
        image_url: `data:image/png;base64,${fakeBase64}`,
      });
    }
  });

  it('should only inject screenshot for the last screenshot output (iterates backwards)', async () => {
    const fakeBase64 = 'abc123';
    mockedGetScreenshot.mockResolvedValue(fakeBase64);

    const input: ResponseItem[] = [
      makeScreenshotFunctionCallOutput(800, 600),
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now do another' }] },
      makeScreenshotFunctionCallOutput(1920, 1080),
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // Only the LAST screenshot (1920x1080) should trigger injection
    expect(result).toHaveLength(input.length + 1);

    // The injected item should be at index 3 (after the second screenshot output at index 2)
    const injected = result[3];
    expect(injected.type).toBe('message');
    if (injected.type === 'message') {
      expect(injected.content[0]).toEqual({
        type: 'input_text',
        text: 'Current Screenshot captured by page_vision tool: 1920x1080',
      });
    }

    // getScreenshot should be called only once (breaks after first match going backwards)
    expect(mockedGetScreenshot).toHaveBeenCalledTimes(1);
  });

  it('should not inject screenshot when getScreenshot returns null', async () => {
    mockedGetScreenshot.mockResolvedValue(null);

    const input: ResponseItem[] = [
      makeScreenshotFunctionCallOutput(),
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // No injection when screenshot data is null
    expect(result).toHaveLength(input.length);
  });

  it('should handle non-screenshot function_call_output without injection', async () => {
    const input: ResponseItem[] = [
      {
        type: 'function_call_output',
        call_id: 'call_other_1',
        output: JSON.stringify({ result: 'some data', metadata: { toolName: 'other_tool' } }),
      },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // No screenshot injection
    expect(result).toHaveLength(1);
    expect(mockedGetScreenshot).not.toHaveBeenCalled();
  });

  it('should handle malformed JSON in function_call_output gracefully', async () => {
    const input: ResponseItem[] = [
      {
        type: 'function_call_output',
        call_id: 'call_bad_1',
        output: 'not valid json {{{',
      },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // Should not throw, just continue
    expect(result).toHaveLength(1);
    expect(mockedGetScreenshot).not.toHaveBeenCalled();
  });

  it('should handle function_call_output where metadata.action is not screenshot', async () => {
    const input: ResponseItem[] = [
      {
        type: 'function_call_output',
        call_id: 'call_click_1',
        output: JSON.stringify({
          success: true,
          action: 'click',
          metadata: { toolName: 'page_vision', action: 'click', duration_ms: 50, tab_id: 1, timestamp: '', tool_version: '1.0' },
        }),
      },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    expect(result).toHaveLength(1);
    expect(mockedGetScreenshot).not.toHaveBeenCalled();
  });

  it('should pass through non-function_call_output items unchanged', async () => {
    const input: ResponseItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] },
      { type: 'function_call', id: 'fc_1', name: 'tool', arguments: '{}', call_id: 'call_1' },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    expect(result).toHaveLength(3);
    expect(result).toEqual(input);
  });

  it('should construct correct data URL with base64 screenshot data', async () => {
    const fakeBase64 = 'AAAA/BBBB+CCCC==';
    mockedGetScreenshot.mockResolvedValue(fakeBase64);

    const input: ResponseItem[] = [makeScreenshotFunctionCallOutput()];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);
    const injected = result[1];

    if (injected.type === 'message') {
      const imageContent = injected.content[1];
      if (imageContent.type === 'input_image') {
        expect(imageContent.image_url).toBe('data:image/png;base64,AAAA/BBBB+CCCC==');
      }
    }
  });

  it('should use width and height from screenshot metadata in the text description', async () => {
    mockedGetScreenshot.mockResolvedValue('data');

    const input: ResponseItem[] = [makeScreenshotFunctionCallOutput(3840, 2160)];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);
    const injected = result[1];

    if (injected.type === 'message') {
      expect(injected.content[0]).toEqual({
        type: 'input_text',
        text: 'Current Screenshot captured by page_vision tool: 3840x2160',
      });
    }
  });

  it('should handle mixed items with screenshot in the middle', async () => {
    const fakeBase64 = 'screenshot_data';
    mockedGetScreenshot.mockResolvedValue(fakeBase64);

    const input: ResponseItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start' }] },
      makeScreenshotFunctionCallOutput(640, 480),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'After screenshot' }] },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // Iterates backwards, finds the screenshot at index 1
    // But wait: the last item going backwards that is function_call_output with screenshot is at index 1
    // Actually, let's verify: the loop goes from end to start, item at index 2 is a message (skip),
    // item at index 1 is the screenshot function_call_output (match). Injects after it at index 2.
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe('message'); // original user message
    expect(result[1].type).toBe('function_call_output'); // screenshot output
    expect(result[2].type).toBe('message'); // injected screenshot message
    if (result[2].type === 'message') {
      expect(result[2].role).toBe('user');
    }
    expect(result[3].type).toBe('message'); // original assistant message
  });

  it('should handle function_call_output with missing metadata field', async () => {
    const input: ResponseItem[] = [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ success: true, data: {} }),
      },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    // No metadata.toolName === 'page_vision', so no injection
    expect(result).toHaveLength(1);
    expect(mockedGetScreenshot).not.toHaveBeenCalled();
  });

  it('should handle function_call_output with metadata.toolName !== page_vision', async () => {
    const input: ResponseItem[] = [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({
          success: true,
          metadata: { toolName: 'some_other_tool', action: 'screenshot' },
        }),
      },
    ];
    const prompt = makePrompt({ input });

    const result = await get_formatted_input(prompt);

    expect(result).toHaveLength(1);
    expect(mockedGetScreenshot).not.toHaveBeenCalled();
  });

  it('should handle getScreenshot rejecting with an error gracefully', async () => {
    mockedGetScreenshot.mockRejectedValue(new Error('Storage failure'));

    const input: ResponseItem[] = [makeScreenshotFunctionCallOutput()];
    const prompt = makePrompt({ input });

    // The outer try/catch should catch and log the error
    // The function should NOT throw
    // Actually - looking at the code, the try/catch is inside the loop
    // and catches JSON parse errors. The await on getScreenshot is inside
    // the try block so this error WILL be caught.
    const result = await get_formatted_input(prompt);

    // The error is caught, no injection happens, returns the cloned input
    expect(result).toHaveLength(1);
  });
});
