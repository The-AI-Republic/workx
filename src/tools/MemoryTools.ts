/**
 * Memory tool definitions and registration.
 * Registers save_memory, search_memory, forget_memory in the ToolRegistry
 * so they are managed centrally like all other tools.
 */
import type { ToolDefinition, ToolHandler } from './BaseTool';
import type { ToolRegistry } from './ToolRegistry';
import type { MemoryService } from '../core/memory/MemoryService';
import type { MemoryCategory } from '../core/memory/types';

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
import { SEARCH_MEMORY_TOOL } from './MemorySearchTool';

/**
 * Register memory tools in the ToolRegistry with handlers that delegate
 * to the MemoryService. Uses a getter so the handler always accesses the
 * current MemoryService instance (survives refreshMemoryService cycles).
 */
export async function registerMemoryTools(
  registry: ToolRegistry,
  getMemoryService: () => MemoryService | null
): Promise<void> {
  const saveHandler: ToolHandler = async (params) => {
    const ms = getMemoryService();
    if (!ms) return { success: false, message: 'Memory system not available' };
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    const category = (params.category || 'general') as MemoryCategory;
    if (!text) return { success: false, message: 'Empty text' };
    await ms.saveFact(text, category);
    return { success: true, message: `Saved to memory: "${text}"` };
  };

  const searchHandler: ToolHandler = async (params) => {
    const ms = getMemoryService();
    if (!ms) return { results: [], message: 'Memory system not available' };
    const query = typeof params.query === 'string' ? params.query.slice(0, 500).trim() : '';
    if (!query) return { results: [], message: 'Empty search query' };
    const memories = await ms.searchTopical(query);
    return memories.map(m => ({
      fact: m.fact,
      category: m.category,
      sourceDate: m.sourceDate,
      relevance: m.relevance,
    }));
  };

  const forgetHandler: ToolHandler = async (params) => {
    const ms = getMemoryService();
    if (!ms) return { success: false, message: 'Memory system not available' };
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) return { success: false, message: 'Empty query' };
    const removed = await ms.forgetFact(query);
    return { success: true, removed, message: `Removed ${removed} matching entries` };
  };

  await registry.register(SAVE_MEMORY_TOOL, saveHandler);
  await registry.register(SEARCH_MEMORY_TOOL, searchHandler);
  await registry.register(FORGET_MEMORY_TOOL, forgetHandler);

  console.log('[Memory] Memory tools registered: save_memory, search_memory, forget_memory');
}
