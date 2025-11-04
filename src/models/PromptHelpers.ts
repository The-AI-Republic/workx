/**
 * Prompt Helper Functions
 *
 * Utility functions for working with Prompt structures.
 */

import type { Prompt, ModelFamily, ResponseItem } from './types/ResponsesAPI';
import type { ContentItem } from '../protocol/types';
import { ScreenshotFileManager } from '../tools/screenshot/ScreenshotFileManager';
import { SCREENSHOT_CACHE_KEY } from '@/tools/screenshot/types';

/**
 * Get full instructions by combining base instructions with user instructions.
 *
 * @param prompt - The prompt containing optional instruction overrides
 * @param model - The model family configuration with base instructions
 * @returns Combined instructions string (base + user instructions)
 *
 * @example
 * ```typescript
 * const prompt: Prompt = {
 *   input: [],
 *   tools: [],
 *   user_instructions: 'Follow coding best practices.',
 * };
 *
 * const model: ModelFamily = {
 *   family: 'gpt-5',
 *   base_instructions: 'You are a helpful coding assistant.',
 *   supports_reasoning_summaries: true,
 *   needs_special_apply_patch_instructions: false,
 * };
 *
 * const instructions = get_full_instructions(prompt, model);
 * // Result: "You are a helpful coding assistant.\nFollow coding best practices."
 * ```
 */
export function get_full_instructions(prompt: Prompt, model: ModelFamily): string {
  // Use base_instructions_override if present, otherwise use model's base_instructions
  const base = prompt.base_instructions_override || model.base_instructions;

  // Build parts array for joining
  const parts = [base];

  // Add user_instructions if present
  if (prompt.user_instructions) {
    parts.push(prompt.user_instructions);
  }

  // TODO: Add apply_patch tool instructions if needed (future enhancement)
  // if (!prompt.base_instructions_override && model.needs_special_apply_patch_instructions) {
  //   const hasApplyPatchTool = prompt.tools.some(tool =>
  //     tool.type === 'function' && tool.function.name === 'apply_patch'
  //   );
  //   if (!hasApplyPatchTool) {
  //     parts.push(APPLY_PATCH_TOOL_INSTRUCTIONS);
  //   }
  // }

  return parts.join('\n');
}

/**
 * Get formatted input for API request.
 *
 * Returns a cloned copy of the input array to prevent mutations.
 *
 * @param prompt - The prompt containing input items
 * @returns Cloned array of ResponseItem
 *
 * @example
 * ```typescript
 * const prompt: Prompt = {
 *   input: [
 *     { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
 *     { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] },
 *   ],
 *   tools: [],
 * };
 *
 * const formattedInput = get_formatted_input(prompt);
 * // Returns cloned array (not same reference as prompt.input)
 * console.log(formattedInput !== prompt.input); // true
 * console.log(formattedInput.length); // 2
 * ```
 */
export async function get_formatted_input(prompt: Prompt): Promise<ResponseItem[]> {
  // Clone the input array to prevent mutations
  const items = [...prompt.input];

  // Iterate backwards to find the last screenshot function call output
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    
    if (item?.type === 'function_call_output') {
      try {
        const output = JSON.parse(item.output);
        
        // If it's a screenshot action, get the image and insert it after this item
        if (output?.metadata?.toolName === 'page_vision' && output?.metadata?.action === 'screenshot') {
          const screenshotData = await ScreenshotFileManager.getScreenshot();

          if (screenshotData) {
            // Convert screenshot data to data URL
            const dataUrl = `data:image/png;base64,${screenshotData}`;

            // Insert image message right after the function call output
            items.splice(i + 1, 0, {
              type: 'message' as const,
              role: 'user',
              content: [
                { type: 'input_text' as const, text: `Current Screenshot captured by page_vision tool: ${output.data.width}x${output.data.height}` },
                { type: 'input_image' as const, image_url: dataUrl }
              ]
            } as ResponseItem);
          }

          // Only process the last screenshot in the list
          break;
        }
      } catch (error) {
        console.debug('[PromptHelpers] Failed to parse function call output:', error);
      }
    }
  }

  return items;
}
