/**
 * Default Policy Rules
 *
 * Built-in policy rules for both extension and desktop platforms.
 * Rules follow deny > ask > allow evaluation order.
 */

import type { PolicyRule } from './types';

/**
 * Shared rules applied on all platforms
 */
const sharedRules: PolicyRule[] = [
  // --- ASK rules ---
  {
    type: 'ask',
    match: { riskAbove: 30 },
    description: 'Ask user for medium-risk and above actions (score > 30)',
  },

  // --- ALLOW rules ---
  {
    type: 'allow',
    match: { tool: 'planning_tool' },
    description: 'Planning tool is always safe',
  },
  {
    type: 'allow',
    match: { tool: 'web_search' },
    description: 'Web search is always safe',
  },
];

/**
 * Extension-specific rules
 */
const extensionRules: PolicyRule[] = [
  // ALLOW read-only DOM operations
  {
    type: 'allow',
    match: { tool: 'browser_dom', pattern: '^snapshot$' },
    description: 'DOM snapshot is read-only and safe',
  },
  {
    type: 'allow',
    match: { tool: 'browser_dom', pattern: '^scroll$' },
    description: 'DOM scroll is low-risk',
  },

  // ASK for interactive DOM operations
  {
    type: 'ask',
    match: { tool: 'browser_dom', pattern: '^click$' },
    description: 'DOM click requires approval',
  },
  {
    type: 'ask',
    match: { tool: 'browser_dom', pattern: '^type$' },
    description: 'DOM type requires approval',
  },
];

/**
 * Desktop-specific rules
 */
const desktopRules: PolicyRule[] = [
  // ALLOW safe terminal read-only commands
  {
    type: 'allow',
    match: { tool: 'terminal', pattern: '^(ls|cat|head|tail|grep|pwd|echo|find|wc)\\b' },
    description: 'Read-only terminal commands are safe',
  },
  {
    type: 'allow',
    match: { tool: 'terminal', pattern: '^git\\s+(status|log|diff|branch)' },
    description: 'Read-only git commands are safe',
  },

  // ASK for modifying terminal commands
  {
    type: 'ask',
    match: { tool: 'terminal', pattern: '^(sudo|rm|mv|chmod|chown|docker)\\b' },
    description: 'Modifying terminal commands require approval',
  },

  // DENY dangerous terminal commands (SecurityFilter patterns)
  {
    type: 'deny',
    match: { tool: 'terminal', pattern: 'rm\\s+(?=(-[rf]+\\s+)*-[rf]*r)(-[rf]+\\s+)+/' },
    description: 'Destructive rm on root is blocked',
  },
  {
    type: 'deny',
    match: { tool: 'terminal', pattern: 'curl.*\\|.*sh' },
    description: 'Piping curl to shell is blocked',
  },
  {
    type: 'deny',
    match: { tool: 'terminal', pattern: 'wget.*\\|.*sh' },
    description: 'Piping wget to shell is blocked',
  },
  {
    type: 'deny',
    match: { tool: 'terminal', pattern: ':\\(\\)\\{\\s*:\\|:&\\s*\\};:' },
    description: 'Fork bomb is blocked',
  },
];

/**
 * Get default policy rules for the given platform
 */
export function getDefaultRules(platform?: 'extension' | 'desktop'): PolicyRule[] {
  const platformRules = platform === 'desktop' ? desktopRules : extensionRules;
  return [...platformRules, ...sharedRules];
}
