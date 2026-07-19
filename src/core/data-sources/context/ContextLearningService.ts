import { randomUUID } from 'node:crypto';
import { DataSourceError } from '../errors';
import type {
  DataContextFact,
  DataLearningTurn,
  DataSource,
  DataSourceDescription,
  LearnContextResult,
  LearnDataContextFactInput,
  LearnDataContextRequest,
} from '../types';
import type { DataContextStore } from '../DataContextStore';

const CREDENTIAL_LIKE =
  /(password|passwd|secret|api[_ -]?key|bearer\s+[a-z0-9._-]+|-----BEGIN [^-]+PRIVATE KEY-----)/i;
const TEMPORARY_RULE =
  /\b(for (?:this|the current) (?:report|analysis|question|request|session|run|time)|just (?:this|once)|temporar(?:y|ily)|today only)\b/i;

export function normalizeEvidence(value: string): string {
  return value.normalize('NFKC').replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

function normalizedSubject(input: LearnDataContextFactInput): string {
  return [input.namespace, input.object, input.field]
    .filter(Boolean)
    .map((value) => value!.normalize('NFKC').toLocaleLowerCase('en-US'))
    .join('.');
}

function normalizedIdentityValue(value: string | undefined): string {
  return value?.normalize('NFKC').toLocaleLowerCase('en-US') ?? '';
}

function factIdentity(fact: Pick<DataContextFact, 'kind' | 'subject' | 'structuredValue'>): string {
  const subject = [fact.subject.namespace, fact.subject.object, fact.subject.field]
    .filter(Boolean)
    .map((value) => value!.normalize('NFKC').toLocaleLowerCase('en-US'))
    .join('.');
  const enumValue =
    fact.kind === 'enum_value' ? normalizedIdentityValue(fact.structuredValue?.value) : '';
  return `${fact.kind}:${subject}:${enumValue}`;
}

function inputIdentity(input: LearnDataContextFactInput): string {
  const enumValue = input.kind === 'enum_value' ? normalizedIdentityValue(input.value) : '';
  return `${input.kind}:${normalizedSubject(input)}:${enumValue}`;
}

function assertionIdentity(input: LearnDataContextFactInput): string {
  return normalizeEvidence(
    JSON.stringify([input.assertion, input.value, input.meaning, input.unit])
  );
}

function storedAssertionIdentity(fact: DataContextFact): string {
  return normalizeEvidence(
    JSON.stringify([
      fact.assertion,
      fact.structuredValue?.value,
      fact.structuredValue?.meaning,
      fact.structuredValue?.unit,
    ])
  );
}

export class ContextLearningService {
  constructor(private readonly store: DataContextStore) {}

  async learn(
    source: DataSource,
    request: LearnDataContextRequest,
    turn: DataLearningTurn,
    schema?: DataSourceDescription
  ): Promise<LearnContextResult> {
    if (source.policy.learningMode === 'off') {
      throw new DataSourceError(
        'AGENT_ACCESS_DISABLED',
        'Context learning is disabled for this source.'
      );
    }
    if (
      !turn.durableLearningEligible ||
      turn.principal.origin.channel !== 'local' ||
      !turn.principal.attended
    ) {
      throw new DataSourceError(
        'DATA_ACCESS_ORIGIN_DENIED',
        'This turn cannot persist data-source context.'
      );
    }
    if (!request.facts.length || request.facts.length > 10) {
      throw new DataSourceError(
        'CONTEXT_CONFLICT',
        'A context-learning call must contain 1 to 10 facts.'
      );
    }
    const currentUserText = normalizeEvidence(turn.currentUserText);
    const current = await this.store.get(source.id);
    const activeByIdentity = new Map(
      current.facts
        .filter((fact) => fact.status === 'active')
        .map((fact) => [factIdentity(fact), fact])
    );
    const deduplicatedFactIds: string[] = [];
    const addedFacts: DataContextFact[] = [];
    for (const input of request.facts) {
      this.validateInput(input, currentUserText, schema);
      const existing = activeByIdentity.get(inputIdentity(input));
      if (existing) {
        if (storedAssertionIdentity(existing) === assertionIdentity(input)) {
          deduplicatedFactIds.push(existing.id);
          continue;
        }
        throw new DataSourceError(
          'CONTEXT_CONFLICT',
          `Stored context conflicts with: ${input.assertion.slice(0, 120)}`
        );
      }
      const now = new Date().toISOString();
      const fact: DataContextFact = {
        id: randomUUID(),
        kind: input.kind,
        subject: {
          ...(input.namespace ? { namespace: input.namespace.normalize('NFKC') } : {}),
          ...(input.object ? { object: input.object.normalize('NFKC') } : {}),
          ...(input.field ? { field: input.field.normalize('NFKC') } : {}),
        },
        assertion: input.assertion.trim().normalize('NFKC'),
        ...(input.value || input.meaning || input.unit
          ? {
              structuredValue: {
                ...(input.value ? { value: input.value } : {}),
                ...(input.meaning ? { meaning: input.meaning } : {}),
                ...(input.unit ? { unit: input.unit } : {}),
              },
            }
          : {}),
        status: 'active',
        provenance: {
          source: 'user_chat',
          sessionId: turn.principal.sessionId,
          turnId: turn.principal.turnId,
          evidenceQuote: input.evidence_quote,
          createdAt: now,
        },
        confidence: 'user_asserted',
        ...(schema?.schemaFingerprint ? { schemaFingerprint: schema.schemaFingerprint } : {}),
      };
      addedFacts.push(fact);
      activeByIdentity.set(inputIdentity(input), fact);
    }
    const updated = addedFacts.length
      ? await this.store.appendLearnedFacts(source.id, current.revision, addedFacts)
      : current;
    return {
      sourceId: source.id,
      sourceName: source.name,
      priorRevision: current.revision,
      currentRevision: updated.revision,
      addedFacts,
      deduplicatedFactIds,
    };
  }

  private validateInput(
    input: LearnDataContextFactInput,
    currentUserText: string,
    schema?: DataSourceDescription
  ): void {
    const quote = normalizeEvidence(input.evidence_quote);
    if (quote.length < 8 || quote.length > 500 || !currentUserText.includes(quote)) {
      throw new DataSourceError(
        'CONTEXT_EVIDENCE_MISSING',
        'Context evidence must be an exact quote from this user turn.'
      );
    }
    if (
      !input.assertion.trim() ||
      input.assertion.length > 2_000 ||
      CREDENTIAL_LIKE.test(input.assertion) ||
      TEMPORARY_RULE.test(input.assertion) ||
      TEMPORARY_RULE.test(quote)
    ) {
      throw new DataSourceError(
        'CONTEXT_CONFLICT',
        'Context assertion is invalid or contains credential-like data.'
      );
    }
    for (const value of [input.value, input.meaning, input.unit]) {
      if (value && (value.length > 1_000 || CREDENTIAL_LIKE.test(value))) {
        throw new DataSourceError(
          'CONTEXT_CONFLICT',
          'Structured context is invalid or contains credential-like data.'
        );
      }
    }
    if (!input.object && !input.field) return;
    if (!schema || schema.scope !== 'objects') {
      throw new DataSourceError(
        'CONTEXT_SCHEMA_AMBIGUOUS',
        'Schema details are required before learning object or field context.'
      );
    }
    const object = schema.objects.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase('en-US') === input.object?.toLocaleLowerCase('en-US') &&
        (!input.namespace ||
          candidate.namespace.toLocaleLowerCase('en-US') ===
            input.namespace.toLocaleLowerCase('en-US'))
    );
    if (!object)
      throw new DataSourceError(
        'CONTEXT_SCHEMA_AMBIGUOUS',
        'The context object is not visible in this source.'
      );
    if (
      input.field &&
      (!('fields' in object) ||
        !object.fields.some(
          (field) =>
            field.name.toLocaleLowerCase('en-US') === input.field!.toLocaleLowerCase('en-US')
        ))
    ) {
      throw new DataSourceError(
        'CONTEXT_SCHEMA_AMBIGUOUS',
        'The context field is not visible in this source.'
      );
    }
  }
}
