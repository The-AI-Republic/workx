/**
 * Sensitive Path Enhancer
 *
 * Desktop-only enhancer that boosts risk for terminal commands
 * targeting sensitive file paths (.env, /etc/, .ssh, etc.).
 */

import type { IContextEnhancer, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

/** Path patterns with risk adjustments */
const PATH_PATTERNS: Array<{ pattern: RegExp; boost: number; category: string }> = [
  {
    pattern: /\/etc\/|\/usr\/|\/sys\/|\/boot\//,
    boost: 40,
    category: 'system_directory',
  },
  {
    pattern: /\.env\b|\.pem\b|\.key\b|\.cert\b|\.p12\b/,
    boost: 30,
    category: 'sensitive_file',
  },
  {
    pattern: /\/\.ssh\/|\/\.gnupg\/|\/\.config\/|\/\.aws\//,
    boost: 30,
    category: 'config_directory',
  },
  {
    pattern: /\/node_modules\/|\/\.git\//,
    boost: 5,
    category: 'project_internal',
  },
];

export class SensitivePathEnhancer implements IContextEnhancer {
  enhance(assessment: RiskAssessment, context: ApprovalContext): RiskAssessment {
    // Only activate for terminal tool
    if (context.toolName !== 'terminal') {
      return assessment;
    }

    const command = context.parameters?.command;
    if (typeof command !== 'string') return assessment;

    // Find highest matching pattern
    let bestBoost = 0;
    let bestCategory = '';

    for (const { pattern, boost, category } of PATH_PATTERNS) {
      if (pattern.test(command) && boost > bestBoost) {
        bestBoost = boost;
        bestCategory = category;
      }
    }

    if (bestBoost === 0) return assessment;

    const newScore = Math.max(0, Math.min(100, assessment.score + bestBoost));
    const factors = [
      ...assessment.factors,
      `Sensitive path (${bestCategory}): +${bestBoost} risk`,
    ];

    return {
      ...assessment,
      score: newScore,
      level: scoreToRiskLevel(newScore),
      factors,
    };
  }
}
