/**
 * DOM Tool Risk Assessor
 *
 * Assesses risk for browser_dom (extension) tool calls based on
 * the action type and target element properties.
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

export class DomToolRiskAssessor implements IRiskAssessor {
  assess(
    _toolName: string,
    parameters: Record<string, any>,
    _context?: ApprovalContext
  ): RiskAssessment {
    const action = parameters.action || parameters.method || '';
    const factors: string[] = [];
    let score = 0;

    // Base risk by action type only — semantic element analysis
    // (submit/payment/sensitive field detection) is handled by SemanticElementEnhancer
    // to avoid double-counting.
    switch (action) {
      case 'snapshot':
      case 'getSerializedDom':
        score = 0;
        factors.push('Read-only DOM snapshot');
        break;

      case 'scroll':
        score = 0;
        factors.push('Scroll action is passive');
        break;

      case 'click':
        score = 25;
        factors.push('Click action on page element');
        break;

      case 'type':
        score = 40;
        factors.push('Typing into form field');
        break;

      case 'keypress':
        score = 30;
        factors.push('Keypress event');
        break;

      case 'navigate':
      case 'goto':
        score = 35;
        factors.push('Navigation action');
        break;

      default:
        score = 25;
        factors.push(`Unknown DOM action: ${action}`);
    }

    const level = scoreToRiskLevel(score);
    const action_decision = score <= 30 ? 'auto_approve' as const
      : score <= 85 ? 'ask_user' as const
      : 'deny' as const;

    return {
      score,
      level,
      factors,
      action: action_decision,
    };
  }
}
