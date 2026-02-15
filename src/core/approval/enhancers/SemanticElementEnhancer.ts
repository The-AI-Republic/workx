/**
 * Semantic Element Enhancer
 *
 * Extension-only enhancer that boosts risk when DOM element labels
 * indicate dangerous actions (submit, delete, purchase, etc.).
 */

import type { IContextEnhancer, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

/** Pattern groups with risk adjustments for click/keypress actions */
const ELEMENT_PATTERNS: Array<{ pattern: RegExp; boost: number; category: string }> = [
  {
    pattern: /\b(buy|purchase|checkout|pay|place\s*order|subscribe)\b/i,
    boost: 50,
    category: 'financial',
  },
  {
    pattern: /\b(delete|remove|erase|destroy|deactivate|close\s*account)\b/i,
    boost: 40,
    category: 'data_modification',
  },
  {
    pattern: /\b(submit|confirm|apply|save|proceed|complete|finish)\b/i,
    boost: 30,
    category: 'form_submission',
  },
  {
    pattern: /\b(send|post|publish|tweet|reply|share)\b/i,
    boost: 25,
    category: 'communication',
  },
  {
    pattern: /\b(log\s*in|sign\s*in|sign\s*up|register|forgot\s*password)\b/i,
    boost: 20,
    category: 'authentication',
  },
];

/** Sensitive field patterns for type actions */
const SENSITIVE_FIELD_PATTERNS: Array<{ pattern: RegExp; boost: number; category: string }> = [
  {
    pattern: /\b(password|passwd|pwd)\b/i,
    boost: 25,
    category: 'password_field',
  },
  {
    pattern: /\b(credit.?card|card.?number|cvv|cvc|expir)/i,
    boost: 30,
    category: 'financial_field',
  },
  {
    pattern: /\b(ssn|social.?security|tax.?id)\b/i,
    boost: 30,
    category: 'identity_field',
  },
];

export class SemanticElementEnhancer implements IContextEnhancer {
  enhance(assessment: RiskAssessment, context: ApprovalContext): RiskAssessment {
    const action = context.parameters?.action;

    // Handle type action: check for sensitive field patterns
    if (action === 'type') {
      return this.enhanceTypeAction(assessment, context);
    }

    // Only activate for click and keypress actions
    if (action !== 'click' && action !== 'keypress') {
      return assessment;
    }

    // Extract element text from parameters
    const elementText = this.extractElementText(context.parameters);
    if (!elementText) return assessment;

    // Find highest matching pattern
    let bestBoost = 0;
    let bestCategory = '';

    for (const { pattern, boost, category } of ELEMENT_PATTERNS) {
      if (pattern.test(elementText) && boost > bestBoost) {
        bestBoost = boost;
        bestCategory = category;
      }
    }

    if (bestBoost === 0) return assessment;

    const newScore = Math.max(0, Math.min(100, assessment.score + bestBoost));
    const factors = [
      ...assessment.factors,
      `Semantic element (${bestCategory}): "${elementText.slice(0, 50)}" +${bestBoost} risk`,
    ];

    return {
      ...assessment,
      score: newScore,
      level: scoreToRiskLevel(newScore),
      factors,
    };
  }

  private enhanceTypeAction(assessment: RiskAssessment, context: ApprovalContext): RiskAssessment {
    const elementText = this.extractElementText(context.parameters);
    if (!elementText) return assessment;

    let bestBoost = 0;
    let bestCategory = '';

    for (const { pattern, boost, category } of SENSITIVE_FIELD_PATTERNS) {
      if (pattern.test(elementText) && boost > bestBoost) {
        bestBoost = boost;
        bestCategory = category;
      }
    }

    if (bestBoost === 0) return assessment;

    const newScore = Math.max(0, Math.min(100, assessment.score + bestBoost));
    const factors = [
      ...assessment.factors,
      `Sensitive field (${bestCategory}): "${elementText.slice(0, 50)}" +${bestBoost} risk`,
    ];

    return {
      ...assessment,
      score: newScore,
      level: scoreToRiskLevel(newScore),
      factors,
    };
  }

  private extractElementText(parameters: Record<string, any>): string {
    const parts: string[] = [];

    if (parameters.aria_label) parts.push(parameters.aria_label);
    if (parameters.text) parts.push(parameters.text);
    if (parameters.role) parts.push(parameters.role);
    if (parameters.name) parts.push(parameters.name);
    if (parameters.placeholder) parts.push(parameters.placeholder);
    if (parameters.title) parts.push(parameters.title);
    if (parameters.type) parts.push(parameters.type);

    return parts.join(' ').trim();
  }
}
