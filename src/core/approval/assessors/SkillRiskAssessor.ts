/**
 * SkillRiskAssessor — Track 03 Phase 4
 *
 * Replaces StaticRiskAssessor(0) on the use_skill tool. Decisions:
 *  - Unknown skill name              → 100 (Critical → typically denied)
 *  - disable-model-invocation: true  → 100 (model not allowed to invoke)
 *  - trusted: false                  → 50  (Medium → ask the user)
 *  - trusted user skill              → 0   (None → auto-approve)
 *
 * The assessor reads the skill name from the `name` parameter (use_skill's
 * input schema). For non-`use_skill` callers it falls back to safe defaults.
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

export interface SkillCatalog {
  /** Returns the full skill set; assessor checks both existence and metadata. */
  getAllSkillMetas(): Array<{
    name: string;
    trusted: boolean;
    disableModelInvocation?: boolean;
  }>;
}

export class SkillRiskAssessor implements IRiskAssessor {
  constructor(private readonly skills: SkillCatalog) {}

  assess(
    toolName: string,
    parameters: Record<string, unknown>,
    _context?: ApprovalContext,
  ): RiskAssessment {
    const requestedName = typeof parameters?.name === 'string' ? parameters.name : null;
    const factors: string[] = [`tool=${toolName}`];

    if (!requestedName) {
      factors.push('missing or non-string `name` parameter');
      return finalize(100, factors);
    }

    const meta = this.skills
      .getAllSkillMetas()
      .find((s) => s.name === requestedName);

    if (!meta) {
      factors.push(`unknown skill "${requestedName}"`);
      return finalize(100, factors);
    }

    if (meta.disableModelInvocation === true) {
      factors.push(`skill "${requestedName}" has disable-model-invocation: true`);
      return finalize(100, factors);
    }

    if (meta.trusted === false) {
      factors.push(`skill "${requestedName}" is untrusted`);
      return finalize(50, factors);
    }

    factors.push(`skill "${requestedName}" is trusted`);
    return finalize(0, factors);
  }
}

function finalize(score: number, factors: string[]): RiskAssessment {
  const level = scoreToRiskLevel(score);
  return {
    score,
    level,
    factors,
    action: score <= 30 ? 'auto_approve' : score >= 86 ? 'deny' : 'ask_user',
  };
}
