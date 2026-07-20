import { z } from 'zod';
import { DataSourceError } from './errors';
import type {
  CreateDataSourceFields,
  CreateDataSourceInput,
  DataDescribeRequest,
  DataQueryRequest,
  EditableDataSourcePolicy,
  LearnDataContextRequest,
  TestDataSourceCandidateInput,
  UpdateDataSourceInput,
} from './types';

export const DATA_SOURCE_LIMITS = {
  maxSources: 100,
  maxRows: 1_000,
  maxSqlChars: 50_000,
  maxPurposeChars: 500,
  maxParameters: 100,
  maxParameterChars: 16 * 1024,
  maxParameterTextChars: 64 * 1024,
  maxResultChars: 40_000,
  maxCellChars: 4_000,
  maxContextChars: 20_000,
} as const;

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (host) =>
      !host.includes('://') &&
      !host.includes('@') &&
      !/[/?#]/.test(host) &&
      !(host.startsWith('[') && !host.endsWith(']')),
    'Host must not contain a scheme, credentials, path, query, or fragment'
  );

const editablePolicySchema = z.object({
  agentAccessEnabled: z.boolean(),
  readOnly: z.literal(true),
  maxRows: z.number().int().min(1).max(1_000),
  timeoutMs: z.number().int().min(1_000).max(60_000),
  maxConcurrentQueries: z.literal(1),
  allowedNamespaces: z.array(z.string().trim().min(1).max(256)).max(100),
  allowedObjects: z.array(z.string().trim().min(1).max(512)).max(1_000),
  queryApproval: z.enum(['auto_read', 'ask_each_query']),
  learningMode: z.enum(['automatic', 'ask', 'off']),
});

const sourceFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000),
  category: z.literal('sql'),
  connectorId: z.enum(['postgres-native', 'mysql-native']),
  transport: z.object({ type: z.literal('native') }),
  connection: z.object({
    host: hostSchema,
    port: z.number().int().min(1).max(65_535),
    database: z.string().trim().min(1).max(128),
    username: z.string().trim().min(1).max(128),
    tls: z.object({
      mode: z.enum(['disable', 'require', 'verify-full']),
      caPem: z
        .string()
        .max(64 * 1024)
        .optional(),
    }),
  }),
  businessTimezone: z.string().trim().min(1).max(100),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  policy: editablePolicySchema,
});

const queryParameterSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('string'),
      value: z.string().max(DATA_SOURCE_LIMITS.maxParameterChars),
    })
    .strict(),
  z.object({ type: z.literal('number'), value: z.number().finite() }).strict(),
  z.object({ type: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('null') }).strict(),
  z
    .object({
      type: z.literal('date'),
      value: z
        .string()
        .max(DATA_SOURCE_LIMITS.maxParameterChars)
        .refine((value) => !Number.isNaN(Date.parse(value))),
    })
    .strict(),
]);

const queryRequestSchema = z
  .object({
    source_id: z.string().trim().min(1).max(100),
    query_language: z.literal('sql'),
    query: z.string().min(1).max(DATA_SOURCE_LIMITS.maxSqlChars),
    parameters: z.array(queryParameterSchema).max(DATA_SOURCE_LIMITS.maxParameters).optional(),
    purpose: z.string().trim().min(1).max(DATA_SOURCE_LIMITS.maxPurposeChars),
  })
  .strict();

const describeRequestSchema = z
  .object({
    source_id: z.string().trim().min(1).max(100),
    scope: z.enum(['catalog', 'objects']),
    search: z.string().trim().max(500).optional(),
    objects: z.array(z.string().trim().min(1).max(512)).max(20).optional(),
    cursor: z.string().max(4_096).optional(),
    include_context: z.boolean().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.scope === 'objects' && !request.objects?.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Object scope requires objects.' });
    }
    if (request.objects?.some((object) => !object.includes('.'))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Object names must be qualified.' });
    }
    if (request.scope === 'catalog' && request.objects?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Catalog scope does not accept objects.',
      });
    }
  });

const contextFactKindSchema = z.enum([
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
]);

const learnContextRequestSchema = z
  .object({
    source_id: z.string().trim().min(1).max(100),
    facts: z
      .array(
        z
          .object({
            kind: contextFactKindSchema,
            namespace: z.string().trim().min(1).max(256).optional(),
            object: z.string().trim().min(1).max(256).optional(),
            field: z.string().trim().min(1).max(256).optional(),
            assertion: z.string().trim().min(1).max(2_000),
            value: z.string().trim().max(1_000).optional(),
            meaning: z.string().trim().max(1_000).optional(),
            unit: z.string().trim().max(1_000).optional(),
            evidence_quote: z.string().min(8).max(500),
          })
          .strict()
      )
      .min(1)
      .max(10),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

function hasValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().normalize('NFKC')).filter(Boolean))];
}

export function normalizeDataSourceName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function defaultDataSourcePolicy(): EditableDataSourcePolicy {
  return {
    agentAccessEnabled: false,
    readOnly: true,
    maxRows: 200,
    timeoutMs: 15_000,
    maxConcurrentQueries: 1,
    allowedNamespaces: [],
    allowedObjects: [],
    queryApproval: 'auto_read',
    learningMode: 'automatic',
  };
}

