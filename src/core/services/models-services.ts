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

export interface ModelsServiceDeps {
  /**
   * Reserved for future injected dependencies. The connection probe is
   * currently stateless (it only needs the caller-supplied credentials), but a
   * deps object is still required so `registerAllServices` wires the factory.
   */
  enabled?: boolean;
}

interface TestConnectionResult {
  valid: boolean;
  error?: string;
}

/**
 * Strip a trailing operation path so we can derive sibling endpoints. Stored
 * base URLs are inconsistent across providers: OpenAI-compatible ones are the
 * API root (e.g. `https://api.moonshot.ai/v1`), while Anthropic's may be the
 * full `.../v1/messages` endpoint. Normalising to the root lets us address both
 * `/models` and the completion endpoint uniformly.
 */
function rootOf(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|messages)$/i, '');
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

/**
 * Map an HTTP status to a verdict, or `null` when inconclusive (caller may
 * fall back to a completion probe before surfacing an error).
 */
function classify(status: number, ok: boolean): TestConnectionResult | null {
  if (ok) return { valid: true };
  // The request reached the model and authenticated, but our deliberately
  // minimal payload was rejected — the key itself is valid.
  if (status === 400 || status === 422) return { valid: true };
  if (status === 401 || status === 403) return { valid: false, error: 'Invalid API key' };
  return null;
}

export function createModelServices(_deps: ModelsServiceDeps): Record<string, ServiceHandler> {
  return {
    'models.testConnection': async (params): Promise<TestConnectionResult> => {
      const providerId = String(params.providerId ?? '');
      const baseUrl = String(params.baseUrl ?? '');
      const apiKey = String(params.apiKey ?? '');
      const model = String(params.model ?? '');
      const organization = params.organization ? String(params.organization) : null;

      if (!apiKey) return { valid: false, error: 'API key is required' };
      if (!baseUrl) return { valid: false, error: 'Base URL is required' };

      const root = rootOf(baseUrl);
      const headers = authHeaders(providerId, apiKey, organization);

      try {
        // 1) Prompt-free probe: list models. Sufficient for virtually all
        //    OpenAI-compatible providers and Anthropic.
        const listed = await fetch(`${root}/models`, { method: 'GET', headers });
        const listedVerdict = classify(listed.status, listed.ok);
        if (listedVerdict) return listedVerdict;

        // 2) Provider doesn't implement /models (404/405) or returned an
        //    inconclusive status — fall back to a single 1-token completion,
        //    which every chat provider supports, to confirm auth + reachability.
        if (model) {
          const isAnthropic = providerId === 'anthropic';
          const url = isAnthropic ? `${root}/messages` : `${root}/chat/completions`;
          const completed = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
          });
          const completedVerdict = classify(completed.status, completed.ok);
          if (completedVerdict) return completedVerdict;
          return { valid: false, error: `API error: ${completed.status}` };
        }

        return { valid: false, error: `API error: ${listed.status}` };
      } catch (error) {
        return { valid: false, error: error instanceof Error ? error.message : 'Network error' };
      }
    },
  };
}
