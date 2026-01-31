/**
 * Event mapping logic
 * Converts ResponseItem into EventMsg values that the UI can render
 */

import type { EventMsg } from '../../protocol/events';
import type { ResponseItem } from '../../protocol/types';

/**
 * Convert a ResponseItem into zero or more EventMsg values that the UI can render.
 *
 * When show_raw_agent_reasoning is false, raw reasoning content events are omitted.
 */
export function mapResponseItemToEventMessages(
  item: ResponseItem,
  showRawAgentReasoning: boolean
): EventMsg[] {
  switch (item.type) {
    case 'message': {
      const { role, content } = item;

      // Do not surface system messages as user events.
      if (role === 'system') {
        return [];
      }

      const events: EventMsg[] = [];
      const messageParts: string[] = [];
      const images: string[] = [];
      let kind: 'plain' | 'user_instructions' | 'environment_context' | null = null;

      // Handle reasoning_content field (for thinking models like Kimi K2, o1, o3)
      // Note: reasoning_content is already emitted as ReasoningContentDelta events during streaming
      // We don't emit it again here to avoid duplication
      // The reasoning_content is stored in the message item for conversation history
      // and will be sent back to the API in multi-turn conversations

      for (const contentItem of content) {
        switch (contentItem.type) {
          case 'text':
          case 'input_text': {
            // Handle both 'text' and 'input_text' content types for user messages
            if (kind === null) {
              const trimmed = contentItem.text.trimStart();
              if (trimmed.startsWith('<environment_context>')) {
                kind = 'environment_context';
              } else if (trimmed.startsWith('<user_instructions>')) {
                kind = 'user_instructions';
              } else {
                kind = 'plain';
              }
            }
            messageParts.push(contentItem.text);
            break;
          }
          case 'input_image': {
            images.push(contentItem.image_url);
            break;
          }
          case 'output_text': {
            events.push({
              type: 'AgentMessage',
              data: { message: contentItem.text },
            });
            break;
          }
        }
      }

      if (messageParts.length > 0 || images.length > 0) {
        const message = messageParts.length === 0 ? '' : messageParts.join('');
        const imageList = images.length === 0 ? undefined : images;

        events.push({
          type: 'UserMessage',
          data: {
            message,
            kind,
            images: imageList,
          },
        });
      }

      return events;
    }

    case 'reasoning': {
      const { summary, content } = item;
      const events: EventMsg[] = [];

      for (const summaryItem of summary) {
        if (summaryItem.type === 'summary_text') {
          events.push({
            type: 'AgentReasoning',
            data: { content: summaryItem.text },
          });
        }
      }

      if (content && showRawAgentReasoning) {
        for (const c of content) {
          const text = c.type === 'reasoning_text' || c.type === 'text' ? c.text : '';
          events.push({
            type: 'AgentReasoningRawContent',
            data: { content: text },
          });
        }
      }

      return events;
    }

    case 'web_search_call': {
      const { id, action } = item;

      if (action.type === 'search') {
        const callId = id || '';
        return [
          {
            type: 'WebSearchEnd',
            data: {
              call_id: callId,
              query: action.query,
            },
          },
        ];
      }

      return [];
    }

    // Variants that require side effects are handled by higher layers and do not emit events here.
    case 'function_call':
    case 'function_call_output':
    case 'local_shell_call':
    case 'custom_tool_call':
    case 'custom_tool_call_output':
    case 'other':
      return [];

    default:
      // Exhaustive check
      const _exhaustive: never = item;
      return [];
  }
}
