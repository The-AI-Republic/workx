/**
 * x402 payment capability — the per-platform safety core.
 *
 * Constructed by each platform bootstrap with injected dependencies so this
 * core module never imports server/tools code (no circular deps, no
 * server-only imports leaking into the extension bundle):
 *   - extension → NoopSigner, no serverPolicy, no approval ⇒ NEVER pays
 *                 (surfaces the 402 for the agent/human).
 *   - desktop   → real signer + `requestApproval` adapting ApprovalGate.check;
 *                 above-threshold payments require explicit human approval.
 *   - server    → real signer + `serverPolicy` (allowlist + per-day cap from
 *                 `server.x402`). DEFAULT-DENY: no policy / not allowlisted /
 *                 over cap ⇒ deny. This is an explicit deny, never the
 *                 byproduct of an approval timeout (ApprovalGate is not even
 *                 constructed on the server — see design.md "resolved error").
 *
 * @module core/payments/x402/capability
 */

import {
  addX402Payment,
  getX402SessionSpentUSD,
} from './tracker';
import { validatePaymentRequirement } from './limits';
import type {
  PaymentCapability,
  PaymentContext,
  PaymentNetwork,
  PaymentPlatform,
  PaymentRequirement,
  PaymentResult,
  Signer,
  X402PaymentRecord,
} from './types';
import { tokenAmountToUSD } from './types';

export type AuditFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>,
) => void;

export interface PaymentCapabilityDeps {
  platform: PaymentPlatform;
  /** Gate (Track 22 stand-in). False ⇒ capability never pays. */
  isEnabled: () => Promise<boolean>;
  /** Configured caps + network (ext/desktop: x402 config; server: server.x402). */
  getCaps: () => Promise<{
    network: PaymentNetwork;
    maxPaymentPerRequestUSD: number;
    maxSessionSpendUSD: number;
  }>;
  signer: Signer;
  /**
   * ext/desktop human approval, adapting ApprovalGate.check. Required for
   * above-threshold payments on those platforms; absent ⇒ fail closed.
   */
  requestApproval?: (info: {
    resource: string;
    amountUSD: number;
    payTo: string;
    network: PaymentNetwork;
    ctx: PaymentContext;
  }) => Promise<'approve' | 'deny'>;
  /**
   * Server allowlist + per-day policy (from server.x402). DEFAULT-DENY: if
   * undefined on the server, every payment is denied.
   */
  serverPolicy?: (
    requirement: PaymentRequirement,
    amountUSD: number,
  ) => { allowed: boolean; reason?: string };
  /** Audit sink (server wires emitLog; others console). */
  audit?: AuditFn;
  /** USD above which ext/desktop require explicit approval. */
  approvalThresholdUSD?: number;
  /** Phase-1 / safety: when true, validate + log but never sign. */
  dryRun?: boolean;
}

const DEFAULT_APPROVAL_THRESHOLD_USD = 0.01;

function encodePaymentHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function createPaymentCapability(
  deps: PaymentCapabilityDeps,
): PaymentCapability {
  const audit: AuditFn = deps.audit ?? (() => {});
  const threshold = deps.approvalThresholdUSD ?? DEFAULT_APPROVAL_THRESHOLD_USD;

  async function tryPay(
    requirement: PaymentRequirement,
    ctx: PaymentContext,
  ): Promise<PaymentResult> {
    const base = {
      platform: deps.platform,
      resource: requirement.resource || ctx.url,
      payTo: requirement.payTo,
      network: requirement.network,
      sessionId: ctx.sessionId,
    };

    if (!(await deps.isEnabled())) {
      audit('debug', 'x402 payment skipped: disabled', base);
      return { paid: false, reason: 'x402 payments are not enabled' };
    }

    const caps = await deps.getCaps();
    const check = validatePaymentRequirement({
      requirement,
      sessionSpentUSD: getX402SessionSpentUSD(),
      maxPaymentPerRequestUSD: caps.maxPaymentPerRequestUSD,
      maxSessionSpendUSD: caps.maxSessionSpendUSD,
      configuredNetwork: caps.network,
    });
    if (!check.valid) {
      audit('warn', `x402 payment denied: ${check.reason}`, base);
      return { paid: false, reason: check.reason };
    }
    const amountUSD = check.amountUSD;

    // ── Platform safety branch ──────────────────────────────────────────
    if (deps.platform === 'extension') {
      audit('info', 'x402 402 surfaced (extension never auto-pays)', {
        ...base,
        amountUSD,
      });
      return {
        paid: false,
        reason:
          'Extension never auto-pays — the 402 is surfaced for explicit human ' +
          'approval (or delegate signing to a paired desktop/server host)',
      };
    }

    if (deps.platform === 'server') {
      if (!deps.serverPolicy) {
        audit('warn', 'x402 server payment denied: no managed policy (default-deny)', {
          ...base,
          amountUSD,
        });
        return {
          paid: false,
          reason:
            'Server default-deny: no server.x402 allowlist policy is configured',
        };
      }
      const decision = deps.serverPolicy(requirement, amountUSD);
      if (!decision.allowed) {
        audit('warn', `x402 server payment denied: ${decision.reason ?? 'not allowlisted'}`, {
          ...base,
          amountUSD,
        });
        return {
          paid: false,
          reason: decision.reason ?? 'Server policy did not allowlist this payee/amount',
        };
      }
    }

    if (deps.platform === 'desktop' && amountUSD > threshold) {
      if (!deps.requestApproval) {
        audit('warn', 'x402 payment denied: above threshold and no approval surface', {
          ...base,
          amountUSD,
        });
        return { paid: false, reason: 'Above auto-pay threshold and no approval surface available' };
      }
      const decision = await deps.requestApproval({
        resource: base.resource,
        amountUSD,
        payTo: requirement.payTo,
        network: requirement.network,
        ctx,
      });
      if (decision !== 'approve') {
        audit('info', 'x402 payment denied by user', { ...base, amountUSD });
        return { paid: false, reason: 'Payment denied by user' };
      }
    }

    // ── Dry-run: validated + (server) allowlisted + (desktop) approved, but
    //    we deliberately do not sign. Phase-1 semantics / extra safety. ───
    if (deps.dryRun) {
      audit('info', `x402 dry-run: would have paid $${amountUSD.toFixed(4)}`, {
        ...base,
        amountUSD,
      });
      return {
        paid: false,
        dryRun: true,
        reason: `dry-run: would have paid $${amountUSD.toFixed(4)} to ${requirement.payTo}`,
      };
    }

    // ── Sign + settle ───────────────────────────────────────────────────
    try {
      const fromAddress = await deps.signer.getAddress();
      if (!fromAddress) {
        audit('warn', 'x402 payment denied: no wallet key', { ...base, amountUSD });
        return { paid: false, reason: 'No wallet key available to sign the payment' };
      }
      const payload = await deps.signer.signPayment(requirement, fromAddress);
      const paymentHeader = encodePaymentHeader(payload);

      const record: X402PaymentRecord = {
        timestamp: Date.now(),
        resource: base.resource,
        amount: requirement.maxAmountRequired,
        amountUSD: tokenAmountToUSD(requirement.maxAmountRequired),
        token: requirement.extra?.name ?? 'USDC',
        network: requirement.network,
        payTo: requirement.payTo,
        signature: payload.payload.signature,
      };
      addX402Payment(record);
      audit('info', `x402 payment authorized: $${record.amountUSD.toFixed(4)}`, {
        ...base,
        amountUSD: record.amountUSD,
      });
      return { paid: true, paymentHeader, record };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit('warn', `x402 signing failed (no funds moved): ${reason}`, { ...base, amountUSD });
      return { paid: false, reason };
    }
  }

  return { tryPay };
}
