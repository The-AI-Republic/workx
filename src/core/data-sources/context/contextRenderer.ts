import type { DataContextFact, DataSourceContext } from '../types';

function factScopeScore(fact: DataContextFact, requested: Set<string>): number {
  const qualified = [fact.subject.namespace, fact.subject.object, fact.subject.field]
    .filter(Boolean)
    .join('.')
    .toLocaleLowerCase('en-US');
  if ([...requested].some((object) => qualified.startsWith(object))) return 0;
  if (['metric_definition', 'exclusion_rule'].includes(fact.kind)) return 1;
  if (fact.kind === 'timezone_rule') return 2;
  return 4;
}

export function renderDataSourceContext(
  context: DataSourceContext,
  requestedObjects: string[] = [],
  maxChars = 20_000
): string {
  const requested = new Set(requestedObjects.map((value) => value.toLocaleLowerCase('en-US')));
  const active = context.facts
    .filter((fact) => fact.status === 'active' && !fact.stale)
    .sort(
      (a, b) =>
        factScopeScore(a, requested) - factScopeScore(b, requested) ||
        b.provenance.createdAt.localeCompare(a.provenance.createdAt)
    );
  const sections: string[] = [];
  if (context.overviewMarkdown.trim())
    sections.push(`## Source overview\n${context.overviewMarkdown.trim()}`);
  if (active.length) {
    sections.push(
      `## Business definitions\n${active
        .map((fact) => {
          const subject = [fact.subject.namespace, fact.subject.object, fact.subject.field]
            .filter(Boolean)
            .join('.');
          return `- ${subject ? `\`${subject}\`: ` : ''}${fact.assertion}`;
        })
        .join('\n')}`
    );
  }
  const rendered = sections.join('\n\n');
  return rendered.length <= maxChars
    ? rendered
    : `${rendered.slice(0, maxChars - 30)}\n\n[context truncated]`;
}
