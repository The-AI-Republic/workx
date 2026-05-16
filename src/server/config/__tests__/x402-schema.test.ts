import { describe, it, expect } from 'vitest';
import { ServerConfigSchema } from '@/server/config/server-config';

describe('server.x402 config schema (Track 23 / Track 20 stand-in)', () => {
  it('defaults to a safe disabled, empty-allowlist (default-deny) policy', () => {
    const cfg = ServerConfigSchema.parse({});
    expect(cfg.server.x402.enabled).toBe(false);
    expect(cfg.server.x402.allowlist).toEqual([]);
    expect(cfg.server.x402.network).toBe('base');
    expect(cfg.server.x402.maxPerDayUSD).toBe(0);
  });

  it('parses an explicit allowlist + caps', () => {
    const cfg = ServerConfigSchema.parse({
      server: {
        x402: {
          enabled: true,
          network: 'base-sepolia',
          allowlist: [{ domain: 'api.example.com', maxPerRequestUSD: 0.25 }],
          maxPerDayUSD: 10,
          maxSessionSpendUSD: 2,
        },
      },
    });
    expect(cfg.server.x402.enabled).toBe(true);
    expect(cfg.server.x402.network).toBe('base-sepolia');
    expect(cfg.server.x402.allowlist[0].domain).toBe('api.example.com');
    expect(cfg.server.x402.allowlist[0].maxPerRequestUSD).toBe(0.25);
  });

  it('rejects a negative per-request cap', () => {
    expect(() =>
      ServerConfigSchema.parse({
        server: { x402: { allowlist: [{ domain: 'a.com', maxPerRequestUSD: -1 }] } },
      }),
    ).toThrow();
  });
});
