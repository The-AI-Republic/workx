/**
 * Check: skills loaded without name collisions.
 *
 * Uses the full unfiltered catalog (`getAllSkillMetas`) so the result is
 * independent of any attached domain filter. A duplicate name means two
 * skills shadow each other in the `/command` surface — a warn.
 *
 * @module core/diagnostics/checks/skills-loaded
 */

import type {
  DiagnosticCheck,
  DiagnosticContext,
  DiagnosticResult,
} from '../types';

const ID = 'skills-loaded';
const TITLE = 'Skills loaded';

export const skillsLoadedCheck: DiagnosticCheck = {
  id: ID,
  title: TITLE,
  platforms: ['extension', 'desktop', 'server'],
  async run(ctx: DiagnosticContext): Promise<DiagnosticResult> {
    if (!ctx.skillRegistry) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: 'Skill registry unavailable in this context.',
      };
    }

    const raw =
      ctx.skillRegistry.getAllSkillMetas?.() ??
      ctx.skillRegistry.getSkillMetas();
    const metas = Array.isArray(raw)
      ? (raw as Array<{ name?: unknown }>)
      : [];
    const names = metas
      .map((m) => (typeof m?.name === 'string' ? m.name : null))
      .filter((n): n is string => n !== null);

    const seen = new Set<string>();
    const collisions = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) collisions.add(n);
      seen.add(n);
    }

    if (collisions.size > 0) {
      return {
        id: ID,
        title: TITLE,
        status: 'warn',
        detail: `${collisions.size} skill name collision(s): ${[...collisions].join(', ')}.`,
        data: { total: names.length, collisions: [...collisions] },
      };
    }

    return {
      id: ID,
      title: TITLE,
      status: 'pass',
      detail: `${names.length} skill(s) loaded, no collisions.`,
      data: { total: names.length },
    };
  },
};
