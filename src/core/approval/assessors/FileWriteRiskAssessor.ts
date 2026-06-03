/**
 * FileWriteRiskAssessor — risk for the mutating code-mode file tools
 * (edit_file, write_file). Design §4.8 layer 2.
 *
 * Returns a score above the shared `riskAbove:30 ⇒ ASK` threshold so an
 * ordinary in-workspace write prompts the desktop approval UI. This is
 * ADDITIVE to the self-contained Rust path jail (layer 1) — never a
 * substitute. read_file/grep/glob keep StaticRiskAssessor(0).
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

export class FileWriteRiskAssessor implements IRiskAssessor {
  assess(
    toolName: string,
    _parameters: Record<string, any>,
    _context?: ApprovalContext,
  ): RiskAssessment {
    const score = 45; // > 30 ⇒ ask_user under the balanced threshold
    return {
      score,
      level: scoreToRiskLevel(score),
      factors: [`${toolName} modifies a file on disk`],
      action: 'ask_user',
    };
  }
}
