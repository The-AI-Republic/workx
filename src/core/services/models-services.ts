/**
 * Model Service Handlers
 *
 * Platform-agnostic `models.*` service handlers. Auto-registered on extension,
 * desktop, and server by `registerAllServices`.
 *
 * `models.testConnection` validates a BYOK provider's API key + base URL by
 * making a REAL request from the runtime (desktop sidecar / extension service
 * worker / server) — never the webview. Third-party LLM APIs are server-to-
 * server endpoints: they reject browser-origin requests via CORS (and the Tauri
 * webview cannot reach them at all), so the old in-webview probe always failed
 * for desktop. Routing the probe through the runtime sidesteps CORS entirely.
 *
 * The probe is prompt-free where possible: it lists models (`GET {root}/models`)
 * and only falls back to a single 1-token completion when a provider does not
 * implement the models endpoint.
 *
 * @module core/services/models-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { IProviderConfig } from '@/config/types';

export interface ModelsServiceDeps {
  /**
   * Reserved for future injected dependencies. The connection probe is
   * currently stateless (it only needs the caller-supplied credentials), but a
   * deps object is still required so `registerAllServices` wires the factory.
   */
  enabled?: boolean;
  /** Optional platform-owned provider/model catalog for a separate UI process. */
  getCatalog?: () => Promise<Record<string, IProviderConfig>>;
}

export interface TestConnectionResult {
  valid: boolean;
  error?: string;
}

interface TestConnectionParams {
  providerId?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  organization?: unknown;
  apiFormat?: unknown;
  isCustom?: unknown;
}

const TEST_CONNECTION_TIMEOUT_MS = 30_000;
const TRAILING_OPERATION_PATH = /\/(chat\/completions|completions|messages|responses|models)$/i;

/**
 * Strip a trailing operation path so we can derive sibling endpoints. Stored
 * base URLs are inconsistent across providers: OpenAI-compatible ones are the
 * API root (e.g. `https://api.moonshot.ai/v1`), while Anthropic's may be the
 * full `.../v1/messages` endpoint. Normalising to the root lets us address both
 * `/models` and the completion endpoint uniformly.
 */
function rootOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(TRAILING_OPERATION_PATH, '') || '/';
  return url.toString();
}

