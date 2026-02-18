/**
 * Comprehensive unit tests for all three risk enhancers:
 * - DomainSensitivityEnhancer
 * - SemanticElementEnhancer
 * - SensitivePathEnhancer
 *
 * This file focuses on edge cases, boundary conditions, and scenarios
 * not covered by the existing enhancers-and-rules.test.ts and
 * phase2-enhancers.test.ts files.
 */

import { describe, it, expect } from 'vitest';
import { DomainSensitivityEnhancer } from '../enhancers/DomainSensitivityEnhancer';
import { SemanticElementEnhancer } from '../enhancers/SemanticElementEnhancer';
import { SensitivePathEnhancer } from '../enhancers/SensitivePathEnhancer';
import { RiskLevel, scoreToRiskLevel } from '../types';
import type { RiskAssessment, ApprovalContext } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssessment(score: number, factors: string[] = ['Base assessment']): RiskAssessment {
  return {
    score,
    level: scoreToRiskLevel(score),
    factors: [...factors],
    action: score <= 30 ? 'auto_approve' : score <= 85 ? 'ask_user' : 'deny',
  };
}

function makeContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    toolName: 'dom_tool',
    parameters: {},
    ...overrides,
  };
}

// ============================================================================
// DomainSensitivityEnhancer — additional coverage
// ============================================================================

describe('DomainSensitivityEnhancer', () => {
  const enhancer = new DomainSensitivityEnhancer();

  describe('financial domain — additional patterns', () => {
    it('should boost for venmo.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'venmo.com' }),
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('Financial'))).toBe(true);
    });

    it('should boost for wise.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'wise.com' }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for robinhood.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'robinhood.com' }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for coinbase.com', () => {
      const result = enhancer.enhance(
        makeAssessment(40),
        makeContext({ currentDomain: 'coinbase.com' }),
      );
      expect(result.score).toBe(60);
    });

    it('should boost for chase.com', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ currentDomain: 'chase.com' }),
      );
      expect(result.score).toBe(40);
    });

    it('should boost for wellsfargo.com', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ currentDomain: 'wellsfargo.com' }),
      );
      expect(result.score).toBe(40);
    });

    it('should boost for capitalone.com', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ currentDomain: 'capitalone.com' }),
      );
      expect(result.score).toBe(40);
    });

    it('should boost for americanexpress.com', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ currentDomain: 'americanexpress.com' }),
      );
      expect(result.score).toBe(40);
    });

    it('should boost for braintree.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'braintree.com' }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for .gov. subdomains (e.g. portal.gov.uk)', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'portal.gov.uk' }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for bank- prefixed domains', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ currentDomain: 'bank-of-america.com' }),
      );
      expect(result.score).toBe(45);
    });

    it('should boost for .bank TLD', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ currentDomain: 'myaccount.bank' }),
      );
      expect(result.score).toBe(45);
    });
  });

  describe('social media domain — additional patterns', () => {
    it('should boost for twitter.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'twitter.com' }),
      );
      expect(result.score).toBe(40);
      expect(result.factors.some(f => f.includes('Social media'))).toBe(true);
    });

    it('should boost for facebook.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'facebook.com' }),
      );
      expect(result.score).toBe(40);
    });

    it('should boost for instagram.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'instagram.com' }),
      );
      expect(result.score).toBe(40);
    });

    it('should boost for reddit.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'reddit.com' }),
      );
      expect(result.score).toBe(40);
    });
  });

  describe('local/dev domain — additional patterns', () => {
    it('should reduce for 0.0.0.0', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: '0.0.0.0' }),
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for 192.168.x.x private addresses', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: '192.168.1.100' }),
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for 10.x.x.x private addresses', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: '10.0.0.1' }),
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for 172.16-31.x.x private addresses', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: '172.16.0.1' }),
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for 172.31.x.x (upper end of range)', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: '172.31.255.255' }),
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for .test domains', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'myapp.test' }),
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for .localhost domains', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'api.localhost' }),
      );
      expect(result.score).toBe(20);
    });
  });

  describe('risk level transitions', () => {
    it('should transition from Low to Medium for financial domain', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ currentDomain: 'paypal.com' }),
      );
      expect(result.level).toBe(RiskLevel.Medium);
    });

    it('should transition from Medium to High for financial domain', () => {
      const result = enhancer.enhance(
        makeAssessment(50),
        makeContext({ currentDomain: 'paypal.com' }),
      );
      expect(result.level).toBe(RiskLevel.High);
    });

    it('should transition from Low to None for local domain', () => {
      const result = enhancer.enhance(
        makeAssessment(15),
        makeContext({ currentDomain: 'localhost' }),
      );
      expect(result.score).toBe(5);
      expect(result.level).toBe(RiskLevel.None);
    });
  });

  describe('factor message formatting', () => {
    it('should include domain name in financial factor message', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'stripe.com' }),
      );
      expect(result.factors.some(f => f.includes('stripe.com'))).toBe(true);
    });

    it('should include domain name in social factor message', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'github.com' }),
      );
      expect(result.factors.some(f => f.includes('github.com'))).toBe(true);
    });

    it('should include domain name in local factor message', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'localhost' }),
      );
      expect(result.factors.some(f => f.includes('localhost'))).toBe(true);
    });

    it('should preserve existing factors from the base assessment', () => {
      const result = enhancer.enhance(
        makeAssessment(30, ['Existing factor 1', 'Existing factor 2']),
        makeContext({ currentDomain: 'paypal.com' }),
      );
      expect(result.factors).toContain('Existing factor 1');
      expect(result.factors).toContain('Existing factor 2');
      expect(result.factors.length).toBe(3);
    });
  });

  describe('immutability', () => {
    it('should not mutate the original assessment', () => {
      const original = makeAssessment(30);
      const originalScore = original.score;
      const originalFactors = [...original.factors];
      enhancer.enhance(original, makeContext({ currentDomain: 'paypal.com' }));
      expect(original.score).toBe(originalScore);
      expect(original.factors).toEqual(originalFactors);
    });

    it('should return same assessment object when domain is unknown', () => {
      const original = makeAssessment(30);
      const result = enhancer.enhance(original, makeContext({ currentDomain: 'example.com' }));
      expect(result).toBe(original);
    });

    it('should return same assessment object when no domain provided', () => {
      const original = makeAssessment(30);
      const result = enhancer.enhance(original, makeContext({}));
      expect(result).toBe(original);
    });
  });
});

