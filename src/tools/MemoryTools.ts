/**
 * Memory tool definitions -- save_memory, search_memory, forget_memory.
 * Registered as function tools for the main agent LLM.
 */
import type { ToolDefinition } from './BaseTool';

export const SAVE_MEMORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      'Save an important fact, preference, or detail about the user to long-term memory. ' +
      'Call this when the user shares personal details, preferences, project context, ' +
      'or explicitly asks you to remember something. Write a concise, complete fact as plain text.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The fact to remember (plain text, one concise sentence)',
        },
        category: {
          type: 'string',
          enum: ['preference', 'personal', 'professional', 'project', 'behavior', 'instruction', 'general'],
          description: 'Category of the fact. Use "preference" for likes/choices, "instruction" for explicit commands, "behavior" for communication style, "personal" for personal details, "professional" for work details, "project" for project context, "general" for other.',
        },
      },
      required: ['text', 'category'],
      additionalProperties: false,
    },
  },
};

export const FORGET_MEMORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'forget_memory',
    description:
      "Remove a specific fact from the user's long-term memory. Use this when the user " +
      'explicitly asks you to forget something or when stored information is no longer accurate.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Description of what to forget (e.g., "my old email address", "preference for dark mode")',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export { SEARCH_MEMORY_TOOL } from './MemorySearchTool';