function authHeaders(
  providerId: string,
  apiKey: string,
  organization: string | null,
): Record<string, string> {
  if (providerId === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (organization) headers['OpenAI-Organization'] = organization;
  return headers;
}

function joinUrl(root: string, path: string): string {
  const url = new URL(root);
  const rootPath = url.pathname.replace(/\/+$/, '');
  const childPath = path.replace(/^\/+/, '');
  url.pathname = `${rootPath}/${childPath}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

function ensureVersion(root: string, version: string): string {
  const url = new URL(root);
  return new RegExp(`/${version}$`, 'i').test(url.pathname.replace(/\/+$/, ''))
    ? url.toString()
    : joinUrl(url.toString(), version);
}

function googleRootOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1beta\/openai$/i, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '') || '/';
  return url.toString();
}

function withApiKey(url: string, apiKey: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('key', apiKey);
  return parsed.toString();
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && error.name === 'AbortError';
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function invalidApiKeyMessage(status: number, body: string): string | null {
  if (status === 401 || status === 403) return 'Invalid API key';
  if (status !== 400) return null;

  const text = body.toLowerCase();
  if (
    text.includes('invalid_api_key') ||
    text.includes('api key not valid') ||
    text.includes('invalid api key') ||
    text.includes('invalid authentication') ||
    text.includes('authentication failed')
  ) {
    return 'Invalid API key';
  }
  return null;
}

/**
 * Map an HTTP status to a verdict, or `null` when inconclusive (caller may
 * fall back to a completion probe before surfacing an error).
 */
async function classify(
  response: Response,
  opts: { allowBadRequestAsValid?: boolean } = {},
): Promise<TestConnectionResult | null> {
  if (response.ok) return { valid: true };
  const body = await responseText(response);
  const authError = invalidApiKeyMessage(response.status, body);
  if (authError) return { valid: false, error: authError };
  // The request reached the model and authenticated, but our deliberately
  // minimal payload was rejected — the key itself is valid.
  if (opts.allowBadRequestAsValid && (response.status === 400 || response.status === 422)) {
    return { valid: true };
  }
  return null;
}

function usesResponsesProbe(providerId: string, apiFormat: string, isCustom: boolean): boolean {
  if (isCustom) return apiFormat === 'responses';
  return providerId === 'openai' || providerId === 'xai' || providerId === 'groq';
}

async function testGoogleConnection(root: string, apiKey: string, model: string): Promise<TestConnectionResult> {
  const versionRoot = joinUrl(googleRootOf(root), 'v1beta');
  const listed = await fetchWithTimeout(withApiKey(joinUrl(versionRoot, 'models'), apiKey), { method: 'GET' });
  const listedVerdict = await classify(listed);
  if (listedVerdict) return listedVerdict;

  if (!model) return { valid: false, error: `API error: ${listed.status}` };

  const completed = await fetchWithTimeout(
    withApiKey(joinUrl(versionRoot, `models/${encodeURIComponent(model)}:generateContent`), apiKey),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    },
  );
  const completedVerdict = await classify(completed, { allowBadRequestAsValid: true });
  if (completedVerdict) return completedVerdict;
  return { valid: false, error: `API error: ${completed.status}` };
}

async function testAnthropicConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<TestConnectionResult> {
  const root = ensureVersion(rootOf(baseUrl), 'v1');
  const headers = authHeaders('anthropic', apiKey, null);

  const listed = await fetchWithTimeout(joinUrl(root, 'models'), { method: 'GET', headers });
  const listedVerdict = await classify(listed);
  if (listedVerdict) return listedVerdict;

  if (!model) return { valid: false, error: `API error: ${listed.status}` };

  const completed = await fetchWithTimeout(joinUrl(root, 'messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const completedVerdict = await classify(completed, { allowBadRequestAsValid: true });
  if (completedVerdict) return completedVerdict;
  return { valid: false, error: `API error: ${completed.status}` };
}

export async function testModelConnection(params: TestConnectionParams = {}): Promise<TestConnectionResult> {
  const providerId = String(params.providerId ?? '');
  const baseUrl = String(params.baseUrl ?? '');
  const apiKey = String(params.apiKey ?? '');
  const model = String(params.model ?? '');
  const organization = params.organization ? String(params.organization) : null;
  const apiFormat = String(params.apiFormat ?? '');
  const isCustom = params.isCustom === true;

  if (!apiKey) return { valid: false, error: 'API key is required' };
  if (!baseUrl) return { valid: false, error: 'Base URL is required' };

  try {
    if (providerId === 'google-ai-studio') {
      return await testGoogleConnection(baseUrl, apiKey, model);
    }
    if (providerId === 'anthropic') {
      return await testAnthropicConnection(baseUrl, apiKey, model);
    }

    const root = rootOf(baseUrl);
    const headers = authHeaders(providerId, apiKey, organization);

    // 1) Prompt-free probe: list models. Sufficient for virtually all
    //    OpenAI-compatible providers.
    const listed = await fetchWithTimeout(joinUrl(root, 'models'), { method: 'GET', headers });
    const listedVerdict = await classify(listed);
    if (listedVerdict) return listedVerdict;

    // 2) Provider doesn't implement /models (404/405) or returned an
    //    inconclusive status — fall back to a single 1-token completion,
    //    matching the provider wire API where possible.
    if (model) {
      const useResponses = usesResponsesProbe(providerId, apiFormat, isCustom);
      const completed = await fetchWithTimeout(joinUrl(root, useResponses ? 'responses' : 'chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(useResponses
          ? { model, input: 'ping', max_output_tokens: 1 }
          : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      const completedVerdict = await classify(completed, { allowBadRequestAsValid: true });
      if (completedVerdict) return completedVerdict;
      return { valid: false, error: `API error: ${completed.status}` };
    }

    return { valid: false, error: `API error: ${listed.status}` };
  } catch (error) {
    if (isAbortError(error)) return { valid: false, error: 'Connection test timed out after 30 seconds' };
    return { valid: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}

export function createModelServices(deps: ModelsServiceDeps): Record<string, ServiceHandler> {
  const services: Record<string, ServiceHandler> = {
    'models.testConnection': async (params): Promise<TestConnectionResult> => testModelConnection(params ?? {}),
  };
  const { getCatalog } = deps;
  if (getCatalog) {
    services['models.getCatalog'] = async () => getCatalog();
  }
  return services;
}
