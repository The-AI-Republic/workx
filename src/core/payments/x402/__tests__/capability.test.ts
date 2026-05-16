import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPaymentCapability } from '@/core/payments/x402/capability';
import { resetX402SessionPayments } from '@/core/payments/x402/tracker';
import {
  USDC_ADDRESSES,
  type PaymentRequirement,
  type Signer,
} from '@/core/payments/x402/types';

const requirement: PaymentRequirement = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '50000', // $0.05
  resource: 'https://api.example.com/data',
  description: '',
  payTo: '0xPayee',
  maxTimeoutSeconds: 60,
  asset: USDC_ADDRESSES.base,
};

const caps = async () => ({
  network: 'base' as const,
  maxPaymentPerRequestUSD: 0.1,
  maxSessionSpendUSD: 5,
});

const goodSigner: Signer = {
  getAddress: async () => '0xMyWallet',
  signPayment: async () => ({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0xsig',
      authorization: {
        from: '0xMyWallet',
        to: '0xPayee',
        value: '50000',
        validAfter: '0',
        validBefore: '999',
        nonce: '0xnonce',
      },
    },
  }),
};

const throwingSigner: Signer = {
  getAddress: async () => '0xMyWallet',
  signPayment: async () => {
    throw new Error('Phase-4 gated');
  },
};

describe('createPaymentCapability', () => {
  beforeEach(() => resetX402SessionPayments());

  it('denies when disabled', async () => {
    const cap = createPaymentCapability({
      platform: 'desktop',
      isEnabled: async () => false,
      getCaps: caps,
      signer: goodSigner,
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
  });

  it('extension never auto-pays (surface only)', async () => {
    const cap = createPaymentCapability({
      platform: 'extension',
      isEnabled: async () => true,
      getCaps: caps,
      signer: goodSigner,
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
    if (!r.paid) expect(r.reason).toMatch(/never auto-pays/i);
  });

  it('server default-denies with no policy', async () => {
    const cap = createPaymentCapability({
      platform: 'server',
      isEnabled: async () => true,
      getCaps: caps,
      signer: goodSigner,
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
    if (!r.paid) expect(r.reason).toMatch(/default-deny/i);
  });

  it('server denies when policy rejects', async () => {
    const cap = createPaymentCapability({
      platform: 'server',
      isEnabled: async () => true,
      getCaps: caps,
      signer: goodSigner,
      serverPolicy: () => ({ allowed: false, reason: 'not allowlisted' }),
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
  });

  it('server pays when policy allows and signer succeeds', async () => {
    const cap = createPaymentCapability({
      platform: 'server',
      isEnabled: async () => true,
      getCaps: caps,
      signer: goodSigner,
      serverPolicy: () => ({ allowed: true }),
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(true);
    if (r.paid) {
      expect(r.paymentHeader.length).toBeGreaterThan(0);
      expect(r.record.amountUSD).toBeCloseTo(0.05);
    }
  });

  it('desktop above-threshold requires approval; denial blocks payment', async () => {
    const cap = createPaymentCapability({
      platform: 'desktop',
      isEnabled: async () => true,
      getCaps: caps,
      signer: goodSigner,
      requestApproval: async () => 'deny',
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
  });

  it('desktop pays when approved', async () => {
    const approve = vi.fn(async () => 'approve' as const);
    const cap = createPaymentCapability({
      platform: 'desktop',
      isEnabled: async () => true,
      getCaps: caps,
      signer: goodSigner,
      requestApproval: approve,
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(approve).toHaveBeenCalledOnce();
    expect(r.paid).toBe(true);
  });

  it('dry-run validates + (server) allowlists but never signs', async () => {
    const sign = vi.fn();
    const cap = createPaymentCapability({
      platform: 'server',
      isEnabled: async () => true,
      getCaps: caps,
      signer: { getAddress: async () => '0xW', signPayment: sign as never },
      serverPolicy: () => ({ allowed: true }),
      dryRun: true,
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
    if (!r.paid) expect(r.dryRun).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  it('signer failure yields a safe non-payment (no funds moved)', async () => {
    const cap = createPaymentCapability({
      platform: 'server',
      isEnabled: async () => true,
      getCaps: caps,
      signer: throwingSigner,
      serverPolicy: () => ({ allowed: true }),
    });
    const r = await cap.tryPay(requirement, { url: requirement.resource });
    expect(r.paid).toBe(false);
    if (!r.paid) expect(r.reason).toMatch(/Phase-4 gated/);
  });

  it('denies over the per-request cap before any signing', async () => {
    const sign = vi.fn();
    const cap = createPaymentCapability({
      platform: 'server',
      isEnabled: async () => true,
      getCaps: caps,
      signer: { getAddress: async () => '0xW', signPayment: sign as never },
      serverPolicy: () => ({ allowed: true }),
    });
    const r = await cap.tryPay(
      { ...requirement, maxAmountRequired: '500000' }, // $0.50 > $0.10
      { url: requirement.resource },
    );
    expect(r.paid).toBe(false);
    expect(sign).not.toHaveBeenCalled();
  });
});
