/**
 * x402 Session Spend Tracker — Track 18 stand-in.
 *
 * Track 18 (USD cost tracking) does not exist in src/, so x402 carries its
 * own self-contained, in-memory, session-scoped ledger (ported from claudy's
 * `services/x402/tracker.ts`). `resetX402SessionPayments()` is wired into
 * Session.reset() so a new conversation starts at $0. A future Track 18 can
 * absorb this via the documented `setX402PaymentSink` fold-in hook without
 * changing any signature.
 *
 * @module core/payments/x402/tracker
 */

import type { X402PaymentRecord } from './types';

let sessionPayments: X402PaymentRecord[] = [];
let sessionTotalUSD = 0;

/** Optional fold-in sink (future Track 18 CostTracker). */
let paymentSink: ((record: X402PaymentRecord) => void) | undefined;

/** Register a fold-in sink. Track 18, when it lands, wires its CostTracker here. */
export function setX402PaymentSink(
  sink: ((record: X402PaymentRecord) => void) | undefined,
): void {
  paymentSink = sink;
}

/** Record a payment into the session ledger. */
export function addX402Payment(record: X402PaymentRecord): void {
  sessionPayments.push(record);
  sessionTotalUSD += record.amountUSD;
  try {
    paymentSink?.(record);
  } catch {
    /* a broken sink must never break payment accounting */
  }
}

/** Total USD spent via x402 this session. */
export function getX402SessionSpentUSD(): number {
  return sessionTotalUSD;
}

/** All payment records this session (read-only). */
export function getX402SessionPayments(): readonly X402PaymentRecord[] {
  return sessionPayments;
}

/** Number of payments this session. */
export function getX402PaymentCount(): number {
  return sessionPayments.length;
}

/** Reset session spend (wired into Session.reset()). */
export function resetX402SessionPayments(): void {
  sessionPayments = [];
  sessionTotalUSD = 0;
}

/** Plain-text spend summary grouped by resource domain (for /x402 status). */
export function formatX402Cost(): string {
  if (sessionPayments.length === 0) return '';

  const lines: string[] = [];
  lines.push(
    `x402 payments: $${sessionTotalUSD.toFixed(4)} (${sessionPayments.length} ${
      sessionPayments.length === 1 ? 'payment' : 'payments'
    })`,
  );

  const byDomain: Record<string, { count: number; totalUSD: number }> = {};
  for (const p of sessionPayments) {
    let domain: string;
    try {
      domain = new URL(p.resource).hostname;
    } catch {
      continue;
    }
    byDomain[domain] ??= { count: 0, totalUSD: 0 };
    byDomain[domain].count += 1;
    byDomain[domain].totalUSD += p.amountUSD;
  }

  for (const [domain, s] of Object.entries(byDomain)) {
    lines.push(
      `  ${domain}: ${s.count} ${s.count === 1 ? 'request' : 'requests'} ($${s.totalUSD.toFixed(4)})`,
    );
  }

  return lines.join('\n');
}
