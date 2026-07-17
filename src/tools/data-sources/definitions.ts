import type { ToolDefinition } from '@/tools/BaseTool';

function functionTool(
  name: string,
  description: string,
  parameters: Extract<ToolDefinition, { type: 'function' }>['function']['parameters']
): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, strict: true, parameters },
    metadata: { platforms: ['desktop'], capabilities: ['data-analysis'] },
    category: 'data-analysis',
    version: '1.0.0',
  };
}

export const DATA_LIST_SOURCES_TOOL = functionTool(
  'data_list_sources',
  'List configured data sources that this attended desktop session may analyze. Use source IDs returned here; never ask for connection credentials.',
  {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional source name or business-description search.',
      },
      cursor: {
        type: 'string',
        description: 'Opaque cursor from a previous page.',
      },
    },
    additionalProperties: false,
  }
);

export const DATA_DESCRIBE_TOOL = functionTool(
  'data_describe',
  'Discover allowed tables/views or describe selected objects, including relevant saved business context. Describe before the first query against a source in a turn.',
  {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Configured source UUID.' },
      scope: { type: 'string', enum: ['catalog', 'objects'] },
      search: { type: 'string' },
      objects: {
        type: 'array',
        items: { type: 'string' },
        description: 'Qualified object names for objects scope.',
      },
      cursor: { type: 'string' },
      include_context: { type: 'boolean' },
    },
    required: ['source_id', 'scope'],
    additionalProperties: false,
  }
);

export const DATA_QUERY_TOOL = functionTool(
  'data_query',
  'Execute exactly one bounded read-only SQL query against a configured source. Prefer aggregates and parameters; never request raw credentials or write SQL.',
  {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Configured source UUID.' },
      query_language: { type: 'string', enum: ['sql'] },
      query: {
        type: 'string',
        description: 'One read-only SQL SELECT using PostgreSQL $1 or MySQL ? placeholders.',
      },
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['string', 'number', 'boolean', 'null', 'date'],
            },
            value: {
              anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
              description: 'Typed value; omit for null.',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
      purpose: {
        type: 'string',
        description: 'Short explanation of why this query answers the user.',
      },
    },
    required: ['source_id', 'query_language', 'query', 'purpose'],
    additionalProperties: false,
  }
);

export const DATA_GET_CONTEXT_TOOL = functionTool(
  'data_get_context',
  'Retrieve broader saved business definitions for one configured data source when object-scoped context from data_describe is insufficient.',
  {
    type: 'object',
    properties: { source_id: { type: 'string' } },
    required: ['source_id'],
    additionalProperties: false,
  }
);

export const DATA_LEARN_CONTEXT_TOOL = functionTool(
  'data_learn_context',
  'Save clear durable business facts explicitly stated by the current user after using them for the current request. Evidence must be an exact quote. Never save temporary instructions, guesses, credentials, or raw rows.',
  {
    type: 'object',
    properties: {
      source_id: { type: 'string' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'object_meaning',
                'field_meaning',
                'enum_value',
                'unit',
                'metric_definition',
                'join_hint',
                'exclusion_rule',
                'timezone_rule',
                'caveat',
                'other',
              ],
            },
            namespace: { type: 'string' },
            object: { type: 'string' },
            field: { type: 'string' },
            assertion: { type: 'string' },
            value: { type: 'string' },
            meaning: { type: 'string' },
            unit: { type: 'string' },
            evidence_quote: { type: 'string' },
          },
          required: ['kind', 'assertion', 'evidence_quote'],
          additionalProperties: false,
        },
      },
      reason: { type: 'string' },
    },
    required: ['source_id', 'facts', 'reason'],
    additionalProperties: false,
  }
);

export const DATA_SOURCE_TOOL_DEFINITIONS = [
  DATA_LIST_SOURCES_TOOL,
  DATA_DESCRIBE_TOOL,
  DATA_QUERY_TOOL,
  DATA_GET_CONTEXT_TOOL,
  DATA_LEARN_CONTEXT_TOOL,
] as const;
