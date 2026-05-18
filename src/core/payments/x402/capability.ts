/**
 * x402 payment capability — the per-platform safety core.
 *
 * Constructed by each platform bootstrap with injected dependencies so this
 * core module never imports server/tools code:
 *   - extension → NoopSigner, no serverPolicy, no approval ⇒ NEVER pays
 *                 (surfaces the 402 for the agent/human).
 *   - desktop   → real signer + `requestApproval` adapting ApprovalGate.check;
 *                 above-threshold payments require explicit human approval.
 *   - server    → real signer + `serverPolicy` (the pure evaluateServerPolicy
 *                 bound to server.x402). DEFAULT-DENY; an explicit deny, never
 *                 the byproduct of an approval timeout (ApprovalGate is not
 *                 even constructed on the server).
 *
 * @module core/payments/x402/capability
 */

import { addX402Payment, getX402SessionSpentUSD } from './tracker';
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
  isEnabled: () => Promise<boolean>;
  getCaps: () => Promise<{
    network: PaymentNetwork;
    maxPaymentPerRequestUSD: number;
    maxSessionSpendUSD: number;
  }>;
  signer: Signer;
  requestApproval?: (info: {
    resource: string;
    amountUSD: number;
    payTo: string;
    network: PaymentNetwork;
    ctx: PaymentContext;
  }) => Promise<'approve' | 'deny'>;
  /**
   * Server allowlist + per-day policy (bind evaluateServerPolicy here).
   * DEFAULT-DENY: if undefined on the server every payment is denied.
   * `resourceUrl` is always the URL that actually returned HTTP 402. Never
   * trust the server-supplied requirement.resource for allowlist decisions.
   */
  serverPolicy?: (
    amountUSD: number,
    resourceUrl: string,
    sessionSpentUSD: number,
  ) => { allowed: boolean; reason?: string };
  audit?: AuditFn;
  /**
   * Desktop approval threshold. Default 0 means every positive payment needs
   * explicit approval; callers may raise it only after Phase-4 policy review.
   */
  approvalThresholdUSD?: number;
  /** Phase-1 / safety: when true, validate + log but never sign. */
  dryRun?: boolean;
}

const DEFAULT_APPROVAL_THRESHOLD_USD = 0;

/** Portable base64 (Node Buffer when present, else btoa). */
function toBase64(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s).toString('base64');
  return btoa(unescape(encodeURIComponent(s)));
}

function encodePaymentHeader(payload: unknown): string {
  return toBase64(JSON.stringify(payload));
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
    const sessKey = ctx.sessionId ?? 'default';
    const fetchedUrl = ctx.url;
    const displayResourceUrl = requirement.resource || ctx.url;
    const base = {
      platform: deps.platform,
      resource: fetchedUrl,
      claimedResource: requirement.resource || undefined,
      payTo: requirement.payTo,
      network: requirement.network,
      sessionId: ctx.sessionId,
    };

    if (!(await deps.isEnabled())) {
      audit('debug', 'x402 payment skipped: disabled', base);
      return { paid: false, reason: 'x402 payments are not enabled' };
    }

    const caps = await deps.getCaps();
    const sessionSpentUSD = getX402SessionSpentUSD(sessKey);
    const check = validatePaymentRequirement({
      requirement,
      sessionSpentUSD,
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
          reason: 'Server default-deny: no server.x402 allowlist policy is configured',
        };
      }
      const decision = deps.serverPolicy(amountUSD, fetchedUrl, sessionSpentUSD);
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
        resource: fetchedUrl,
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
      const signedValue = payload.payload.authorization.value;
      if (signedValue !== requirement.maxAmountRequired) {
        audit('warn', 'x402 payment denied: signed amount does not match requirement', {
          ...base,
          amountUSD,
          requiredAmount: requirement.maxAmountRequired,
          signedAmount: signedValue,
        });
        return {
          paid: false,
          reason: 'Signed payment amount did not match the x402 requirement',
        };
      }
      const paymentHeader = encodePaymentHeader(payload);
      const signedAmountUSD = tokenAmountToUSD(signedValue);

      const record: X402PaymentRecord = {
        timestamp: Date.now(),
        resource: displayResourceUrl,
        amount: signedValue,
        amountUSD: signedAmountUSD,
        token: requirement.extra?.name ?? 'USDC',
        network: requirement.network,
        payTo: requirement.payTo,
        signature: payload.payload.signature,
      };
      addX402Payment(sessKey, record);
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
