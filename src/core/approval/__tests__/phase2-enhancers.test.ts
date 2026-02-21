/**
 * Unit tests for Phase 2 enhancers:
 * - SemanticElementEnhancer
 * - SensitivePathEnhancer
 */

import { describe, it, expect } from 'vitest';
import { SemanticElementEnhancer } from '../enhancers/SemanticElementEnhancer';
import { SensitivePathEnhancer } from '../enhancers/SensitivePathEnhancer';
import { scoreToRiskLevel } from '../types';
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

// ============================================================================
// SemanticElementEnhancer
// ============================================================================

describe('SemanticElementEnhancer', () => {
  const enhancer = new SemanticElementEnhancer();

  describe('activation conditions', () => {
    it('should only activate for click actions', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', aria_label: 'Delete' } })
      );
      expect(result.score).toBe(65); // 25 + 40
    });

    it('should only activate for keypress actions', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'keypress', text: 'Submit' } })
      );
      expect(result.score).toBe(55); // 25 + 30
    });

    it('should not activate for snapshot action', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'snapshot', aria_label: 'Delete' } })
      );
      expect(result.score).toBe(25); // unchanged
    });

    it('should not activate for type action', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'type', text: 'Buy now' } })
      );
      expect(result.score).toBe(25); // unchanged
    });
  });

  describe('financial patterns (+50)', () => {
    it('should detect "buy" in element text', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Buy Now' } })
      );
      expect(result.score).toBe(75);
      expect(result.factors.some(f => f.includes('financial'))).toBe(true);
    });

    it('should detect "purchase"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', aria_label: 'Complete Purchase' } })
      );
      expect(result.score).toBe(75);
    });

    it('should detect "checkout"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Proceed to Checkout' } })
      );
      expect(result.score).toBe(75);
    });

    it('should detect "subscribe"', () => {
      const result = enhancer.enhance(
        makeAssessment(20),
        makeContext({ parameters: { action: 'click', aria_label: 'Subscribe Now' } })
      );
      expect(result.score).toBe(70);
    });
  });

  describe('data modification patterns (+40)', () => {
    it('should detect "delete"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Delete Account' } })
      );
      expect(result.score).toBe(65);
      expect(result.factors.some(f => f.includes('data_modification'))).toBe(true);
    });

    it('should detect "remove"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', aria_label: 'Remove Item' } })
      );
      expect(result.score).toBe(65);
    });

    it('should detect "close account"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Close Account' } })
      );
      expect(result.score).toBe(65);
    });
  });

  describe('form submission patterns (+30)', () => {
    it('should detect "submit"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', aria_label: 'Submit Form' } })
      );
      expect(result.score).toBe(55);
      expect(result.factors.some(f => f.includes('form_submission'))).toBe(true);
    });

    it('should detect "confirm"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Confirm Changes' } })
      );
      expect(result.score).toBe(55);
    });

    it('should detect "save"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Save Settings' } })
      );
      expect(result.score).toBe(55);
    });
  });

  describe('communication patterns (+25)', () => {
    it('should detect "send"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Send Message' } })
      );
      expect(result.score).toBe(50);
      expect(result.factors.some(f => f.includes('communication'))).toBe(true);
    });

    it('should detect "post"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', aria_label: 'Post Update' } })
      );
      expect(result.score).toBe(50);
    });

    it('should detect "publish"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Publish Article' } })
      );
      expect(result.score).toBe(50);
    });
  });

  describe('authentication patterns (+20)', () => {
    it('should detect "log in"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Log In' } })
      );
      expect(result.score).toBe(45);
      expect(result.factors.some(f => f.includes('authentication'))).toBe(true);
    });

    it('should detect "sign up"', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', aria_label: 'Sign Up' } })
      );
      expect(result.score).toBe(45);
    });
  });

  describe('score behavior', () => {
    it('should clamp score at 100', () => {
      const result = enhancer.enhance(
        makeAssessment(80),
        makeContext({ parameters: { action: 'click', text: 'Buy Now' } })
      );
      expect(result.score).toBe(100);
    });

    it('should use highest matching pattern', () => {
      // "buy" is financial (+50), which should win over "confirm" (+30)
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Confirm Buy' } })
      );
      expect(result.score).toBe(75); // 25 + 50 (financial wins)
    });

    it('should not modify score for non-matching text', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click', text: 'Next Page' } })
      );
      expect(result.score).toBe(25);
    });

    it('should not modify score when no element text', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ parameters: { action: 'click' } })
      );
      expect(result.score).toBe(25);
    });
  });
});

