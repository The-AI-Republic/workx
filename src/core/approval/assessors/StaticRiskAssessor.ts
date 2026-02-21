/**
 * Static Risk Assessor
 *
 * Default fallback assessor for tools without a custom assessor.
 * Returns a configurable static risk score.
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

export class StaticRiskAssessor implements IRiskAssessor {
  private defaultScore: number;

  /**
   * @param defaultScore - Static risk score to return (default: 20 = low)
   */
  constructor(defaultScore: number = 20) {
    this.defaultScore = defaultScore;
  }

  assess(
    toolName: string,
    _parameters: Record<string, any>,
    _context?: ApprovalContext
  ): RiskAssessment {
    const score = this.defaultScore;
    const level = scoreToRiskLevel(score);

    return {
      score,
      level,
      factors: [`Static assessment for ${toolName}`],
      action: score <= 30 ? 'auto_approve' : 'ask_user',
    };
  }
}
