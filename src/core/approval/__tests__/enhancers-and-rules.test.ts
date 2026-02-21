/**
 * Unit tests for DomainSensitivityEnhancer and defaultRules
 */

import { describe, it, expect } from 'vitest';
import { DomainSensitivityEnhancer } from '../enhancers/DomainSensitivityEnhancer';
import { getDefaultRules } from '../defaultRules';
import { RiskLevel, scoreToRiskLevel } from '../types';
import type { RiskAssessment, ApprovalContext } from '../types';

function makeAssessment(score: number): RiskAssessment {
  return {
    score,
    level: scoreToRiskLevel(score),
    factors: ['Base assessment'],
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

describe('DomainSensitivityEnhancer', () => {
  const enhancer = new DomainSensitivityEnhancer();

  describe('financial domains', () => {
    it('should boost score by 20 for paypal.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'paypal.com' })
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('Financial'))).toBe(true);
    });

    it('should boost for bank domains', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'bank.example.com' })
      );
      expect(result.score).toBe(50);
    });

    it('should boost for .gov domains', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'irs.gov' })
      );
      expect(result.score).toBe(50);
    });

    it('should boost for stripe.com', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ currentDomain: 'stripe.com' })
      );
      expect(result.score).toBe(45);
    });
  });

  describe('social media domains', () => {
    it('should boost score by 10 for linkedin.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'linkedin.com' })
      );
      expect(result.score).toBe(40);
      expect(result.factors.some(f => f.includes('Social media'))).toBe(true);
    });

    it('should boost for github.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'github.com' })
      );
      expect(result.score).toBe(40);
    });

    it('should boost for x.com', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'x.com' })
      );
      expect(result.score).toBe(40);
    });
  });

  describe('local/dev domains', () => {
    it('should reduce score by 10 for localhost', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'localhost' })
      );
      expect(result.score).toBe(20);
      expect(result.factors.some(f => f.includes('Local/dev'))).toBe(true);
    });

    it('should reduce for 127.0.0.1', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: '127.0.0.1' })
      );
      expect(result.score).toBe(20);
    });

    it('should reduce for .local domains', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'myapp.local' })
      );
      expect(result.score).toBe(20);
    });

    it('should not go below 0', () => {
      const result = enhancer.enhance(
        makeAssessment(5),
        makeContext({ currentDomain: 'localhost' })
      );
      expect(result.score).toBe(0);
    });
  });

  describe('unknown domains', () => {
    it('should not modify score for unknown domains', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({ currentDomain: 'example.com' })
      );
      expect(result.score).toBe(30);
    });

    it('should not modify when no domain provided', () => {
      const result = enhancer.enhance(
        makeAssessment(30),
        makeContext({})
      );
      expect(result.score).toBe(30);
    });
  });

  describe('score clamping', () => {
    it('should not exceed 100', () => {
      const result = enhancer.enhance(
        makeAssessment(90),
        makeContext({ currentDomain: 'paypal.com' })
      );
      expect(result.score).toBe(100);
    });
  });
});

describe('getDefaultRules', () => {
  it('should return extension rules when platform is extension', () => {
    const rules = getDefaultRules('extension');

    // Should include shared rules
    const denyRule = rules.find(r => r.type === 'deny' && r.match.riskAbove === 85);
    expect(denyRule).toBeDefined();

    const askRule = rules.find(r => r.type === 'ask' && r.match.riskAbove === 30);
    expect(askRule).toBeDefined();

    // Should include extension-specific rules
    const snapshotRule = rules.find(r => r.match.tool === 'browser_dom' && r.match.pattern?.includes('snapshot'));
    expect(snapshotRule).toBeDefined();
    expect(snapshotRule?.type).toBe('allow');

    // Should NOT include desktop-specific rules
    const terminalRule = rules.find(r => r.match.tool === 'terminal');
    expect(terminalRule).toBeUndefined();
  });

  it('should return desktop rules when platform is desktop', () => {
    const rules = getDefaultRules('desktop');

    // Should include shared rules
    const denyRule = rules.find(r => r.type === 'deny' && r.match.riskAbove === 85);
    expect(denyRule).toBeDefined();

    // Should include desktop-specific rules
    const terminalAllow = rules.find(r => r.match.tool === 'terminal' && r.type === 'allow');
    expect(terminalAllow).toBeDefined();

    const terminalDeny = rules.find(r => r.match.tool === 'terminal' && r.type === 'deny');
    expect(terminalDeny).toBeDefined();

    // Should NOT include extension-specific rules
    const domRule = rules.find(r => r.match.tool === 'browser_dom');
    expect(domRule).toBeUndefined();
  });

  it('should default to extension rules when no platform specified', () => {
    const rules = getDefaultRules();
    const domRule = rules.find(r => r.match.tool === 'browser_dom');
    expect(domRule).toBeDefined();
  });

  it('should always include planning_tool allow rule', () => {
    const extensionRules = getDefaultRules('extension');
    const desktopRules = getDefaultRules('desktop');

    expect(extensionRules.find(r => r.match.tool === 'planning_tool')).toBeDefined();
    expect(desktopRules.find(r => r.match.tool === 'planning_tool')).toBeDefined();
  });

  it('should always include web_search allow rule', () => {
    const rules = getDefaultRules('desktop');
    expect(rules.find(r => r.match.tool === 'web_search')).toBeDefined();
  });
});
