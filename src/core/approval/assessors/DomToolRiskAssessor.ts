/**
 * DOM Tool Risk Assessor
 *
 * Assesses risk for browser_dom (extension) tool calls based on
 * the action type and target element properties.
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

/** Patterns indicating submit/payment actions */
const SUBMIT_PATTERNS = /submit|pay|purchase|checkout|confirm|delete|remove|send|transfer|authorize/i;

/** Extract searchable text from element metadata fields only (not URLs or arbitrary data) */
function extractElementText(parameters: Record<string, any>): string {
  return [
    parameters.aria_label,
    parameters.text,
    parameters.name,
    parameters.role,
    parameters.placeholder,
    parameters.title,
    parameters.type,
  ].filter(v => typeof v === 'string').join(' ').toLowerCase();
}

export class DomToolRiskAssessor implements IRiskAssessor {
  assess(
    _toolName: string,
    parameters: Record<string, any>,
    _context?: ApprovalContext
  ): RiskAssessment {
    const action = parameters.action || parameters.method || '';
    const factors: string[] = [];
    let score = 0;

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

      case 'click': {
        score = 25;
        factors.push('Click action on page element');

        // Check for submit/payment indicators in element metadata only
        const clickText = extractElementText(parameters);
        if (clickText && SUBMIT_PATTERNS.test(clickText)) {
          score = 70;
          factors.push('Click target appears to be a submit/payment element');
        }
        break;
      }

      case 'type': {
        score = 40;
        factors.push('Typing into form field');

        // Check for sensitive field patterns in element metadata only
        const fieldText = extractElementText(parameters);
        if (fieldText && /password|credit.?card|ssn|social.?security|cvv|pin/i.test(fieldText)) {
          score = 65;
          factors.push('Typing into sensitive field (password/financial)');
        }
        break;
      }

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
    const action_decision = score <= 10 ? 'auto_approve' as const
      : score <= 30 ? 'auto_approve' as const
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
