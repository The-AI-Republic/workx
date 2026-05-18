import { describe, it, expect } from 'vitest';
import { evaluateServerPolicy } from '@/core/payments/x402/serverPolicy';

const cfg = {
  allowlist: [{ domain: 'api.example.com', maxPerRequestUSD: 0.25 }],
  maxPerDayUSD: 1,
};

describe('evaluateServerPolicy (server default-deny allowlist)', () => {
  it('denies an empty allowlist (default-deny)', () => {
    const r = evaluateServerPolicy(
      { allowlist: [], maxPerDayUSD: 0 },
      0.01,
      'https://api.example.com/x',
      0,
    );
    expect(r.allowed).toBe(false);
  });

  it('allows an exact allowlisted host within caps', () => {
    const r = evaluateServerPolicy(cfg, 0.05, 'https://api.example.com/data', 0);
    expect(r.allowed).toBe(true);
  });

  it('allows a subdomain of an allowlisted domain', () => {
    const r = evaluateServerPolicy(cfg, 0.05, 'https://v2.api.example.com/data', 0);
    expect(r.allowed).toBe(true);
  });

  it('denies a non-allowlisted host', () => {
    const r = evaluateServerPolicy(cfg, 0.05, 'https://evil.com/data', 0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not allowlisted/);
  });

  it('denies a lookalike (suffix without dot boundary)', () => {
    const r = evaluateServerPolicy(cfg, 0.05, 'https://notapi.example.com.attacker.com/x', 0);
    expect(r.allowed).toBe(false);
  });

  it('denies over the per-entry cap', () => {
    const r = evaluateServerPolicy(cfg, 0.5, 'https://api.example.com/data', 0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/exceeds allowlist cap/);
  });

  it('denies over the per-day cap', () => {
    const r = evaluateServerPolicy(cfg, 0.2, 'https://api.example.com/data', 0.9);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/per-day cap/);
  });

  it('ignores the per-day cap when maxPerDayUSD is 0', () => {
    const r = evaluateServerPolicy(
      { allowlist: cfg.allowlist, maxPerDayUSD: 0 },
      0.2,
      'https://api.example.com/data',
      9999,
    );
    expect(r.allowed).toBe(true);
  });

  it('denies an unparseable payee URL', () => {
    const r = evaluateServerPolicy(cfg, 0.05, 'not a url', 0);
    expect(r.allowed).toBe(false);
  });
});
