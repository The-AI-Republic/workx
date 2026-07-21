import { randomUUID } from 'node:crypto';
import type { StorageProvider } from '@/core/storage/StorageProvider';
import { DataSourceError } from './errors';
import { DataSourceMutationMutex } from './DataSourceMutationMutex';
import { contextRevisionKey } from './DataSourceStore';
import type {
  DataContextFact,
  DataContextRevisionSummary,
  DataSourceContext,
  DataSourceContextEnvelope,
  ManualContextFactInput,
  ManualContextUpdate,
} from './types';

const CONTEXTS = 'data_source_contexts';
const REVISIONS = 'data_source_context_revisions';
const RETENTION = 50;
const CREDENTIAL_LIKE =
  /(password\s*[:=]|passwd\s*[:=]|secret\s*[:=]|api[_ -]?key\s*[:=]|bearer\s+[a-z0-9._-]+|-----BEGIN [^-]+PRIVATE KEY-----)/i;
const FACT_KINDS = new Set([
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
const SUBJECT_KEYS = new Set(['namespace', 'object', 'field']);
const STRUCTURED_VALUE_KEYS = new Set(['value', 'meaning', 'unit']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidContext(message: string): never {
  throw new DataSourceError('CONTEXT_CONFLICT', message);
}

function validateManualFact(input: ManualContextFactInput): ManualContextFactInput {
  if (!isRecord(input) || !FACT_KINDS.has(input.kind)) {
    invalidContext('Context fact kind is invalid.');
  }
  if (!isRecord(input.subject)) invalidContext('Context fact subject is invalid.');
  if (Object.keys(input.subject).some((key) => !SUBJECT_KEYS.has(key))) {
    invalidContext('Context fact subject contains unsupported fields.');
  }
  if (typeof input.assertion !== 'string') invalidContext('Context assertion is invalid.');
  const assertion = input.assertion.trim().normalize('NFKC');
  if (!assertion || assertion.length > 2_000 || CREDENTIAL_LIKE.test(assertion)) {
    throw new DataSourceError(
      'CONTEXT_CONFLICT',
      'Context assertion is invalid or contains credential-like data.'
    );
  }
  const subject: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input.subject)) {
    if (rawValue === undefined) continue;
    if (typeof rawValue !== 'string') invalidContext('Context fact subject is invalid.');
    const value = rawValue.trim().normalize('NFKC');
    if (!value) continue;
    if (value.length > 512 || CREDENTIAL_LIKE.test(value)) {
      invalidContext('Context fact subject is invalid or contains credential-like data.');
    }
    subject[key] = value;
  }
  let structuredValue: ManualContextFactInput['structuredValue'];
  if (input.structuredValue !== undefined) {
    if (!isRecord(input.structuredValue)) invalidContext('Structured context is invalid.');
    if (Object.keys(input.structuredValue).some((key) => !STRUCTURED_VALUE_KEYS.has(key))) {
      invalidContext('Structured context contains unsupported fields.');
    }
    structuredValue = {};
    for (const [key, rawValue] of Object.entries(input.structuredValue)) {
      if (rawValue === undefined) continue;
      if (typeof rawValue !== 'string') invalidContext('Structured context is invalid.');
      const value = rawValue.trim().normalize('NFKC');
      if (value.length > 1_000 || CREDENTIAL_LIKE.test(value)) {
        invalidContext('Structured context is invalid or contains credential-like data.');
      }
      if (value) structuredValue[key as keyof NonNullable<typeof structuredValue>] = value;
    }
    if (!Object.keys(structuredValue).length) structuredValue = undefined;
  }
  return {
    kind: input.kind,
    subject,
    assertion,
    ...(structuredValue ? { structuredValue } : {}),
  } as ManualContextFactInput;
}

function validateManualUpdate(input: ManualContextUpdate): ManualContextUpdate {
  if (!isRecord(input)) invalidContext('Context update is invalid.');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalidContext('A valid expected context revision is required.');
  }
  if (input.overviewMarkdown !== undefined) {
    if (
      typeof input.overviewMarkdown !== 'string' ||
      input.overviewMarkdown.length > 20_000 ||
      CREDENTIAL_LIKE.test(input.overviewMarkdown)
    ) {
      throw new DataSourceError(
        'CONTEXT_CONFLICT',
        'Context overview is invalid or contains credential-like data.'
      );
    }
  }
  if (input.factOperations !== undefined && !Array.isArray(input.factOperations)) {
    invalidContext('Context fact operations are invalid.');
  }
  if ((input.factOperations?.length ?? 0) > 100) {
    invalidContext('At most 100 context operations are allowed.');
  }
  const factOperations = input.factOperations?.map((operation) => {
    if (!isRecord(operation) || typeof operation.operation !== 'string') {
      invalidContext('Context fact operation is invalid.');
    }
    if (operation.operation === 'add') {
      return { operation: 'add' as const, fact: validateManualFact(operation.fact) };
    }
    if (operation.operation === 'replace') {
      if (typeof operation.factId !== 'string' || !operation.factId.trim()) {
        invalidContext('Context fact identifier is invalid.');
      }
      return {
        operation: 'replace' as const,
        factId: operation.factId,
        fact: validateManualFact(operation.fact),
      };
    }
    if (operation.operation === 'supersede') {
      if (typeof operation.factId !== 'string' || !operation.factId.trim()) {
        invalidContext('Context fact identifier is invalid.');
      }
      return { operation: 'supersede' as const, factId: operation.factId };
    }
    return invalidContext('Context fact operation is invalid.');
  });
  return {
    expectedRevision: input.expectedRevision,
    ...(input.overviewMarkdown !== undefined
      ? { overviewMarkdown: input.overviewMarkdown.normalize('NFKC') }
      : {}),
    ...(factOperations ? { factOperations } : {}),
  };
}

