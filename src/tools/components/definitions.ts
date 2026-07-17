import type { ToolDefinition } from '@/tools/BaseTool';

function componentTool(
  name: string,
  description: string,
  parameters: Extract<ToolDefinition, { type: 'function' }>['function']['parameters']
): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, strict: true, parameters },
    metadata: { platforms: ['desktop'], capabilities: ['managed-components'] },
    category: 'managed-components',
    version: '1.0.0',
  };
}

export const COMPONENT_LIST_TOOL = componentTool(
  'component_list',
  'List trusted optional components that WorkX can manage privately, including installation state, version, capabilities, and download size.',
  {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }
);

export const COMPONENT_INSTALL_TOOL = componentTool(
  'component_install',
  'Install or repair a trusted WorkX-managed component after explaining why it is required. This always waits for explicit user approval and never modifies the system PATH.',
  {
    type: 'object',
    properties: {
      component_id: {
        type: 'string',
        description: 'Component ID returned by component_list, such as duckdb.',
      },
      reason: {
        type: 'string',
        description:
          'Short user-facing explanation of why the current request requires this component.',
      },
    },
    required: ['component_id', 'reason'],
    additionalProperties: false,
  }
);
