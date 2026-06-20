/**
 * HookMatcher — Pattern matching for hook tool names and parameters.
 *
 * Matcher syntax (adapted from claudy):
 * - undefined / empty  → matches everything
 * - "browser_dom"      → exact tool name match
 * - "browser_dom|web_search" → pipe-separated alternatives
 * - "browser_dom(click)" → tool name + action parameter match
 * - "browser_dom(click|type)" → tool name + multiple action alternatives
 * - "*"                → wildcard, matches anything
 */

interface ParsedPattern {
  readonly toolNames: string[];
  readonly actions: string[];
}

export class HookMatcher {
  /**
   * Check if a matcher pattern matches a given tool call.
   */
  static matches(
    pattern: string | undefined,
    toolName: string,
    parameters?: Record<string, unknown>,
  ): boolean {
    if (pattern === undefined || pattern === '' || pattern === '*') {
      return true;
    }

    const parsed = HookMatcher.parse(pattern);

    // Check tool name
    const nameMatches = parsed.toolNames.some(
      (name) => name === '*' || name === toolName,
    );
    if (!nameMatches) {
      return false;
    }

    // If no action filter, tool name match is sufficient
    if (parsed.actions.length === 0) {
      return true;
    }

    // Check action parameter
    const action = HookMatcher.extractAction(parameters);
    if (action === undefined) {
      return false;
    }

    return parsed.actions.some((a) => a === '*' || a === action);
  }

  /**
   * Check if an `if` condition matches the tool call.
   * The `if` field uses the same syntax as the matcher pattern.
   */
  static matchesCondition(
    condition: string | undefined,
    toolName: string,
    parameters?: Record<string, unknown>,
  ): boolean {
    if (condition === undefined || condition === '') {
      return true;
    }
    return HookMatcher.matches(condition, toolName, parameters);
  }

  /**
   * Parse a matcher pattern into structured form.
   *
   * Examples:
   *   "browser_dom" → { toolNames: ['browser_dom'], actions: [] }
   *   "browser_dom|web_search" → { toolNames: ['browser_dom', 'web_search'], actions: [] }
   *   "browser_dom(click|type)" → { toolNames: ['browser_dom'], actions: ['click', 'type'] }
   */
  static parse(pattern: string): ParsedPattern {
    const parenIdx = pattern.indexOf('(');

    if (parenIdx === -1) {
      // No action filter
      return {
        toolNames: pattern.split('|').map((s) => s.trim()).filter(Boolean),
        actions: [],
      };
    }

    const toolPart = pattern.slice(0, parenIdx);
    const closeIdx = pattern.indexOf(')', parenIdx);
    const actionPart =
      closeIdx === -1
        ? pattern.slice(parenIdx + 1)
        : pattern.slice(parenIdx + 1, closeIdx);

    return {
      toolNames: toolPart.split('|').map((s) => s.trim()).filter(Boolean),
      actions: actionPart.split('|').map((s) => s.trim()).filter(Boolean),
    };
  }

  /**
   * Extract the primary action parameter from tool parameters.
   * Looks for common action-like fields used in WorkX tools.
   */
  private static extractAction(
    parameters?: Record<string, unknown>,
  ): string | undefined {
    if (!parameters) return undefined;

    // WorkX browser_dom uses 'action'
    if (typeof parameters.action === 'string') {
      return parameters.action;
    }

    // Fallback: 'command' for terminal-like tools
    if (typeof parameters.command === 'string') {
      return parameters.command;
    }

    return undefined;
  }
}
