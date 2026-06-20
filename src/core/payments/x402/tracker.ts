/**
 * x402 Spend Tracker — Track 18 stand-in.
 *
 * Track 18 (USD cost tracking) does not exist in src/, so x402 carries its
 * own self-contained ledger (ported in spirit from claudy). Unlike claudy
 * (single-process CLI), the workx **server runs concurrent sessions**, so
 * the ledger is keyed by `sessionId` — one session's spend never counts
 * against another's cap and `resetX402SessionPayments(sessionId)` (wired into
 * Session.reset()) clears only that conversation. A future Track 18 can
 * absorb this via `setX402PaymentSink` without signature churn.
 *
 * @module core/payments/x402/tracker
 */

import type { X402PaymentRecord } from './types';

interface Ledger {
  payments: X402PaymentRecord[];
  totalUSD: number;
}

const ledgers = new Map<string, Ledger>();

/** Optional fold-in sink (future Track 18 CostTracker). */
let paymentSink: ((sessionId: string, record: X402PaymentRecord) => void) | undefined;

function ledger(sessionId: string): Ledger {
  let l = ledgers.get(sessionId);
  if (!l) {
    l = { payments: [], totalUSD: 0 };
    ledgers.set(sessionId, l);
  }
  return l;
}

/** Register a fold-in sink. Track 18, when it lands, wires its CostTracker here. */
export function setX402PaymentSink(
  sink: ((sessionId: string, record: X402PaymentRecord) => void) | undefined,
): void {
  paymentSink = sink;
}

/** Record a payment into a session's ledger. */
export function addX402Payment(sessionId: string, record: X402PaymentRecord): void {
  const l = ledger(sessionId);
  l.payments.push(record);
  l.totalUSD += record.amountUSD;
  try {
    paymentSink?.(sessionId, record);
  } catch {
    /* a broken sink must never break payment accounting */
  }
}

/** USD spent via x402 in a given session. */
export function getX402SessionSpentUSD(sessionId: string): number {
  return ledgers.get(sessionId)?.totalUSD ?? 0;
}

/** Payment records for a given session (read-only). */
export function getX402SessionPayments(sessionId: string): readonly X402PaymentRecord[] {
  return ledgers.get(sessionId)?.payments ?? [];
}

/**
 * Payment count for a session, or across all sessions when `sessionId` is
 * omitted (used by the read-only /x402 status surface which has no session
 * handle in the webfront context).
 */
export function getX402PaymentCount(sessionId?: string): number {
  if (sessionId !== undefined) return ledgers.get(sessionId)?.payments.length ?? 0;
  let n = 0;
  for (const l of ledgers.values()) n += l.payments.length;
  return n;
}

/** Reset a session's spend (wired into Session.reset()). */
export function resetX402SessionPayments(sessionId: string): void {
  ledgers.delete(sessionId);
}

/** Test-only: drop every ledger. */
export function _resetAllX402Payments(): void {
  ledgers.clear();
}

/**
 * Plain-text spend summary grouped by resource domain. Session-scoped when
 * `sessionId` is given; otherwise aggregated across all sessions.
 */
export function formatX402Cost(sessionId?: string): string {
  const payments: X402PaymentRecord[] =
    sessionId !== undefined
      ? [...(ledgers.get(sessionId)?.payments ?? [])]
      : [...ledgers.values()].flatMap((l) => l.payments);

  if (payments.length === 0) return '';

  const totalUSD = payments.reduce((s, p) => s + p.amountUSD, 0);
  const lines: string[] = [];
  lines.push(
    `x402 payments: $${totalUSD.toFixed(4)} (${payments.length} ${
      payments.length === 1 ? 'payment' : 'payments'
    })`,
  );

  const byDomain: Record<string, { count: number; totalUSD: number }> = {};
  for (const p of payments) {
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