// ============================================================================
// SemanticElementEnhancer — additional coverage
// ============================================================================

describe('SemanticElementEnhancer', () => {
  const enhancer = new SemanticElementEnhancer();

  describe('type action — sensitive field patterns', () => {
    it('should boost for password field (+25)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', name: 'password' } }),
      );
      expect(result.score).toBe(45);
      expect(result.factors.some(f => f.includes('password_field'))).toBe(true);
    });

    it('should boost for passwd field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'Enter passwd' } }),
      );
      expect(result.score).toBe(45);
    });

    it('should boost for pwd field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', name: 'pwd' } }),
      );
      expect(result.score).toBe(45);
    });

    it('should boost for credit card field (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'Credit Card Number' } }),
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('financial_field'))).toBe(true);
    });

    it('should boost for card number field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', name: 'card-number' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for CVV field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'CVV' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for CVC field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'CVC' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for expiry field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'Expiration Date' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for SSN field (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', name: 'ssn' } }),
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('identity_field'))).toBe(true);
    });

    it('should boost for social security field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'Social Security Number' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should boost for tax ID field', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'Tax ID' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should use highest matching sensitive field pattern', () => {
      // "credit card password" should match both financial_field (+30) and password_field (+25)
      // financial_field (+30) should win
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'credit card', name: 'password' } }),
      );
      expect(result.score).toBe(50); // 20 + 30
    });

    it('should not boost for non-sensitive type fields', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', placeholder: 'Enter your name' } }),
      );
      expect(result.score).toBe(20);
    });

    it('should not boost type action with no element text', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type' } }),
      );
      expect(result.score).toBe(20);
    });
  });

  describe('element text extraction from various parameter fields', () => {
    it('should extract text from aria_label', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', aria_label: 'Delete item' } }),
      );
      expect(result.score).toBe(60); // 20 + 40
    });

    it('should extract text from role', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', role: 'submit' } }),
      );
      expect(result.score).toBe(50); // 20 + 30
    });

    it('should extract text from name', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', name: 'purchase-btn' } }),
      );
      expect(result.score).toBe(70); // 20 + 50
    });

    it('should extract text from placeholder', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', placeholder: 'Send message' } }),
      );
      expect(result.score).toBe(45); // 20 + 25
    });

    it('should extract text from title', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', title: 'Confirm order' } }),
      );
      expect(result.score).toBe(50); // 20 + 30
    });

    it('should extract text from type parameter', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', type: 'submit' } }),
      );
      expect(result.score).toBe(50); // 20 + 30
    });

    it('should combine text from multiple parameter fields', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({
          parameters: {
            action: 'click',
            aria_label: 'action',
            text: 'buy',
          },
        }),
      );
      expect(result.score).toBe(70); // 20 + 50 (buy is financial)
    });
  });

  describe('additional click patterns', () => {
    it('should detect "pay" as financial', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Pay Now' } }),
      );
      expect(result.score).toBe(70);
    });

    it('should detect "place order" as financial', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Place Order' } }),
      );
      expect(result.score).toBe(70);
    });

    it('should detect "erase" as data modification', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Erase Data' } }),
      );
      expect(result.score).toBe(60); // 20 + 40
    });

    it('should detect "destroy" as data modification', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Destroy Instance' } }),
      );
      expect(result.score).toBe(60);
    });

    it('should detect "deactivate" as data modification', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Deactivate Account' } }),
      );
      expect(result.score).toBe(60);
    });

    it('should detect "apply" as form submission', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Apply Changes' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should detect "proceed" as form submission', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Proceed to Next Step' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should detect "complete" as form submission', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Complete Registration' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should detect "finish" as form submission', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Finish Setup' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should detect "tweet" as communication', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Tweet' } }),
      );
      expect(result.score).toBe(45);
    });

    it('should detect "reply" as communication', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Reply to Thread' } }),
      );
      expect(result.score).toBe(45);
    });

    it('should detect "share" as communication', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Share Post' } }),
      );
      expect(result.score).toBe(45);
    });

    it('should detect "sign in" as authentication', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Sign In' } }),
      );
      expect(result.score).toBe(40);
    });

    it('should detect "register" as authentication', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Register Now' } }),
      );
      expect(result.score).toBe(40);
    });

    it('should detect "forgot password" as authentication', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Forgot Password' } }),
      );
      expect(result.score).toBe(40);
    });
  });

  describe('priority — highest pattern wins when multiple match', () => {
    it('financial (+50) should beat data modification (+40)', () => {
      // "Purchase and Delete" contains both buy (+50) and delete (+40)
      const result = enhancer.enhance(
        makeAssessment(10),
        makeContext({ parameters: { action: 'click', text: 'Purchase and Delete' } }),
      );
      expect(result.score).toBe(60); // 10 + 50
    });

    it('data modification (+40) should beat form submission (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(10),
        makeContext({ parameters: { action: 'click', text: 'Submit Delete Request' } }),
      );
      expect(result.score).toBe(50); // 10 + 40
    });

    it('form submission (+30) should beat communication (+25)', () => {
      const result = enhancer.enhance(
        makeAssessment(10),
        makeContext({ parameters: { action: 'click', text: 'Submit and Send' } }),
      );
      expect(result.score).toBe(40); // 10 + 30
    });
  });

  describe('factor message formatting', () => {
    it('should include category in factor message for click', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: 'Buy' } }),
      );
      expect(result.factors.some(f => /Semantic element \(financial\)/.test(f))).toBe(true);
    });

    it('should include category in factor message for type', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'type', name: 'password' } }),
      );
      expect(result.factors.some(f => /Sensitive field \(password_field\)/.test(f))).toBe(true);
    });

    it('should truncate long element text in factor message to 50 chars', () => {
      const longText = 'Buy this extremely long product name that exceeds fifty characters in total length';
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', text: longText } }),
      );
      const semanticFactor = result.factors.find(f => f.includes('Semantic element'));
      expect(semanticFactor).toBeDefined();
      // The quoted text portion should be at most 50 chars
      const match = semanticFactor!.match(/"(.+?)"/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(50);
    });

    it('should preserve existing factors in the assessment', () => {
      const result = enhancer.enhance(
        makeAssessment(20, ['Existing factor']),
        makeContext({ parameters: { action: 'click', text: 'Delete' } }),
      );
      expect(result.factors).toContain('Existing factor');
      expect(result.factors.length).toBe(2);
    });
  });

  describe('score clamping and boundaries', () => {
    it('should clamp score at 0 minimum (type action)', () => {
      // This scenario cannot actually happen with positive boosts, but
      // we verify the clamping math works
      const result = enhancer.enhance(
        makeAssessment(0),
        makeContext({ parameters: { action: 'type', name: 'email' } }),
      );
      // No matching pattern for 'email', score stays 0
      expect(result.score).toBe(0);
    });

    it('should clamp type action score at 100', () => {
      const result = enhancer.enhance(
        makeAssessment(85),
        makeContext({ parameters: { action: 'type', placeholder: 'Credit Card Number' } }),
      );
      expect(result.score).toBe(100);
    });

    it('should update risk level correctly when score crosses threshold', () => {
      // Score 55 (Medium) + 50 (financial) = 100 (Critical)
      const result = enhancer.enhance(
        makeAssessment(55),
        makeContext({ parameters: { action: 'click', text: 'Buy Now' } }),
      );
      expect(result.score).toBe(100);
      expect(result.level).toBe(RiskLevel.Critical);
    });
  });

  describe('immutability', () => {
    it('should not mutate the original assessment (click)', () => {
      const original = makeAssessment(20);
      const originalScore = original.score;
      enhancer.enhance(original, makeContext({ parameters: { action: 'click', text: 'Delete' } }));
      expect(original.score).toBe(originalScore);
    });

    it('should not mutate the original assessment (type)', () => {
      const original = makeAssessment(20);
      const originalFactors = [...original.factors];
      enhancer.enhance(original, makeContext({ parameters: { action: 'type', name: 'password' } }));
      expect(original.factors).toEqual(originalFactors);
    });

    it('should return same assessment object for non-matching click text', () => {
      const original = makeAssessment(20);
      const result = enhancer.enhance(
        original,
        makeContext({ parameters: { action: 'click', text: 'Next' } }),
      );
      expect(result).toBe(original);
    });

    it('should return same assessment object for non-matching actions', () => {
      const original = makeAssessment(20);
      const result = enhancer.enhance(
        original,
        makeContext({ parameters: { action: 'scroll', text: 'Delete' } }),
      );
      expect(result).toBe(original);
    });
  });
});