export function validateSourceFields(value: unknown): CreateDataSourceFields {
  const parsed = sourceFieldsSchema.parse(value);
  if (!hasValidTimezone(parsed.businessTimezone)) {
    throw new DataSourceError(
      'SOURCE_UNREACHABLE',
      'Business timezone must be a valid IANA timezone.'
    );
  }
  if (parsed.isDefault && (!parsed.enabled || !parsed.policy.agentAccessEnabled)) {
    throw new DataSourceError(
      'AGENT_ACCESS_DISABLED',
      'A default source must be enabled for agent access.'
    );
  }
  if (parsed.connection.tls.mode === 'disable' && parsed.connection.tls.caPem) {
    throw new DataSourceError(
      'TLS_FAILED',
      'A CA certificate cannot be used when TLS is disabled.'
    );
  }
  return {
    ...parsed,
    name: parsed.name.normalize('NFKC'),
    description: parsed.description.normalize('NFKC'),
    connection: {
      ...parsed.connection,
      host: parsed.connection.host.replace(/^\[|\]$/g, ''),
      tls: {
        mode: parsed.connection.tls.mode,
        ...(parsed.connection.tls.caPem ? { caPem: parsed.connection.tls.caPem } : {}),
      },
    },
    businessTimezone: parsed.businessTimezone,
    policy: {
      ...parsed.policy,
      allowedNamespaces: uniqueNormalized(parsed.policy.allowedNamespaces),
      allowedObjects: uniqueNormalized(parsed.policy.allowedObjects),
    },
  };
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 1 || password.length > 4_096) {
    throw new DataSourceError('AUTH_FAILED', 'Password must contain 1 to 4096 characters.');
  }
  return password;
}

export function validateCreateInput(value: unknown): CreateDataSourceInput {
  const input = value as CreateDataSourceInput;
  return {
    source: validateSourceFields(input?.source),
    password: validatePassword(input?.password),
    leastPrivilegeAcknowledged: input?.leastPrivilegeAcknowledged === true,
  };
}

export function validateCandidateInput(value: unknown): TestDataSourceCandidateInput {
  const input = value as TestDataSourceCandidateInput;
  return {
    source: validateSourceFields(input?.source),
    password: validatePassword(input?.password),
  };
}

export function validateUpdateInput(value: unknown): UpdateDataSourceInput {
  const input = value as UpdateDataSourceInput;
  if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 1) {
    throw new DataSourceError('SOURCE_REVISION_CONFLICT', 'A valid expected revision is required.');
  }
  if (input.passwordAction !== 'keep' && input.passwordAction !== 'replace') {
    throw new DataSourceError('AUTH_FAILED', 'Password action must be keep or replace.');
  }
  if (input.passwordAction === 'replace') validatePassword(input.password);
  return input;
}

export function validateDataQueryRequest(request: unknown): DataQueryRequest {
  const parsed = queryRequestSchema.safeParse(request);
  if (!parsed.success) {
    const parameterIssue = parsed.error.issues.some((issue) => issue.path[0] === 'parameters');
    throw new DataSourceError(
      parameterIssue ? 'QUERY_PARAMETER_MISMATCH' : 'QUERY_PARSE_FAILED',
      parameterIssue
        ? 'Query parameters are invalid or exceed their limits.'
        : 'The SQL query request is invalid or exceeds its limits.'
    );
  }
  const parameters = parsed.data.parameters ?? [];
  let total = 0;
  for (const parameter of parameters) {
    if (parameter.type === 'string' || parameter.type === 'date') {
      total += parameter.value.length;
    }
  }
  if (total > DATA_SOURCE_LIMITS.maxParameterTextChars) {
    throw new DataSourceError('QUERY_PARAMETER_MISMATCH', 'Query parameter text is too large.');
  }
  return parsed.data;
}

export function validateDataDescribeRequest(request: unknown): DataDescribeRequest {
  const parsed = describeRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new DataSourceError('SCHEMA_NOT_FOUND', 'The schema-description request is invalid.');
  }
  return parsed.data;
}

export function validateLearnContextRequest(request: unknown): LearnDataContextRequest {
  const parsed = learnContextRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new DataSourceError('CONTEXT_CONFLICT', 'The context-learning request is invalid.');
  }
  return parsed.data;
}

export function connectionAffectingChange(
  before: CreateDataSourceFields,
  after: CreateDataSourceFields,
  passwordReplaced: boolean
): boolean {
  if (passwordReplaced) return true;
  return (
    JSON.stringify({
      connectorId: before.connectorId,
      transport: before.transport,
      connection: before.connection,
    }) !==
    JSON.stringify({
      connectorId: after.connectorId,
      transport: after.transport,
      connection: after.connection,
    })
  );
}

export function schemaAffectingChange(
  before: CreateDataSourceFields,
  after: CreateDataSourceFields
): boolean {
  return (
    JSON.stringify([before.policy.allowedNamespaces, before.policy.allowedObjects]) !==
    JSON.stringify([after.policy.allowedNamespaces, after.policy.allowedObjects])
  );
}
