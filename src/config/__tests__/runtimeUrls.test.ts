import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRuntimeUrls } from '../runtimeUrls';

const ENV_KEYS = [
  'WORKX_GATEWAY_BASE_URL',
  'WORKX_GATEWAY_LLM_API_URL',
  'WORKX_GATEWAY_MCP_URL',
  'WORKX_GATEWAY_CATALOG_URL',
  'WORKX_GATEWAY_MCP_API_KEY',
] as const;
const originalEnv = new Map<string, string | undefined>();

describe('resolveRuntimeUrls', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it('contains no hosted account endpoints by default', () => {
    const urls = resolveRuntimeUrls();
    expect(urls).not.toHaveProperty('homePageBaseUrl');
    expect(urls).not.toHaveProperty('backendApiBaseUrl');
    expect(urls).not.toHaveProperty('deeplinkRedirectUrl');
    expect(urls.gatewayMcpAuthMode).toBe('none');
  });

  it('derives API-key gateway endpoints from a base URL', () => {
    process.env.WORKX_GATEWAY_BASE_URL = 'https://gateway.example.com/api';
    process.env.WORKX_GATEWAY_CATALOG_URL = 'https://hub.example.com/apps';
    process.env.WORKX_GATEWAY_MCP_API_KEY = 'gw-key';
    const urls = resolveRuntimeUrls();
    expect(urls.gatewayLlmApiUrl).toBe('https://gateway.example.com/api/v1');
    expect(urls.gatewayMcpUrl).toBe('https://gateway.example.com/api/mcp');
    expect(urls.gatewayCatalogApiBaseUrl).toBe('https://hub.example.com/api/v1/apps');
    expect(urls.gatewayMcpAuthMode).toBe('api-key');
  });
});
