/**
 * Setting Tool Risk Assessor
 *
 * Assesses risk for setting_tool calls based on the action type:
 * - get/list: score 0 (auto_approve) — read-only operations
 * - set: score 50 (ask_user) — write operations require confirmation
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

export class SettingToolRiskAssessor implements IRiskAssessor {
  assess(
    _toolName: string,
    parameters: Record<string, any>,
    _context?: ApprovalContext
  ): RiskAssessment {
    const action = parameters.action || '';
    const factors: string[] = [];
    let score = 0;

    switch (action) {
      case 'get':
        score = 0;
        factors.push('Read-only: get single setting value');
        break;

      case 'list':
        score = 0;
        factors.push('Read-only: list all settings');
        break;

      case 'set':
        score = 50;
        factors.push('Write operation: modifying user setting');
        if (parameters.key) {
          factors.push(`Target setting: ${parameters.key}`);
        }
        break;

      default:
        score = 50;
        factors.push(`Unknown setting action: ${action}`);
    }

    const level = scoreToRiskLevel(score);
    const action_decision = score === 0 ? 'auto_approve' as const : 'ask_user' as const;

    return {
      score,
      level,
      factors,
      action: action_decision,
    };
  }
}
