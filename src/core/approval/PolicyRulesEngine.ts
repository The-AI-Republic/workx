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
    const paramString = JSON.stringify(parameters);

    // 1. Check deny rules first
    for (const rule of this.denyRules) {
      if (this.matchesRule(rule, toolName, paramString, riskScore)) {
        return 'deny';
      }
    }

    // 2. Check ask rules
    for (const rule of this.askRules) {
      if (this.matchesRule(rule, toolName, paramString, riskScore)) {
        return 'ask_user';
      }
    }

    // 3. Check allow rules
    for (const rule of this.allowRules) {
      if (this.matchesRule(rule, toolName, paramString, riskScore)) {
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
    paramString: string,
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
        // For terminal tool, match against command parameter directly
        if (toolName === 'terminal') {
          const command = this.extractCommand(paramString);
          if (!regex.test(command) && !regex.test(paramString)) {
            return false;
          }
        } else if (!regex.test(paramString)) {
          return false;
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
   * Extract command string from serialized parameters (for terminal tool)
   */
  private extractCommand(paramString: string): string {
    try {
      const params = JSON.parse(paramString);
      return typeof params.command === 'string' ? params.command : '';
    } catch {
      return '';
    }
  }
}