// ============================================================================
// SensitivePathEnhancer — additional coverage
// ============================================================================

describe('SensitivePathEnhancer', () => {
  const enhancer = new SensitivePathEnhancer();

  describe('sensitive file patterns — additional', () => {
    it('should detect .cert files (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat server.cert' } }),
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('sensitive_file'))).toBe(true);
    });

    it('should detect .p12 files (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'openssl pkcs12 -in keystore.p12' } }),
      );
      expect(result.score).toBe(50);
    });

    it('should detect .env in middle of command', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'source .env && node app.js' } }),
      );
      expect(result.score).toBe(50);
    });
  });

  describe('config directory patterns — additional', () => {
    it('should detect /.config/ paths (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat ~/.config/gcloud/credentials.json' } }),
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('config_directory'))).toBe(true);
    });
  });

  describe('command parameter type guards', () => {
    it('should handle numeric command parameter gracefully', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 42 } }),
      );
      expect(result.score).toBe(20);
    });

    it('should handle null command parameter gracefully', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: null } }),
      );
      expect(result.score).toBe(20);
    });

    it('should handle undefined command parameter gracefully', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: undefined } }),
      );
      expect(result.score).toBe(20);
    });

    it('should handle boolean command parameter gracefully', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: true } }),
      );
      expect(result.score).toBe(20);
    });
  });

  describe('multiple path matches — highest wins', () => {
    it('system directory (+40) should beat sensitive file (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/.env' } }),
      );
      expect(result.score).toBe(60); // 20 + 40
      expect(result.factors.some(f => f.includes('system_directory'))).toBe(true);
    });

    it('system directory (+40) should beat config directory (+30)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/.ssh/config' } }),
      );
      expect(result.score).toBe(60); // 20 + 40
    });

    it('sensitive file (+30) should beat project internal (+5)', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /node_modules/.env' } }),
      );
      expect(result.score).toBe(50); // 20 + 30
    });
  });

  describe('non-terminal tool names', () => {
    it('should not activate for browser_dom tool', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'browser_dom', parameters: { command: 'cat /etc/passwd' } }),
      );
      expect(result.score).toBe(20);
    });

    it('should not activate for web_search tool', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'web_search', parameters: { command: 'cat /etc/passwd' } }),
      );
      expect(result.score).toBe(20);
    });

    it('should not activate for mcp_tool', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'mcp_tool', parameters: { command: 'rm -rf /etc/' } }),
      );
      expect(result.score).toBe(20);
    });
  });

  describe('risk level transitions', () => {
    it('should transition from Low to High for system directory', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'rm -rf /etc/*' } }),
      );
      expect(result.score).toBe(65);
      expect(result.level).toBe(RiskLevel.High);
    });

    it('should transition to Critical when score exceeds 85', () => {
      const result = enhancer.enhance(
        makeAssessment(70),
        makeContext({ toolName: 'terminal', parameters: { command: 'rm -rf /etc/*' } }),
      );
      expect(result.score).toBe(100); // clamped at 100
      expect(result.level).toBe(RiskLevel.Critical);
    });
  });

  describe('factor message formatting', () => {
    it('should include category and boost in factor message', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/passwd' } }),
      );
      expect(result.factors).toContain('Sensitive path (system_directory): +40 risk');
    });

    it('should preserve existing assessment factors', () => {
      const result = enhancer.enhance(
        makeAssessment(20, ['Factor A', 'Factor B']),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/passwd' } }),
      );
      expect(result.factors).toContain('Factor A');
      expect(result.factors).toContain('Factor B');
      expect(result.factors.length).toBe(3);
    });
  });

  describe('immutability', () => {
    it('should not mutate the original assessment', () => {
      const original = makeAssessment(20);
      const originalScore = original.score;
      const originalFactors = [...original.factors];
      enhancer.enhance(
        original,
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/passwd' } }),
      );
      expect(original.score).toBe(originalScore);
      expect(original.factors).toEqual(originalFactors);
    });

    it('should return same assessment object for non-terminal tool', () => {
      const original = makeAssessment(20);
      const result = enhancer.enhance(
        original,
        makeContext({ toolName: 'dom_tool', parameters: { command: 'cat /etc/passwd' } }),
      );
      expect(result).toBe(original);
    });

    it('should return same assessment object for safe terminal command', () => {
      const original = makeAssessment(20);
      const result = enhancer.enhance(
        original,
        makeContext({ toolName: 'terminal', parameters: { command: 'echo hello' } }),
      );
      expect(result).toBe(original);
    });
  });
});
