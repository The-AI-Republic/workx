/**
 * search_memory tool — allows the LLM to search topical memories.
 * Registered as a function tool so the LLM can call it when it needs
 * historical context about the user's projects, personal details, etc.
 */

import type { ToolDefinition } from './BaseTool';

/**
 * Tool definition for search_memory, registered alongside other tools.
 */
export const SEARCH_MEMORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_memory',
    description:
      "Search the user's long-term memory for facts, past conversations, or context relevant to the current task. Use this when you need to recall project details, past decisions, or specific facts the user mentioned previously.",
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A short search query to find relevant memories (e.g., "React setup instructions", "Alex\'s dog\'s name"). Keep queries concise — under 200 characters.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};
