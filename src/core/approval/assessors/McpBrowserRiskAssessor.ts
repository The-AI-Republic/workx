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
  'take_screenshot': { score: 0, factor: 'Read-only page screenshot' },
  'get_dom': { score: 0, factor: 'Read-only DOM access' },
  'list_pages': { score: 0, factor: 'Read-only page listing' },
  'select_page': { score: 0, factor: 'Selecting browser inspection context' },
  'list_console_messages': { score: 0, factor: 'Read-only console inspection' },
  'get_console_message': { score: 0, factor: 'Read-only console inspection' },
  'list_network_requests': { score: 0, factor: 'Read-only network inspection' },
  'get_network_request': { score: 0, factor: 'Read-only network inspection' },
  'get_tab_id': { score: 0, factor: 'Read-only tab inspection' },
  'list_extensions': { score: 0, factor: 'Read-only extension inspection' },
  'performance_analyze_insight': { score: 0, factor: 'Read-only performance analysis' },
  'performance_stop_trace': { score: 0, factor: 'Stopping local performance trace' },
  'wait_for': { score: 0, factor: 'Waiting for page content' },
  'hover': { score: 0, factor: 'Passive hover action' },
  'scroll': { score: 0, factor: 'Passive scroll action' },
  'navigate_page': { score: 35, factor: 'Page navigation' },
  'new_page': { score: 35, factor: 'Opening new page' },
  'close_page': { score: 40, factor: 'Closing page' },
  'resize_page': { score: 10, factor: 'Resizing local browser page' },
  'emulate': { score: 10, factor: 'Changing local browser emulation' },
  'prefers-color-scheme': { score: 10, factor: 'Changing local color scheme emulation' },
  'performance_start_trace': { score: 35, factor: 'Starting performance trace that may reload the page' },
  'press_key': { score: 40, factor: 'Keypress event' },
  'keypress': { score: 40, factor: 'Keypress event' },
  'click_at': { score: 65, factor: 'Coordinate click with unknown target semantics' },
  'drag': { score: 50, factor: 'Dragging a page element' },
  'upload_file': { score: 75, factor: 'Uploading a local file to a page' },
  'handle_dialog': { score: 65, factor: 'Responding to a browser dialog' },
  'evaluate_script': { score: 70, factor: 'Executing JavaScript in the page' },
  'install_extension': { score: 75, factor: 'Installing a browser extension' },
  'reload_extension': { score: 65, factor: 'Reloading a browser extension' },
  'uninstall_extension': { score: 75, factor: 'Uninstalling a browser extension' },
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
      // Chrome DevTools MCP identifies click targets only by opaque uid, so
      // ordinary clicks must ask unless semantic metadata proves otherwise.
      score = 40;
      factors.push('Click action on page element');

      // Check for submit/payment indicators in element metadata only
      const clickText = extractElementText(parameters);
      if (clickText && SUBMIT_PATTERNS.test(clickText)) {
        score = 70;
        factors.push('Click target appears to be a submit/payment element');
      }
    } else if (action === 'type' || action === 'fill' || action === 'fill_form') {
      score = 50;
      factors.push('Typing into form field');

      // Check for sensitive fields in element metadata only
      const fieldText = extractElementText(parameters);
      if (fieldText && /password|credit.?card|ssn|cvv|pin/i.test(fieldText)) {
        score = 65;
        factors.push('Typing into sensitive field');
      }
    } else {
      // Fail closed for newly-added MCP actions until they are classified.
      score = 65;
      factors.push(`Unknown MCP browser action: ${action}`);
    }

    const level = scoreToRiskLevel(score);
    const decision = score <= 30 ? 'auto_approve' as const
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
