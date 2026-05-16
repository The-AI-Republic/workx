/**
 * ResourceFetchTool (Track 23) — the ONLY payable surface.
 *
 * browserx has no central fetch chokepoint and its web tools are Chrome/CDP
 * driven (they cannot even observe an HTTP 402). So x402 is NOT a transparent
 * interceptor: this dedicated, agent-initiated tool performs a real Node
 * `fetch` (pattern proven by NavigationTool.checkUrlAccessibility) and is the
 * single place a 402 can be paid. It pays ONLY via the capability injected on
 * ToolContext.payments — browser navigation tools are never given this path,
 * so the agent cannot auto-pay by navigating (design decision 2).
 *
 * @module tools/ResourceFetchTool
 */

import {
  createToolDefinition,
  type ToolDefinition,
  type ToolHandler,
  type ToolContext,
} from './BaseTool';
import type { ToolRegistry } from './ToolRegistry';
import { parsePaymentRequirement } from '../core/payments/x402/detect';
import { X402_HEADERS } from '../core/payments/x402/types';

const MAX_BODY_CHARS = 1_000_000;

export const RESOURCE_FETCH_TOOL: ToolDefinition = createToolDefinition(
  'resource_fetch',
  'Fetch an HTTP(S) resource the agent explicitly needs (an API endpoint, ' +
    'data file, or document). Unlike page navigation this is a direct request ' +
    'whose status/headers are visible. If the server replies HTTP 402 Payment ' +
    'Required (x402 protocol) it MAY be paid automatically — only when x402 is ' +
    'enabled, funded, within configured USD caps, and the platform permits it ' +
    '(human-approved on desktop, allowlisted on server, never on the ' +
    'extension). Otherwise the 402 is returned unpaid for you to handle.',
  {
    url: {
      type: 'string',
      description: 'Absolute http(s) URL of the resource to fetch.',
    },
    method: {
      type: 'string',
      description: 'HTTP method (default GET).',
      enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    },
    headers: {
      type: 'object',
      description: 'Optional request headers as a string map.',
    },
    body: {
      type: 'string',
      description: 'Optional request body (for POST/PUT/PATCH).',
    },
  },
  { required: ['url'], category: 'network', version: '1.0.0' },
);

async function doFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }
  return fetch(url, init);
}

export const resourceFetchHandler: ToolHandler = async (
  parameters,
  context: ToolContext,
) => {
  const url = String(parameters.url ?? '');
  const method = String(parameters.method ?? 'GET').toUpperCase();
  const reqHeaders: Record<string, string> = {
    ...(parameters.headers && typeof parameters.headers === 'object'
      ? (parameters.headers as Record<string, string>)
      : {}),
  };
  const body = typeof parameters.body === 'string' ? parameters.body : undefined;

  if (!/^https?:\/\//i.test(url)) {
    return { success: false, error: `Invalid url '${url}': must be an absolute http(s) URL` };
  }

  let res: Response;
  try {
    res = await doFetch(url, method, reqHeaders, body);
  } catch (err) {
    return {
      success: false,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status !== 402) {
    const text = (await res.text()).slice(0, MAX_BODY_CHARS);
    return {
      success: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') ?? undefined,
      body: text,
    };
  }

  // ── HTTP 402 Payment Required ───────────────────────────────────────────
  const headerValue = res.headers.get(X402_HEADERS.PAYMENT_REQUIRED);
  if (!headerValue) {
    return {
      success: false,
      status: 402,
      error: '402 Payment Required but no x-payment-required header — cannot pay',
    };
  }

  let requirement;
  try {
    requirement = parsePaymentRequirement(headerValue);
  } catch (err) {
    return {
      success: false,
      status: 402,
      error: `402 with malformed x-payment-required: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!context.payments) {
    return {
      success: false,
      status: 402,
      paymentRequired: requirement,
      message:
        'Resource requires payment (x402) but no payment capability is wired ' +
        'on this platform/session — surfacing the 402 unpaid.',
    };
  }

  const result = await context.payments.tryPay(requirement, {
    url,
    sessionId: context.sessionId,
    turnId: context.turnId,
  });

  if (!result.paid) {
    return {
      success: false,
      status: 402,
      paymentRequired: requirement,
      paid: false,
      dryRun: result.dryRun === true,
      message: result.reason,
    };
  }

  // Retry once with the signed payment header.
  let retry: Response;
  try {
    retry = await doFetch(
      url,
      method,
      { ...reqHeaders, [X402_HEADERS.PAYMENT]: result.paymentHeader },
      body,
    );
  } catch (err) {
    return {
      success: false,
      status: 402,
      paid: true,
      error: `Payment authorized but retry failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const retryText = (await retry.text()).slice(0, MAX_BODY_CHARS);
  return {
    success: retry.ok,
    status: retry.status,
    statusText: retry.statusText,
    paid: true,
    amountUSD: result.record.amountUSD,
    network: result.record.network,
    payTo: result.record.payTo,
    contentType: retry.headers.get('content-type') ?? undefined,
    body: retryText,
    paymentRejected: retry.status === 402 || undefined,
  };
};

/**
 * Register the resource-fetch tool on a registry (idempotent). Called from
 * each platform's tool registration so the agent has the tool everywhere; the
 * per-platform payment behavior is governed entirely by the capability wired
 * via ToolRegistry.setPaymentCapability (undefined ⇒ 402s surface unpaid).
 */
export async function registerResourceFetchTool(registry: ToolRegistry): Promise<void> {
  if (registry.getTool('resource_fetch')) return;
  const { StaticRiskAssessor } = await import('../core/approval/assessors/StaticRiskAssessor');
  await registry.register(RESOURCE_FETCH_TOOL, resourceFetchHandler, new StaticRiskAssessor(0));
}