export function createEmptyDataSourceContext(
  sourceId: string,
  now = new Date().toISOString()
): DataSourceContext {
  return {
    version: 1,
    sourceId,
    revision: 1,
    overviewMarkdown: '',
    facts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function settingsFact(input: ManualContextFactInput, now: string): DataContextFact {
  input = validateManualFact(input);
  return {
    id: randomUUID(),
    kind: input.kind,
    subject: input.subject,
    assertion: input.assertion.trim(),
    ...(input.structuredValue ? { structuredValue: input.structuredValue } : {}),
    status: 'active',
    provenance: { source: 'settings', createdAt: now },
    confidence: 'user_asserted',
  };
}

export class DataContextStore {
  constructor(
    private readonly storage: StorageProvider,
    private readonly mutex: DataSourceMutationMutex
  ) {}

  async get(sourceId: string): Promise<DataSourceContext> {
    const envelope = await this.storage.get<DataSourceContextEnvelope>(CONTEXTS, sourceId);
    if (!envelope) throw new DataSourceError('SOURCE_NOT_FOUND', 'Data-source context not found.');
    return envelope.current;
  }

  async updateManual(sourceId: string, input: ManualContextUpdate): Promise<DataSourceContext> {
    input = validateManualUpdate(input);
    return this.writeRevision(sourceId, input.expectedRevision, (current, now) => {
      const facts = current.facts.map((fact) => ({ ...fact }));
      for (const operation of input.factOperations ?? []) {
        if (operation.operation === 'add') {
          facts.push(settingsFact(operation.fact, now));
          continue;
        }
        const index = facts.findIndex(
          (fact) => fact.id === operation.factId && fact.status === 'active'
        );
        if (index < 0)
          throw new DataSourceError('CONTEXT_CONFLICT', 'Context fact no longer exists.');
        facts[index] = { ...facts[index], status: 'superseded' };
        if (operation.operation === 'replace') facts.push(settingsFact(operation.fact, now));
      }
      return {
        overviewMarkdown: input.overviewMarkdown ?? current.overviewMarkdown,
        facts,
      };
    });
  }

  async appendLearnedFacts(
    sourceId: string,
    expectedRevision: number,
    facts: DataContextFact[]
  ): Promise<DataSourceContext> {
    return this.writeRevision(sourceId, expectedRevision, (current) => ({
      overviewMarkdown: current.overviewMarkdown,
      facts: [...current.facts, ...facts],
    }));
  }

  async listRevisions(sourceId: string): Promise<DataContextRevisionSummary[]> {
    const envelope = await this.storage.get<DataSourceContextEnvelope>(CONTEXTS, sourceId);
    if (!envelope) throw new DataSourceError('SOURCE_NOT_FOUND', 'Data-source context not found.');
    const keys = envelope.retainedRevisions.map((revision) =>
      contextRevisionKey(sourceId, revision)
    );
    const records = await this.storage.getMany<DataSourceContext>(REVISIONS, keys);
    return envelope.retainedRevisions
      .slice()
      .reverse()
      .map((revision) => records.get(contextRevisionKey(sourceId, revision)))
      .filter((context): context is DataSourceContext => Boolean(context))
      .map((context) => {
        const lastFact = context.facts[context.facts.length - 1];
        return {
          revision: context.revision,
          createdAt: context.updatedAt,
          createdBy: lastFact?.provenance.source ?? 'settings',
          activeFactCount: context.facts.filter((fact) => fact.status === 'active').length,
        };
      });
  }

  async revert(
    sourceId: string,
    targetRevision: number,
    expectedCurrentRevision: number
  ): Promise<DataSourceContext> {
    const target = await this.storage.get<DataSourceContext>(
      REVISIONS,
      contextRevisionKey(sourceId, targetRevision)
    );
    if (!target)
      throw new DataSourceError('CONTEXT_REVISION_CONFLICT', 'Context revision is unavailable.');
    return this.writeRevision(sourceId, expectedCurrentRevision, () => ({
      overviewMarkdown: target.overviewMarkdown,
      facts: target.facts,
    }));
  }

  private async writeRevision(
    sourceId: string,
    expectedRevision: number,
    mutate: (
      current: DataSourceContext,
      now: string
    ) => Pick<DataSourceContext, 'overviewMarkdown' | 'facts'>
  ): Promise<DataSourceContext> {
    return this.mutex.runExclusive(async () => {
      const envelope = await this.storage.get<DataSourceContextEnvelope>(CONTEXTS, sourceId);
      if (!envelope)
        throw new DataSourceError('SOURCE_NOT_FOUND', 'Data-source context not found.');
      if (envelope.current.revision !== expectedRevision) {
        throw new DataSourceError(
          'CONTEXT_REVISION_CONFLICT',
          'Context changed; reload before saving.'
        );
      }
      const now = new Date().toISOString();
      const change = mutate(envelope.current, now);
      if (change.overviewMarkdown.length > 20_000 || change.facts.length > 1_000) {
        throw new DataSourceError('CONTEXT_CONFLICT', 'Context exceeds the configured size limit.');
      }
      const current: DataSourceContext = {
        ...envelope.current,
        ...change,
        revision: envelope.current.revision + 1,
        updatedAt: now,
      };
      const retained = [...envelope.retainedRevisions, current.revision];
      const evicted = retained.length > RETENTION ? retained.shift() : undefined;
      const nextEnvelope: DataSourceContextEnvelope = {
        version: 1,
        current,
        retainedRevisions: retained,
      };
      await this.storage.transaction(async (tx) => {
        await tx.set(CONTEXTS, sourceId, nextEnvelope);
        await tx.set(REVISIONS, contextRevisionKey(sourceId, current.revision), current);
        if (evicted !== undefined)
          await tx.delete(REVISIONS, contextRevisionKey(sourceId, evicted));
      });
      return current;
    });
  }
}
