import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRuntimeUrls } from '../runtimeUrls';

const ENV_KEYS = [
  'WORKX_AUTH_BASE_URL',
  'WORKX_HOME_PAGE_BASE_URL',
  'WORKX_BACKEND_API_BASE_URL',
  'WORKX_GATEWAY_BASE_URL',
  'WORKX_GATEWAY_API_BASE_URL',
  'WORKX_GATEWAY_LLM_API_URL',
  'WORKX_GATEWAY_PROVIDER_SLUG',
  'WORKX_GATEWAY_MCP_URL',
  'WORKX_GATEWAY_CATALOG_URL',
  'WORKX_GATEWAY_MCP_NAME',
  'WORKX_GATEWAY_MCP_AUTH_MODE',
  'WORKX_GATEWAY_MCP_API_KEY',
  'WORKX_GATEWAY_MCP_TOOL_DISCOVERY_HEADER',
  'WORKX_GATEWAY_MCP_TOOL_DISCOVERY',
  'WORKX_LLM_ROUTING_MODE',
  'VITE_AUTH_BASE_URL',
  'VITE_HOME_PAGE_BASE_URL',
  'VITE_BACKEND_API_BASE_URL',
  'VITE_GATEWAY_BASE_URL',
  'VITE_GATEWAY_API_BASE_URL',
  'VITE_GATEWAY_LLM_API_URL',
  'VITE_GATEWAY_PROVIDER_SLUG',
  'VITE_GATEWAY_MCP_URL',
  'VITE_GATEWAY_CATALOG_URL',
  'VITE_GATEWAY_MCP_NAME',
  'VITE_GATEWAY_MCP_AUTH_MODE',
  'VITE_GATEWAY_MCP_TOOL_DISCOVERY_HEADER',
  'VITE_GATEWAY_MCP_TOOL_DISCOVERY',
  'VITE_LLM_ROUTING_MODE',
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
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
  });

  it('leaves hosted auth unconfigured when no runtime env is set', () => {
    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      homePageBaseUrl: null,
      backendApiBaseUrl: null,
      llmApiUrl: '/api/llm',
      gatewayBaseUrl: null,
      gatewayLlmApiUrl: null,
      gatewayProviderSlug: null,
      gatewayMcpUrl: null,
      gatewayCatalogUrl: null,
      gatewayMcpName: 'gateway',
      gatewayMcpAuthMode: 'none',
      gatewayMcpApiKey: null,
      gatewayMcpToolDiscoveryHeader: null,
      gatewayMcpToolDiscovery: null,
      llmRoutingMode: 'legacy',
      deeplinkRedirectUrl: 'workx://auth/callback',
      source: {
        homePageBaseUrl: 'default',
        backendApiBaseUrl: 'default',
        llmApiUrl: 'default',
        gatewayBaseUrl: 'default',
        gatewayLlmApiUrl: 'default',
        gatewayProviderSlug: 'default',
        gatewayMcpUrl: 'default',
        gatewayCatalogUrl: 'default',
        gatewayMcpName: 'default',
        gatewayMcpAuthMode: 'default',
        gatewayMcpApiKey: 'default',
        gatewayMcpToolDiscoveryHeader: 'default',
        gatewayMcpToolDiscovery: 'default',
        llmRoutingMode: 'default',
        deeplinkRedirectUrl: 'default',
      },
    });
  });

  it('prefers WORKX auth env values over VITE env values', () => {
    process.env.WORKX_AUTH_BASE_URL = 'https://auth.example.com';
    process.env.VITE_HOME_PAGE_BASE_URL = 'https://vite-home.example.com';
    process.env.WORKX_BACKEND_API_BASE_URL = 'https://backend.example.com';
    process.env.VITE_BACKEND_API_BASE_URL = 'https://vite-backend.example.com';

    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      homePageBaseUrl: 'https://auth.example.com',
      backendApiBaseUrl: 'https://backend.example.com',
      llmApiUrl: 'https://backend.example.com/api/llm',
      source: {
        homePageBaseUrl: 'env',
        backendApiBaseUrl: 'env',
        llmApiUrl: 'env',
      },
    });
  });

  it('falls back to process VITE auth env values', () => {
    process.env.VITE_AUTH_BASE_URL = 'https://vite-auth.example.com';
    process.env.VITE_BACKEND_API_BASE_URL = 'https://vite-backend.example.com';

    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      homePageBaseUrl: 'https://vite-auth.example.com',
      backendApiBaseUrl: 'https://vite-backend.example.com',
      llmApiUrl: 'https://vite-backend.example.com/api/llm',
      source: {
        homePageBaseUrl: 'env',
        backendApiBaseUrl: 'env',
        llmApiUrl: 'env',
      },
    });
  });

  it('keeps legacy home page env aliases for existing builds', () => {
    process.env.WORKX_HOME_PAGE_BASE_URL = 'https://legacy-runtime.example.com';
    process.env.VITE_HOME_PAGE_BASE_URL = 'https://legacy-vite.example.com';

    const urls = resolveRuntimeUrls();

    expect(urls.homePageBaseUrl).toBe('https://legacy-runtime.example.com');
    expect(urls.source.homePageBaseUrl).toBe('env');
  });

  it('derives gateway LLM and MCP endpoints from the generic gateway base URL', () => {
    process.env.WORKX_GATEWAY_BASE_URL = 'https://gateway.example.com/api';
    process.env.WORKX_GATEWAY_CATALOG_URL = 'https://gateway.example.com/apps';

    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      gatewayBaseUrl: 'https://gateway.example.com/api',
      gatewayLlmApiUrl: 'https://gateway.example.com/api/v1',
      gatewayMcpUrl: 'https://gateway.example.com/api/mcp',
      gatewayCatalogUrl: 'https://gateway.example.com/apps',
      gatewayMcpName: 'gateway',
      gatewayMcpAuthMode: 'none',
      llmRoutingMode: 'gateway',
      source: {
        gatewayBaseUrl: 'env',
        gatewayLlmApiUrl: 'env',
        gatewayMcpUrl: 'env',
        gatewayCatalogUrl: 'env',
        llmRoutingMode: 'default',
      },
    });
  });

  it('honors explicit gateway overlay settings', () => {
    process.env.WORKX_GATEWAY_BASE_URL = 'https://gateway.example.com';
    process.env.WORKX_GATEWAY_LLM_API_URL = 'https://llm.example.com/openai';
    process.env.WORKX_GATEWAY_PROVIDER_SLUG = 'deepseek';
    process.env.WORKX_GATEWAY_MCP_URL = 'https://mcp.example.com/mcp';
    process.env.WORKX_GATEWAY_MCP_NAME = 'first-party-gateway';
    process.env.WORKX_GATEWAY_MCP_AUTH_MODE = 'session-jwt';
    process.env.WORKX_GATEWAY_MCP_TOOL_DISCOVERY_HEADER = 'X-Custom-Tool-Discovery';
    process.env.WORKX_GATEWAY_MCP_TOOL_DISCOVERY = 'folded';
    process.env.WORKX_LLM_ROUTING_MODE = 'legacy';

    const urls = resolveRuntimeUrls();

    expect(urls.gatewayLlmApiUrl).toBe('https://llm.example.com/openai');
    expect(urls.gatewayProviderSlug).toBe('deepseek');
    expect(urls.gatewayMcpUrl).toBe('https://mcp.example.com/mcp');
    expect(urls.gatewayMcpName).toBe('first-party-gateway');
    expect(urls.gatewayMcpAuthMode).toBe('session-jwt');
    expect(urls.gatewayMcpToolDiscoveryHeader).toBe('X-Custom-Tool-Discovery');
    expect(urls.gatewayMcpToolDiscovery).toBe('folded');
    expect(urls.llmRoutingMode).toBe('legacy');
    expect(urls.source.llmRoutingMode).toBe('env');
    expect(urls.source.gatewayProviderSlug).toBe('env');
  });

  it('defaults gateway MCP auth to api-key when an env key is configured', () => {
    process.env.WORKX_GATEWAY_BASE_URL = 'https://gateway.example.com';
    process.env.WORKX_GATEWAY_MCP_API_KEY = 'gw-key';

    const urls = resolveRuntimeUrls();

    expect(urls.gatewayMcpAuthMode).toBe('api-key');
    expect(urls.gatewayMcpApiKey).toBe('gw-key');
  });
});
