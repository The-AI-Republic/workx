/**
 * Tests for approval types: scoreToRiskLevel and DEFAULT_APPROVAL_CONFIG
 */

import { describe, it, expect } from 'vitest';
import { RiskLevel, scoreToRiskLevel, DEFAULT_APPROVAL_CONFIG } from '../types';

describe('scoreToRiskLevel', () => {
  describe('boundary values', () => {
    it('should return None for score 0', () => {
      expect(scoreToRiskLevel(0)).toBe(RiskLevel.None);
    });

    it('should return None for score 10', () => {
      expect(scoreToRiskLevel(10)).toBe(RiskLevel.None);
    });

    it('should return Low for score 11', () => {
      expect(scoreToRiskLevel(11)).toBe(RiskLevel.Low);
    });

    it('should return Low for score 30', () => {
      expect(scoreToRiskLevel(30)).toBe(RiskLevel.Low);
    });

    it('should return Medium for score 31', () => {
      expect(scoreToRiskLevel(31)).toBe(RiskLevel.Medium);
    });

    it('should return Medium for score 60', () => {
      expect(scoreToRiskLevel(60)).toBe(RiskLevel.Medium);
    });

    it('should return High for score 61', () => {
      expect(scoreToRiskLevel(61)).toBe(RiskLevel.High);
    });

    it('should return High for score 85', () => {
      expect(scoreToRiskLevel(85)).toBe(RiskLevel.High);
    });

    it('should return Critical for score 86', () => {
      expect(scoreToRiskLevel(86)).toBe(RiskLevel.Critical);
    });

    it('should return Critical for score 100', () => {
      expect(scoreToRiskLevel(100)).toBe(RiskLevel.Critical);
    });
  });

  describe('edge cases (clamping)', () => {
    it('should return None for negative scores', () => {
      expect(scoreToRiskLevel(-10)).toBe(RiskLevel.None);
    });

    it('should return Critical for scores above 100', () => {
      expect(scoreToRiskLevel(150)).toBe(RiskLevel.Critical);
    });

    it('should return None for NaN', () => {
      expect(scoreToRiskLevel(NaN)).toBe(RiskLevel.None);
    });

    it('should return Critical for Infinity', () => {
      expect(scoreToRiskLevel(Infinity)).toBe(RiskLevel.Critical);
    });

    it('should return None for -Infinity', () => {
      expect(scoreToRiskLevel(-Infinity)).toBe(RiskLevel.None);
    });
  });

  describe('mid-range values', () => {
    it('should return None for score 5', () => {
      expect(scoreToRiskLevel(5)).toBe(RiskLevel.None);
    });

    it('should return Low for score 20', () => {
      expect(scoreToRiskLevel(20)).toBe(RiskLevel.Low);
    });

    it('should return Medium for score 45', () => {
      expect(scoreToRiskLevel(45)).toBe(RiskLevel.Medium);
    });

    it('should return High for score 75', () => {
      expect(scoreToRiskLevel(75)).toBe(RiskLevel.High);
    });

    it('should return Critical for score 95', () => {
      expect(scoreToRiskLevel(95)).toBe(RiskLevel.Critical);
    });
  });
});

describe('DEFAULT_APPROVAL_CONFIG', () => {
  it('should have version 1.0.0', () => {
    expect(DEFAULT_APPROVAL_CONFIG.version).toBe('1.0.0');
  });

  it('should default to balanced mode', () => {
    expect(DEFAULT_APPROVAL_CONFIG.mode).toBe('balanced');
  });

  it('should have empty userRules', () => {
    expect(DEFAULT_APPROVAL_CONFIG.userRules).toEqual([]);
  });

  it('should have empty trustedDomains', () => {
    expect(DEFAULT_APPROVAL_CONFIG.trustedDomains).toEqual([]);
  });

  it('should have empty blockedDomains', () => {
    expect(DEFAULT_APPROVAL_CONFIG.blockedDomains).toEqual([]);
  });

  it('should have all timeout values defined', () => {
    expect(DEFAULT_APPROVAL_CONFIG.timeouts).toEqual({
      low: 600000,
      medium: 60000,
      high: 120000,
      critical: 120000,
    });
  });
});
