import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resourceFetchHandler } from '@/tools/ResourceFetchTool';
import type { ToolContext } from '@/tools/BaseTool';
import {
  USDC_ADDRESSES,
  type PaymentCapability,
} from '@/core/payments/x402/types';

function fakeResponse(opts: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}) {
  const h = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status: opts.status,
    statusText: `S${opts.status}`,
    ok: opts.status >= 200 && opts.status < 300,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

const requirementHeader = JSON.stringify({
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '50000',
  resource: 'https://api.example.com/data',
  description: '',
  payTo: '0xPayee',
  maxTimeoutSeconds: 60,
  asset: USDC_ADDRESSES.base,
});

function ctx(payments?: PaymentCapability): ToolContext {
  return { sessionId: 's', turnId: 't', toolName: 'resource_fetch', payments };
}

describe('resourceFetchHandler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a non-absolute url', async () => {
    const r = await resourceFetchHandler({ url: 'notaurl' }, ctx());
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes through a non-402 response', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 200, body: 'hello', headers: { 'content-type': 'text/plain' } }),
    );
    const r = await resourceFetchHandler({ url: 'https://x.com/a' }, ctx());
    expect(r.success).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello');
  });

  it('402 without x-payment-required surfaces an error', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 402 }));
    const r = await resourceFetchHandler({ url: 'https://x.com/a' }, ctx());
    expect(r.success).toBe(false);
    expect(r.status).toBe(402);
  });

  it('402 with no capability surfaces the requirement unpaid', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 402, headers: { 'x-payment-required': requirementHeader } }),
    );
    const r = await resourceFetchHandler({ url: 'https://x.com/a' }, ctx());
    expect(r.success).toBe(false);
    expect(r.status).toBe(402);
    expect(r.paymentRequired).toBeTruthy();
  });

  it('402 with a declining (dry-run) capability returns unpaid', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 402, headers: { 'x-payment-required': requirementHeader } }),
    );
    const payments: PaymentCapability = {
      tryPay: async () => ({ paid: false, reason: 'dry-run: would have paid $0.05', dryRun: true }),
    };
    const r = await resourceFetchHandler({ url: 'https://x.com/a' }, ctx(payments));
    expect(r.success).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('402 paid → retries with the x-payment header and returns the resource', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse({ status: 402, headers: { 'x-payment-required': requirementHeader } }),
      )
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: 'PAID-CONTENT' }));
    const payments: PaymentCapability = {
      tryPay: async () => ({
        paid: true,
        paymentHeader: 'BASE64PAYLOAD',
        record: {
          timestamp: Date.now(),
          resource: 'https://x.com/a',
          amount: '50000',
          amountUSD: 0.05,
          token: 'USDC',
          network: 'base',
          payTo: '0xPayee',
          signature: '0xsig',
        },
      }),
    };
    const r = await resourceFetchHandler({ url: 'https://x.com/a' }, ctx(payments));
    expect(r.success).toBe(true);
    expect(r.paid).toBe(true);
    expect(r.body).toBe('PAID-CONTENT');
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['x-payment']).toBe('BASE64PAYLOAD');
  });
});
