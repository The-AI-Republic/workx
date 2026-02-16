/**
 * Policy Rules Engine
 *
 * Evaluates policy rules against tool calls using deny > ask > allow ordering.
 * First match wins within each tier.
 */

import type { PolicyRule, ApprovalDecision } from './types';

export class PolicyRulesEngine {
  private denyRules: PolicyRule[];
  private askRules: PolicyRule[];
  private allowRules: PolicyRule[];

  constructor(rules: PolicyRule[]) {
    // Validate regex patterns at construction time
    for (const rule of rules) {
      if (rule.match.pattern !== undefined) {
        try {
          new RegExp(rule.match.pattern, 'i');
        } catch (e) {
          throw new Error(`Invalid regex pattern in ${rule.type} rule: ${rule.match.pattern}`);
        }
      }
    }

    // Partition rules by type for ordered evaluation
    this.denyRules = rules.filter(r => r.type === 'deny');
    this.askRules = rules.filter(r => r.type === 'ask');
    this.allowRules = rules.filter(r => r.type === 'allow');
  }

  /**
   * Evaluate rules against a tool call.
   * Order: deny rules first, then ask, then allow.
   * Returns undefined if no rule matches (caller decides default).
   */
  evaluate(
    toolName: string,
    parameters: Record<string, any>,
    riskScore: number
  ): ApprovalDecision | undefined {
    // 1. Check deny rules first
    for (const rule of this.denyRules) {
      if (this.matchesRule(rule, toolName, parameters, riskScore)) {
        return 'deny';
      }
    }

    // 2. Check ask rules
    for (const rule of this.askRules) {
      if (this.matchesRule(rule, toolName, parameters, riskScore)) {
        return 'ask_user';
      }
    }

    // 3. Check allow rules
    for (const rule of this.allowRules) {
      if (this.matchesRule(rule, toolName, parameters, riskScore)) {
        return 'auto_approve';
      }
    }

    // No rule matched
    return undefined;
  }

  /**
   * Check if a rule matches the given tool call
   */
  private matchesRule(
    rule: PolicyRule,
    toolName: string,
    parameters: Record<string, any>,
    riskScore: number
  ): boolean {
    const { match } = rule;

    // All specified conditions must match (AND logic)

    // Check tool name match (supports glob-like * patterns)
    if (match.tool !== undefined) {
      if (!this.matchToolName(match.tool, toolName)) {
        return false;
      }
    }

    // Check parameter pattern match
    if (match.pattern !== undefined) {
      try {
        const regex = new RegExp(match.pattern, 'i');
        if (toolName === 'terminal') {
          // Terminal: match against the command string directly
          const command = typeof parameters.command === 'string' ? parameters.command : '';
          if (!regex.test(command)) {
            return false;
          }
        } else {
          // Non-terminal: match against parameter values only (not keys)
          const values = this.extractParameterValues(parameters);
          if (!values.some(v => regex.test(v))) {
            return false;
          }
        }
      } catch {
        // Invalid regex, rule doesn't match
        return false;
      }
    }

    // Check risk score threshold
    if (match.riskAbove !== undefined) {
      if (riskScore <= match.riskAbove) {
        return false;
      }
    }

    return true;
  }

  /**
   * Match tool name with glob-like support (* matches anything)
   */
  private matchToolName(pattern: string, toolName: string): boolean {
    if (pattern === '*') return true;
    if (pattern === toolName) return true;

    // Convert glob to regex: * -> .*, escape other regex chars
    const regexStr = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    try {
      return new RegExp(`^${regexStr}$`).test(toolName);
    } catch {
      return false;
    }
  }

  /**
   * Extract all leaf string values from parameters (excludes keys).
   * This prevents patterns from accidentally matching JSON key names.
   */
  private extractParameterValues(parameters: Record<string, any>): string[] {
    const values: string[] = [];
    for (const value of Object.values(parameters)) {
      if (typeof value === 'string') {
        values.push(value);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        values.push(String(value));
      }
    }
    return values;
  }
}
