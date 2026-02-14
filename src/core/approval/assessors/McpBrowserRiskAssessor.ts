/**
 * MCP Browser Risk Assessor
 *
 * Assesses risk for MCP browser tools on desktop (browser__click, browser__type, etc.).
 * Maps MCP tool names to DOM action tiers using same logic as DomToolRiskAssessor.
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

/** Map MCP browser tool suffixes to risk scores */
const TOOL_RISK_MAP: Record<string, { score: number; factor: string }> = {
  'take_snapshot': { score: 0, factor: 'Read-only page snapshot' },
  'snapshot': { score: 0, factor: 'Read-only page snapshot' },
  'get_dom': { score: 0, factor: 'Read-only DOM access' },
  'scroll': { score: 0, factor: 'Passive scroll action' },
  'navigate_page': { score: 35, factor: 'Page navigation' },
  'new_page': { score: 20, factor: 'Opening new page' },
  'close_page': { score: 30, factor: 'Closing page' },
  'keypress': { score: 30, factor: 'Keypress event' },
};

export class McpBrowserRiskAssessor implements IRiskAssessor {
  assess(
    toolName: string,
    parameters: Record<string, any>,
    _context?: ApprovalContext
  ): RiskAssessment {
    // Extract action from prefixed tool name (browser__click -> click)
    const parts = toolName.split('__');
    const lastPart = parts[parts.length - 1];
    const action = lastPart || toolName;

    const factors: string[] = [];
    let score: number;

    // Check static risk map first
    const mapped = TOOL_RISK_MAP[action];
    if (mapped) {
      score = mapped.score;
      factors.push(mapped.factor);
    } else if (action === 'click') {
      score = 25;
      factors.push('Click action on page element');

      // Check for submit/payment indicators in element metadata only
      const clickText = extractElementText(parameters);
      if (clickText && SUBMIT_PATTERNS.test(clickText)) {
        score = 70;
        factors.push('Click target appears to be a submit/payment element');
      }
    } else if (action === 'type' || action === 'fill') {
      score = 40;
      factors.push('Typing into form field');

      // Check for sensitive fields in element metadata only
      const fieldText = extractElementText(parameters);
      if (fieldText && /password|credit.?card|ssn|cvv|pin/i.test(fieldText)) {
        score = 65;
        factors.push('Typing into sensitive field');
      }
    } else {
      // Unknown MCP browser action
      score = 30;
      factors.push(`Unknown MCP browser action: ${action}`);
    }

    const level = scoreToRiskLevel(score);
    const decision = score <= 10 ? 'auto_approve' as const
      : score <= 30 ? 'auto_approve' as const
      : score <= 85 ? 'ask_user' as const
      : 'deny' as const;

    return {
      score,
      level,
      factors,
      action: decision,
    };
  }
}
