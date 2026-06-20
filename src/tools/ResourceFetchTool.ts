/**
 * ResourceFetchTool (Track 23) — the ONLY payable surface.
 *
 * workx has no central fetch chokepoint and its web tools are Chrome/CDP
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
import type { IRiskAssessor, RiskAssessment } from '../core/approval/types';
import { scoreToRiskLevel } from '../core/approval/types';
import { parsePaymentRequirement } from '../core/payments/x402/detect';
import { X402_HEADERS } from '../core/payments/x402/types';

const MAX_BODY_CHARS = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

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

/**
 * SSRF egress guard. This tool introduces a direct Node fetch from the agent
 * process (the Chrome-mediated web tools never did) — on the server that is a
 * server-side-request-forgery surface. Block obvious internal targets by
 * literal host. NOTE: this does NOT resolve DNS, so a hostname that resolves
 * to a private IP (DNS rebinding) is not caught here — that hardening is a
 * Phase-4 follow-up (resolve-then-check / pinned egress).
 */
function blockedHostReason(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return 'unparseable URL';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback host';
  if (!host.includes('.') && !host.includes(':')) return 'non-public bare hostname';
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'internal TLD';
  // IPv6 loopback / unique-local / link-local
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))
    return 'non-public IPv6';
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return 'loopback/private IPv4';
    if (a === 169 && b === 254) return 'link-local / cloud metadata IPv4';
    if (a === 172 && b >= 16 && b <= 31) return 'private IPv4 (172.16/12)';
    if (a === 192 && b === 168) return 'private IPv4 (192.168/16)';
    if (a >= 224) return 'multicast/reserved IPv4';
  }
  return null;
}

async function doFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = body;
    }
    return await fetch(url, init);
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseTextLimited(res: Response): Promise<string> {
  if (!res.body) {
    return (await res.text()).slice(0, MAX_BODY_CHARS);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (text.length < MAX_BODY_CHARS) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_BODY_CHARS) {
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return text.slice(0, MAX_BODY_CHARS);
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
  if (!ALLOWED_METHODS.has(method)) {
    return { success: false, error: `Unsupported method '${method}'` };
  }

  const blocked = blockedHostReason(url);
  if (blocked) {
    return {
      success: false,
      error: `Refusing to fetch '${url}': ${blocked} (SSRF guard — internal/private targets are blocked)`,
    };
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
    const text = await readResponseTextLimited(res);
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

  const retryText = await readResponseTextLimited(retry);
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
  await registry.register(RESOURCE_FETCH_TOOL, resourceFetchHandler, new ResourceFetchRiskAssessor());
}

export class ResourceFetchRiskAssessor implements IRiskAssessor {
  assess(
    _toolName: string,
    parameters: Record<string, unknown>,
  ): RiskAssessment {
    const method = String(parameters.method ?? 'GET').toUpperCase();
    const hasBody = typeof parameters.body === 'string' && parameters.body.length > 0;
    const hasHeaders =
      parameters.headers &&
      typeof parameters.headers === 'object' &&
      Object.keys(parameters.headers).length > 0;

    let score = 10;
    const factors = ['Direct HTTP request'];

    if (MUTATING_METHODS.has(method)) {
      score = 55;
      factors.push(`Mutating HTTP method ${method}`);
    }
    if (hasBody) {
      score = Math.max(score, 55);
      factors.push('Includes request body');
    }
    if (hasHeaders) {
      score = Math.max(score, MUTATING_METHODS.has(method) ? 60 : 25);
      factors.push('Includes custom headers');
    }

    return {
      score,
      level: scoreToRiskLevel(score),
      factors,
      action: score <= 30 ? 'auto_approve' : 'ask_user',
    };
  }
}
