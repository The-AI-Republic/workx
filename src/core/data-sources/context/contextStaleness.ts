import type {
  DataContextFact,
  DataObjectDescription,
  DataSourceContext,
  DataSourceDescription,
} from '../types';

function normalize(value: string | undefined): string {
  return value?.normalize('NFKC').toLocaleLowerCase('en-US') ?? '';
}

function matchesObject(
  fact: DataContextFact,
  object: DataSourceDescription['objects'][number]
): boolean {
  if (normalize(fact.subject.object) !== normalize(object.name)) return false;
  return (
    !fact.subject.namespace || normalize(fact.subject.namespace) === normalize(object.namespace)
  );
}

function requestedFact(fact: DataContextFact, requestedObjects: string[]): boolean {
  if (!requestedObjects.length) return true;
  const name = normalize(fact.subject.object);
  const qualified = normalize(
    [fact.subject.namespace, fact.subject.object].filter(Boolean).join('.')
  );
  return requestedObjects.some((candidate) => {
    const normalized = normalize(candidate);
    return normalized === name || normalized === qualified;
  });
}

/**
 * Annotate schema-scoped facts against a fresh description. The annotations are
 * intentionally ephemeral: a schema outage or rename never mutates user context.
 */
export function assessContextStaleness(
  context: DataSourceContext,
  description: DataSourceDescription,
  requestedObjects: string[] = []
): { context: DataSourceContext; warnings: string[] } {
  if (description.scope !== 'objects') return { context, warnings: [] };
  const warnings = new Set<string>();
  const facts = context.facts.map((fact): DataContextFact => {
    const clean = { ...fact, stale: undefined, staleReason: undefined };
    if (
      fact.status !== 'active' ||
      !fact.subject.object ||
      !requestedFact(fact, requestedObjects)
    ) {
      return clean;
    }
    const objects = description.objects.filter((object) => matchesObject(fact, object));
    const qualified = [fact.subject.namespace, fact.subject.object].filter(Boolean).join('.');
    if (!objects.length) {
      const staleReason = `Referenced schema object ${qualified} is no longer visible.`;
      warnings.add(staleReason);
      return { ...clean, stale: true, staleReason };
    }
    if (fact.subject.field) {
      const fieldExists = objects.some(
        (object) =>
          'fields' in object &&
          (object as DataObjectDescription).fields.some(
            (field) => normalize(field.name) === normalize(fact.subject.field)
          )
      );
      if (!fieldExists) {
        const staleReason = `Referenced schema field ${qualified}.${fact.subject.field} is no longer visible.`;
        warnings.add(staleReason);
        return { ...clean, stale: true, staleReason };
      }
    }
    return clean;
  });
  return {
    context: {
      ...context,
      facts,
      ...(warnings.size ? { warnings: [...warnings] } : {}),
    },
    warnings: [...warnings],
  };
}