// ============================================================================
// SensitivePathEnhancer
// ============================================================================

describe('SensitivePathEnhancer', () => {
  const enhancer = new SensitivePathEnhancer();

  describe('activation conditions', () => {
    it('should only activate for terminal tool', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/passwd' } })
      );
      expect(result.score).toBe(65); // 25 + 40
    });

    it('should not activate for dom_tool', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'dom_tool', parameters: { command: 'cat /etc/passwd' } })
      );
      expect(result.score).toBe(25); // unchanged
    });

    it('should not activate when no command parameter', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: {} })
      );
      expect(result.score).toBe(25); // unchanged
    });
  });

  describe('system directory patterns (+40)', () => {
    it('should detect /etc/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/passwd' } })
      );
      expect(result.score).toBe(65);
      expect(result.factors.some(f => f.includes('system_directory'))).toBe(true);
    });

    it('should detect /usr/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'ls /usr/bin/' } })
      );
      expect(result.score).toBe(65);
    });

    it('should detect /sys/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /sys/class/thermal/thermal_zone0/temp' } })
      );
      expect(result.score).toBe(65);
    });

    it('should detect /boot/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'ls /boot/' } })
      );
      expect(result.score).toBe(65);
    });
  });

  describe('sensitive file patterns (+30)', () => {
    it('should detect .env files', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat .env' } })
      );
      expect(result.score).toBe(55);
      expect(result.factors.some(f => f.includes('sensitive_file'))).toBe(true);
    });

    it('should detect .pem files', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat server.pem' } })
      );
      expect(result.score).toBe(55);
    });

    it('should detect .key files', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat private.key' } })
      );
      expect(result.score).toBe(55);
    });
  });

  describe('config directory patterns (+30)', () => {
    it('should detect /.ssh/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat ~/.ssh/id_rsa' } })
      );
      expect(result.score).toBe(55);
      expect(result.factors.some(f => f.includes('config_directory'))).toBe(true);
    });

    it('should detect /.aws/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat ~/.aws/credentials' } })
      );
      expect(result.score).toBe(55);
    });

    it('should detect /.gnupg/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'ls ~/.gnupg/' } })
      );
      expect(result.score).toBe(55);
    });
  });

  describe('project internal patterns (+5)', () => {
    it('should detect /node_modules/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'ls /node_modules/.package-lock.json' } })
      );
      expect(result.score).toBe(30);
      expect(result.factors.some(f => f.includes('project_internal'))).toBe(true);
    });

    it('should detect /.git/ paths', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /.git/config' } })
      );
      expect(result.score).toBe(30);
    });
  });

  describe('score behavior', () => {
    it('should use highest matching pattern', () => {
      // /etc/ is system_directory (+40) which wins over .env (+30)
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'cat /etc/.env' } })
      );
      expect(result.score).toBe(65); // 25 + 40
    });

    it('should clamp score at 100', () => {
      const result = enhancer.enhance(
        makeAssessment(80),
        makeContext({ toolName: 'terminal', parameters: { command: 'rm -rf /etc/passwd' } })
      );
      expect(result.score).toBe(100);
    });

    it('should not modify score for safe commands', () => {
      const result = enhancer.enhance(
        makeAssessment(25),
        makeContext({ toolName: 'terminal', parameters: { command: 'ls -la ~/projects' } })
      );
      expect(result.score).toBe(25);
    });
  });
});
