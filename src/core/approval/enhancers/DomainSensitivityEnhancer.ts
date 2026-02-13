/**
 * Domain Sensitivity Enhancer
 *
 * Adjusts risk scores based on the current page domain.
 * Financial and sensitive sites get boosted scores,
 * dev/local sites get reduced scores.
 */

import type { IContextEnhancer, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

/** Financial/banking domains that warrant extra caution */
const FINANCIAL_PATTERNS = [
  /paypal\.com$/,
  /^bank/,
  /\.bank\./,
  /\.gov$/,
  /\.gov\./,
  /stripe\.com$/,
  /braintree/,
  /venmo\.com$/,
  /wise\.com$/,
  /robinhood\.com$/,
  /coinbase\.com$/,
  /chase\.com$/,
  /wellsfargo\.com$/,
  /capitalone\.com$/,
  /americanexpress\.com$/,
];

/** Social media domains with authenticated state */
const SOCIAL_PATTERNS = [
  /linkedin\.com$/,
  /twitter\.com$/,
  /x\.com$/,
  /facebook\.com$/,
  /instagram\.com$/,
  /reddit\.com$/,
  /github\.com$/,
];

/** Local/dev domains that are lower risk */
const LOCAL_PATTERNS = [
  /^localhost$/,
  /^127\.0\.0\.1$/,
  /^0\.0\.0\.0$/,
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local$/,
  /\.test$/,
  /\.dev$/,
  /\.localhost$/,
];

export class DomainSensitivityEnhancer implements IContextEnhancer {
  enhance(assessment: RiskAssessment, context: ApprovalContext): RiskAssessment {
    const domain = context.currentDomain;
    if (!domain) return assessment;

    let scoreAdjustment = 0;
    const factors = [...assessment.factors];

    // Check financial domains
    if (FINANCIAL_PATTERNS.some(p => p.test(domain))) {
      scoreAdjustment = 20;
      factors.push(`Financial/government domain (${domain}): +20 risk`);
    }
    // Check social media domains
    else if (SOCIAL_PATTERNS.some(p => p.test(domain))) {
      scoreAdjustment = 10;
      factors.push(`Social media domain (${domain}): +10 risk`);
    }
    // Check local/dev domains
    else if (LOCAL_PATTERNS.some(p => p.test(domain))) {
      scoreAdjustment = -10;
      factors.push(`Local/dev domain (${domain}): -10 risk`);
    }

    if (scoreAdjustment === 0) return assessment;

    const newScore = Math.max(0, Math.min(100, assessment.score + scoreAdjustment));

    return {
      ...assessment,
      score: newScore,
      level: scoreToRiskLevel(newScore),
      factors,
    };
  }
}
