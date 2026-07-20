/**
 * Unit tests for ModelClientFactory
 * Covers: factory pattern, provider mapping, client caching, error handling,
 * auth manager integration, backend routing, configuration status, storage operations
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ModelClientFactory, type ModelProvider, type ModelClientConfig } from '../ModelClientFactory';
import { ModelClientError } from '../ModelClient';
import type { IAuthManager } from '../types/Auth';
import { createMutableAuthContext, type MutableAuthContext } from '../../auth/AuthContext';

// Mock ConfigStorageProvider for setDefaultProvider / getDefaultProvider
const _providerStore = new Map<string, any>();
vi.mock('../../storage/ConfigStorageProvider', () => ({
  getConfigStorage: vi.fn(() => ({
    get: async (key: string) => _providerStore.get(key) ?? null,
    set: async (key: string, value: any) => { _providerStore.set(key, value); },
    remove: async (key: string) => { _providerStore.delete(key); },
  })),
}));

// ---------------------------------------------------------------------------
// Mock all concrete client modules so instantiation doesn't trigger real logic
// ---------------------------------------------------------------------------
vi.mock('../client/OpenAIResponsesClient', () => ({
  OpenAIResponsesClient: vi.fn(),
}));
vi.mock('../client/OpenAIChatCompletionClient', () => ({
  OpenAIChatCompletionClient: vi.fn(),
}));
vi.mock('../client/GoogleCompletionClient', () => ({
  GoogleCompletionClient: vi.fn(),
}));
vi.mock('../client/GroqClient', () => ({
  GroqClient: vi.fn(),
}));
vi.mock('../client/FireworksChatCompletionClient', () => ({
  FireworksChatCompletionClient: vi.fn(),
}));
vi.mock('../client/TogetherChatCompletionClient', () => ({
  TogetherChatCompletionClient: vi.fn(),
}));
vi.mock('../client/AnthropicClient', () => ({
  AnthropicClient: vi.fn(),
}));

// Import the mocked constructors so we can re-set implementations after mockReset
import { OpenAIResponsesClient } from '../client/OpenAIResponsesClient';
import { OpenAIChatCompletionClient } from '../client/OpenAIChatCompletionClient';
import { GoogleCompletionClient } from '../client/GoogleCompletionClient';
import { GroqClient } from '../client/GroqClient';
import { FireworksChatCompletionClient } from '../client/FireworksChatCompletionClient';
import { TogetherChatCompletionClient } from '../client/TogetherChatCompletionClient';
import { AnthropicClient } from '../client/AnthropicClient';

// ---------------------------------------------------------------------------
// Re-establish mock implementations before each test (mockReset: true clears them)
// ---------------------------------------------------------------------------
function setupClientMocks() {
  (OpenAIResponsesClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'OpenAIResponsesClient', _opts: opts,
  }));
  (OpenAIChatCompletionClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'OpenAIChatCompletionClient', _opts: opts,
  }));
  (GoogleCompletionClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'GoogleCompletionClient', _opts: opts,
  }));
  (GroqClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'GroqClient', _opts: opts,
  }));
  (FireworksChatCompletionClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'FireworksChatCompletionClient', _opts: opts,
  }));
  (TogetherChatCompletionClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'TogetherChatCompletionClient', _opts: opts,
  }));
  (AnthropicClient as unknown as Mock).mockImplementation((opts: any) => ({
    _type: 'AnthropicClient', _opts: opts,
  }));
}

// ---------------------------------------------------------------------------
// Helper: build a minimal mock AgentConfig
// ---------------------------------------------------------------------------
function createMockAgentConfig(overrides: {
  selectedModelKey?: string;
  providerApiKey?: string | null;
  providerData?: any;
  modelData?: any;
  toolsConfig?: any;
} = {}) {
  const {
    selectedModelKey = 'openai:gpt-5',
    providerApiKey = 'sk-test-key-1234567890',
    providerData = null,
    modelData = null,
    toolsConfig = {},
  } = overrides;

  const defaultModelData = modelData ?? {
    model: {
      modelKey: 'gpt-5', name: 'GPT-5', supportsReasoning: false,
      supportsReasoningSummaries: false, contextWindow: 128000, maxOutputTokens: 8192, creator: 'OpenAI',
    },
    provider: {
      id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [],
    },
  };

  return {
    getConfig: vi.fn().mockReturnValue({ selectedModelKey }),
    getModelByKey: vi.fn().mockReturnValue(defaultModelData),
    getProviderApiKey: vi.fn().mockResolvedValue(providerApiKey),
    getProvider: vi.fn().mockReturnValue(providerData),
    getProviders: vi.fn().mockReturnValue({
      openai: { id: 'openai' },
      xai: { id: 'xai' },
      anthropic: { id: 'anthropic' },
      'google-ai-studio': { id: 'google-ai-studio' },
      deepseek: { id: 'deepseek' },
    }),
    getToolsConfig: vi.fn().mockReturnValue(toolsConfig),
  } as any;
}

// ---------------------------------------------------------------------------
// Helper: create a mock IAuthManager
// ---------------------------------------------------------------------------
function createMockAuthManager(overrides: {
  shouldUseBackend?: boolean;
  backendBaseUrl?: string | null;
  accessToken?: string | null;
  refreshedAccessToken?: string | null;
  gatewayLlmBaseUrl?: string | null;
} = {}): IAuthManager {
  return {
    shouldUseBackend: vi.fn().mockReturnValue(overrides.shouldUseBackend ?? false),
    getBackendBaseUrl: vi.fn().mockReturnValue(overrides.backendBaseUrl ?? null),
    getGatewayLlmBaseUrl: vi.fn().mockReturnValue(overrides.gatewayLlmBaseUrl ?? null),
    getAccessToken: vi.fn().mockResolvedValue(overrides.accessToken ?? null),
    refreshAccessToken: vi.fn().mockResolvedValue(overrides.refreshedAccessToken ?? null),
  };
}

// ===========================================================================
describe('ModelClientFactory', () => {
  let authContext: MutableAuthContext;
  let factory: ModelClientFactory & {
    updateAuthContext(authManager: IAuthManager | null): void;
    getAuthManager(): IAuthManager | null;
  };

  beforeEach(() => {
    setupClientMocks();
    _providerStore.clear();
    authContext = createMutableAuthContext(null);
    factory = new ModelClientFactory({ authContext }) as typeof factory;
    // Compatibility façade for the pre-AuthContext test cases below. The
    // production factory deliberately exposes no snapshot setter/getter.
    factory.updateAuthContext = (authManager) => {
      authContext.update(authManager, 'routing');
      factory.clearCache();
    };
    factory.getAuthManager = () => authContext.current();
  });

  // =========================================================================
  // Construction & Auth Manager
  // =========================================================================
  describe('constructor and auth manager', () => {
    it('should create an instance with no auth manager and no backend routing', () => {
      expect(factory).toBeInstanceOf(ModelClientFactory);
      expect(factory.getAuthManager()).toBeNull();
      expect(factory.isBackendRouting()).toBe(false);
    });

    it('should store, retrieve, and clear auth manager', () => {
      const auth = createMockAuthManager();
      factory.updateAuthContext(auth);
      expect(factory.getAuthManager()).toBe(auth);

      factory.updateAuthContext(null);
      expect(factory.getAuthManager()).toBeNull();
    });

    it('should report backend routing based on auth manager', () => {
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: false }));
      expect(factory.isBackendRouting()).toBe(false);

      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true }));
      expect(factory.isBackendRouting()).toBe(true);
    });

    it('should clear client cache when auth manager changes', async () => {
      const config = createMockAgentConfig();
      await factory.initialize(config);
      const client1 = await factory.createClient('openai');

      factory.updateAuthContext(createMockAuthManager());
      const client2 = await factory.createClient('openai');
      expect(client1).not.toBe(client2);
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================
  describe('initialize', () => {
    it('should accept an AgentConfig and clear the client cache', async () => {
      const config = createMockAgentConfig();
      await factory.initialize(config);
      const c1 = await factory.createClient('openai');

      await factory.initialize(config);
      const c2 = await factory.createClient('openai');
      expect(c1).not.toBe(c2);
    });
  });

  // =========================================================================
  // getSelectedModel
  // =========================================================================
  describe('getSelectedModel', () => {
    it('should return "gpt-5" default when config is not set', () => {
      expect(factory.getSelectedModel()).toBe('gpt-5');
    });

    it('should return model key from config when initialized', async () => {
      const config = createMockAgentConfig({
        selectedModelKey: 'xai:grok-4',
        modelData: {
          model: { modelKey: 'grok-4', name: 'Grok 4', supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 8192, creator: 'xAI' },
          provider: { id: 'xai', name: 'xAI', apiKey: '', timeout: 30000, models: [] },
        },
      });
      await factory.initialize(config);
      expect(factory.getSelectedModel()).toBe('grok-4');
    });

    it('should return default model when getModelByKey returns null', async () => {
      const config = createMockAgentConfig();
      config.getModelByKey.mockReturnValue(null);
      await factory.initialize(config);
      expect(factory.getSelectedModel()).toBe('gpt-5');
    });
  });

  // =========================================================================
  // createClient - provider to client mapping
  // =========================================================================
  describe('createClient - provider mapping', () => {
    beforeEach(async () => {
      await factory.initialize(createMockAgentConfig());
    });

    it.each([
      ['openai', 'OpenAIResponsesClient'],
      ['xai', 'OpenAIResponsesClient'],
      ['anthropic', 'AnthropicClient'],
      ['groq', 'GroqClient'],
      ['google-ai-studio', 'GoogleCompletionClient'],
      ['fireworks', 'FireworksChatCompletionClient'],
      ['moonshot', 'OpenAIChatCompletionClient'],
      ['together', 'TogetherChatCompletionClient'],
    ] as const)('should map provider "%s" to %s', async (provider, expectedType) => {
      const client = await factory.createClient(provider as ModelProvider);
      expect((client as any)._type).toBe(expectedType);
    });
  });

  // =========================================================================
  // createClient - caching
  // =========================================================================
  describe('createClient - caching', () => {
    beforeEach(async () => {
      await factory.initialize(createMockAgentConfig());
    });

    it('should return same instance for repeated calls, different for different providers', async () => {
      const c1 = await factory.createClient('openai');
      const c2 = await factory.createClient('openai');
      const c3 = await factory.createClient('groq');
      expect(c1).toBe(c2);
      expect(c1).not.toBe(c3);
    });

    it('should use model key in cache key so model switches get fresh clients', async () => {
      const config1 = createMockAgentConfig({ selectedModelKey: 'openai:gpt-5' });
      await factory.initialize(config1);
      const client1 = await factory.createClient('openai');

      // Simulate config change without clearing cache
      (factory as any).config = createMockAgentConfig({ selectedModelKey: 'openai:gpt-5.1' });
      const client2 = await factory.createClient('openai');
      expect(client1).not.toBe(client2);
    });

    it('should use construction-time tools config in the cache key', async () => {
      await factory.initialize(createMockAgentConfig({
        toolsConfig: { parallelToolCalls: false },
      }));
      const client1 = await factory.createClient('openai');

      (factory as any).config = createMockAgentConfig({
        toolsConfig: { parallelToolCalls: true },
      });
      const client2 = await factory.createClient('openai');

      expect(client1).not.toBe(client2);
      expect((client2 as any)._opts.parallelToolCalls).toBe(true);
    });

    it('should separate backend-routed and direct clients in cache', async () => {
      const directClient = await factory.createClient('openai');

      factory.updateAuthContext(createMockAuthManager({
        shouldUseBackend: true,
        backendBaseUrl: 'https://backend.test.com',
      }));
      const backendClient = await factory.createClient('openai');
      expect(directClient).not.toBe(backendClient);
    });
  });

  // =========================================================================
  // createClient - without initialization
  // =========================================================================
  describe('createClient - without initialization', () => {
    it('should create a client with null API key when not initialized', async () => {
      const client = await factory.createClient('openai');
      expect(client).toBeDefined();
    });
  });

  // =========================================================================
  // createClientForCurrentModel
  // =========================================================================
  describe('createClientForCurrentModel', () => {
    it('should throw ModelClientError when factory is not initialized', async () => {
      await expect(factory.createClientForCurrentModel()).rejects.toBeInstanceOf(ModelClientError);
      await expect(factory.createClientForCurrentModel()).rejects.toThrow('not initialized');
    });

    it('should throw when selected model is not found in config', async () => {
      const config = createMockAgentConfig();
      config.getModelByKey.mockReturnValue(null);
      await factory.initialize(config);
      await expect(factory.createClientForCurrentModel()).rejects.toThrow('not found');
    });

    it('should create client for the currently selected model', async () => {
      await factory.initialize(createMockAgentConfig());
      const client = await factory.createClientForCurrentModel();
      expect((client as any)._type).toBe('OpenAIResponsesClient');
    });

    it('should throw for unsupported provider ID', async () => {
      const config = createMockAgentConfig({
        modelData: {
          model: { modelKey: 'x', name: 'X', supportsReasoning: false, contextWindow: 4096, maxOutputTokens: 1024, creator: 'U' },
          provider: { id: 'unsupported-provider', name: 'Unknown', apiKey: '', timeout: 30000, models: [] },
        },
      });
      await factory.initialize(config);
      await expect(factory.createClientForCurrentModel()).rejects.toThrow('Unsupported provider');
    });

    it('should map all valid provider IDs without error', async () => {
      const validProviders: ModelProvider[] = ['openai', 'xai', 'anthropic', 'groq', 'google-ai-studio', 'fireworks', 'moonshot', 'together', 'deepseek'];
      for (const pid of validProviders) {
        const f = new ModelClientFactory();
        await f.initialize(createMockAgentConfig({
          modelData: {
            model: { modelKey: 'test', name: 'T', supportsReasoning: false, contextWindow: 4096, maxOutputTokens: 1024, creator: 'T' },
            provider: { id: pid, name: pid, apiKey: '', timeout: 30000, models: [] },
          },
        }));
        await expect(f.createClientForCurrentModel()).resolves.toBeDefined();
      }
    });
  });

  // =========================================================================
  // createClientWithConfig
  // =========================================================================
  describe('createClientWithConfig', () => {
    it.each([
      ['openai', 'OpenAIResponsesClient'],
      ['google-ai-studio', 'GoogleCompletionClient'],
      ['groq', 'GroqClient'],
      ['fireworks', 'FireworksChatCompletionClient'],
      ['together', 'TogetherChatCompletionClient'],
      ['moonshot', 'OpenAIChatCompletionClient'],
    ] as const)('should create %s for provider "%s"', (provider, expectedType) => {
      const client = factory.createClientWithConfig({ provider: provider as ModelProvider, apiKey: 'test-key' });
      expect((client as any)._type).toBe(expectedType);
    });

    it('should cache clients with identical configs and separate different ones', () => {
      const cfg: ModelClientConfig = { provider: 'openai', apiKey: 'sk-test' };
      const c1 = factory.createClientWithConfig(cfg);
      const c2 = factory.createClientWithConfig(cfg);
      const c3 = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk-different1' });
      expect(c1).toBe(c2);
      expect(c1).not.toBe(c3);
    });

    it('should handle null API key and pass options through', () => {
      const client = factory.createClientWithConfig({
        provider: 'openai', apiKey: null,
        options: { baseUrl: 'https://custom.com', organization: 'org-123' },
      });
      expect(client).toBeDefined();
      expect((client as any)._opts.baseUrl).toBe('https://custom.com');
      expect((client as any)._opts.organization).toBe('org-123');
    });
  });

  // =========================================================================
  // Backend routing
  // =========================================================================
  describe('createClient - backend routing', () => {
    it('should throw when backend URL is not available', async () => {
      await factory.initialize(createMockAgentConfig());
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: null }));
      await expect(factory.createClient('openai')).rejects.toThrow('Backend URL not available');
    });

    it('should create OpenAIResponsesClient for supportBackendMode=1 with /openai path', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'gpt-5', name: 'GPT-5', supportsReasoning: false, supportBackendMode: 1, contextWindow: 128000, maxOutputTokens: 8192, creator: 'OpenAI' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com' }));

      const client = await factory.createClient('openai');
      expect((client as any)._type).toBe('OpenAIResponsesClient');
      expect((client as any)._opts.baseUrl).toBe('https://be.com/openai');
      expect((client as any)._opts.useCredentials).toBe(true);
    });

    it('should create OpenAIChatCompletionClient for supportBackendMode=2', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'model', name: 'M', supportsReasoning: false, supportBackendMode: 2, contextWindow: 4096, maxOutputTokens: 1024, creator: 'T' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com' }));

      const client = await factory.createClient('openai');
      expect((client as any)._type).toBe('OpenAIChatCompletionClient');
      expect((client as any)._opts.useCredentials).toBe(true);
    });

    it('should create GoogleCompletionClient for supportBackendMode=3 with /gemini path', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'gemini', name: 'Gemini', supportsReasoning: false, supportBackendMode: 3, contextWindow: 1000000, maxOutputTokens: 8192, creator: 'Google' },
          provider: { id: 'google-ai-studio', name: 'Google', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com' }));

      const client = await factory.createClient('google-ai-studio');
      expect((client as any)._type).toBe('GoogleCompletionClient');
      expect((client as any)._opts.baseUrl).toBe('https://be.com/gemini');
    });

    it('should fall back to OpenAIChatCompletionClient for supportBackendMode=0', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'x', name: 'X', supportsReasoning: false, supportBackendMode: 0, contextWindow: 4096, maxOutputTokens: 1024, creator: 'T' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com' }));

      const client = await factory.createClient('openai');
      expect((client as any)._type).toBe('OpenAIChatCompletionClient');
    });

    it('should use access token when available, fall back to "backend-routed"', async () => {
      const modelData = {
        model: { modelKey: 'gpt-5', name: 'GPT-5', supportsReasoning: false, supportBackendMode: 1, contextWindow: 128000, maxOutputTokens: 8192, creator: 'OpenAI' },
        provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
      };

      // With token
      await factory.initialize(createMockAgentConfig({ modelData }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com', accessToken: 'jwt-123' }));
      const c1 = await factory.createClient('openai');
      expect((c1 as any)._opts.apiKey).toBe('jwt-123');

      // Without token
      factory.clearCache();
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com', accessToken: null }));
      const c2 = await factory.createClient('openai');
      expect((c2 as any)._opts.apiKey).toBe('backend-routed');
    });

    it('should set reasoning config for backend-routed models that support reasoning', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'o3', name: 'o3', supportsReasoning: true, supportsReasoningSummaries: true, supportBackendMode: 1, contextWindow: 200000, maxOutputTokens: 100000, creator: 'OpenAI' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com' }));

      const client = await factory.createClient('openai');
      expect((client as any)._opts.reasoningEffort).toBe('medium');
      expect((client as any)._opts.reasoningSummary).toEqual({ enabled: true });
    });

    it('should create a Chat Completions client for gateway routing with dynamic session JWT bearer auth', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'gpt-5', name: 'GPT-5', supportsReasoning: true, supportBackendMode: 1, contextWindow: 128000, maxOutputTokens: 8192, creator: 'OpenAI' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({
        shouldUseBackend: true,
        backendBaseUrl: 'https://legacy.example.com/api/llm',
        gatewayLlmBaseUrl: 'https://gateway.example.com/v1',
        accessToken: 'jwt-123',
        refreshedAccessToken: 'jwt-456',
      }));

      const client = await factory.createClient('openai');

      expect((client as any)._type).toBe('OpenAIChatCompletionClient');
      expect((client as any)._opts.baseUrl).toBe('https://gateway.example.com/v1');
      expect((client as any)._opts.apiKey).toBe('gateway-routed');
      expect((client as any)._opts.provider.name).toBe('Gateway');
      expect((client as any)._opts.useCredentials).toBe(false);
      await expect((client as any)._opts.getAuthorizationToken()).resolves.toBe('jwt-123');
      await expect((client as any)._opts.refreshAuthorizationToken()).resolves.toBe('jwt-456');
    });

    it('should cache backend-routed clients', async () => {
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'gpt-5', name: 'GPT-5', supportsReasoning: false, supportBackendMode: 1, contextWindow: 128000, maxOutputTokens: 8192, creator: 'OpenAI' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      factory.updateAuthContext(createMockAuthManager({ shouldUseBackend: true, backendBaseUrl: 'https://be.com' }));

      const c1 = await factory.createClient('openai');
      const c2 = await factory.createClient('openai');
      expect(c1).toBe(c2);
    });
  });

  // =========================================================================
  // clearCache
  // =========================================================================
  describe('clearCache', () => {
    beforeEach(async () => {
      await factory.initialize(createMockAgentConfig());
    });

    it('should clear all cached clients when called without arguments', async () => {
      const c1 = await factory.createClient('openai');
      const c2 = await factory.createClient('groq');
      factory.clearCache();
      expect(await factory.createClient('openai')).not.toBe(c1);
      expect(await factory.createClient('groq')).not.toBe(c2);
    });

    it('should clear only the specified provider cache', async () => {
      const openai1 = await factory.createClient('openai');
      const groq1 = await factory.createClient('groq');
      factory.clearCache('openai');
      expect(await factory.createClient('openai')).not.toBe(openai1);
      expect(await factory.createClient('groq')).toBe(groq1);
    });

    it('should not throw when clearing cache for a provider with no entries', () => {
      expect(() => factory.clearCache('anthropic')).not.toThrow();
    });
  });

  // =========================================================================
  // loadApiKey / hasValidApiKey
  // =========================================================================
  describe('loadApiKey and hasValidApiKey', () => {
    it('should return null when factory is not initialized', async () => {
      expect(await factory.loadApiKey('openai')).toBeNull();
    });

    it('should delegate to config.getProviderApiKey when initialized', async () => {
      const config = createMockAgentConfig({ providerApiKey: 'sk-real' });
      await factory.initialize(config);
      expect(await factory.loadApiKey('openai')).toBe('sk-real');
      expect(config.getProviderApiKey).toHaveBeenCalledWith('openai');
    });

    it('should return null when getProviderApiKey throws', async () => {
      const config = createMockAgentConfig();
      config.getProviderApiKey.mockRejectedValue(new Error('fail'));
      await factory.initialize(config);
      expect(await factory.loadApiKey('openai')).toBeNull();
    });

    it('should validate API keys: non-empty=true, null/empty/whitespace=false', async () => {
      const config = createMockAgentConfig({ providerApiKey: 'sk-valid' });
      await factory.initialize(config);
      expect(await factory.hasValidApiKey('openai')).toBe(true);

      config.getProviderApiKey.mockResolvedValue(null);
      expect(await factory.hasValidApiKey('openai')).toBe(false);

      config.getProviderApiKey.mockResolvedValue('');
      expect(await factory.hasValidApiKey('openai')).toBe(false);

      config.getProviderApiKey.mockResolvedValue('   ');
      expect(await factory.hasValidApiKey('openai')).toBe(false);
    });
  });

  // =========================================================================
  // setDefaultProvider / getDefaultProvider
  // =========================================================================
  describe('setDefaultProvider / getDefaultProvider', () => {
    it('should default to openai when nothing is stored', async () => {
      expect(await factory.getDefaultProvider()).toBe('openai');
    });

    it('should store, retrieve, and overwrite the default provider', async () => {
      await factory.setDefaultProvider('groq');
      expect(await factory.getDefaultProvider()).toBe('groq');

      await factory.setDefaultProvider('anthropic');
      expect(await factory.getDefaultProvider()).toBe('anthropic');
    });
  });

  // =========================================================================
  // getSupportedModels
  // =========================================================================
  describe('getSupportedModels', () => {
    it('should return empty array when not initialized or provider missing', async () => {
      expect(factory.getSupportedModels('openai')).toEqual([]);

      const config = createMockAgentConfig();
      config.getProvider.mockReturnValue(null);
      await factory.initialize(config);
      expect(factory.getSupportedModels('openai')).toEqual([]);
    });

    it('should return model keys from provider config', async () => {
      const config = createMockAgentConfig();
      config.getProvider.mockReturnValue({
        id: 'openai', name: 'OpenAI',
        models: [{ modelKey: 'gpt-5' }, { modelKey: 'gpt-5.1' }],
      });
      await factory.initialize(config);
      expect(factory.getSupportedModels('openai')).toEqual(['gpt-5', 'gpt-5.1']);
    });
  });

  // =========================================================================
  // getConfigurationStatus
  // =========================================================================
  describe('getConfigurationStatus', () => {
    it('should return status for the live provider catalog with correct isDefault', async () => {
      await factory.initialize(createMockAgentConfig({ providerApiKey: null }));
      const status = await factory.getConfigurationStatus();

      expect(Object.keys(status)).toEqual(
        expect.arrayContaining(['openai', 'xai', 'anthropic', 'google-ai-studio', 'deepseek'])
      );
      // Removed providers must NOT appear once they leave the catalog.
      expect(status).not.toHaveProperty('groq');
      expect(status).not.toHaveProperty('moonshot');
      expect(status.openai.isDefault).toBe(true);
      expect(status.xai.isDefault).toBe(false);
    });

    it('should reflect hasApiKey correctly', async () => {
      const config = createMockAgentConfig({ providerApiKey: 'sk-key' });
      await factory.initialize(config);
      const status = await factory.getConfigurationStatus();
      expect(status.openai.hasApiKey).toBe(true);

      config.getProviderApiKey.mockResolvedValue(null);
      const status2 = await factory.getConfigurationStatus();
      expect(status2.openai.hasApiKey).toBe(false);
    });
  });

  // =========================================================================
  // getApiKey / getBaseUrl
  // =========================================================================
  describe('getApiKey and getBaseUrl', () => {
    it('should return null/undefined when not initialized', async () => {
      expect(await factory.getApiKey('openai')).toBeNull();
      expect(factory.getBaseUrl('openai')).toBeUndefined();
    });

    it('should delegate to config when initialized', async () => {
      const config = createMockAgentConfig({ providerApiKey: 'sk-test' });
      config.getProvider.mockReturnValue({ id: 'openai', name: 'OpenAI', baseUrl: 'https://custom.com' });
      await factory.initialize(config);

      expect(await factory.getApiKey('openai')).toBe('sk-test');
      expect(factory.getBaseUrl('openai')).toBe('https://custom.com');
    });

    it('should return undefined for base URL when provider has no URL or is not found', async () => {
      const config = createMockAgentConfig();
      config.getProvider.mockReturnValue({ id: 'openai', name: 'OpenAI', baseUrl: null });
      await factory.initialize(config);
      expect(factory.getBaseUrl('openai')).toBeUndefined();

      config.getProvider.mockReturnValue(null);
      expect(factory.getBaseUrl('unknown')).toBeUndefined();
    });
  });

  // =========================================================================
  // instantiateClient - model configuration details
  // =========================================================================
  describe('instantiateClient - model configuration details', () => {
    it('should pass reasoning config only when model supports it', async () => {
      // With reasoning
      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'o3', name: 'o3', supportsReasoning: true, supportsReasoningSummaries: true, contextWindow: 200000, maxOutputTokens: 100000, creator: 'OpenAI' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      let client = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk' });
      expect((client as any)._opts.reasoningEffort).toBe('medium');
      expect((client as any)._opts.reasoningSummary).toEqual({ enabled: true });

      // Without reasoning
      await factory.initialize(createMockAgentConfig());
      client = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk' });
      expect((client as any)._opts.reasoningEffort).toBeUndefined();
    });

    it('should set serviceTier to "default" for openai when not specified, or use model value', async () => {
      await factory.initialize(createMockAgentConfig());
      let client = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk' });
      expect((client as any)._opts.serviceTier).toBe('default');

      await factory.initialize(createMockAgentConfig({
        modelData: {
          model: { modelKey: 'gpt-5', name: 'GPT-5', supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 8192, creator: 'OpenAI', serviceTier: 'priority' },
          provider: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      client = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk' });
      expect((client as any)._opts.serviceTier).toBe('priority');
    });

    it('should set provider display names correctly', async () => {
      const cases: [string, string, string][] = [
        ['google-ai-studio', 'Google AI Studio', 'google-ai-studio:gemini'],
        ['fireworks', 'Fireworks AI', 'fireworks:llama'],
        ['together', 'Together AI', 'together:qwen'],
        ['anthropic', 'Anthropic', 'anthropic:claude-sonnet-4-6'],
      ];
      for (const [pid, expectedName, selectedKey] of cases) {
        await factory.initialize(createMockAgentConfig({
          selectedModelKey: selectedKey,
          modelData: {
            model: { modelKey: selectedKey.split(':')[1], name: 'M', supportsReasoning: false, contextWindow: 4096, maxOutputTokens: 1024, creator: 'C' },
            provider: { id: pid, name: pid, apiKey: '', timeout: 30000, models: [] },
          },
        }));
        const client = factory.createClientWithConfig({ provider: pid as ModelProvider, apiKey: 'key' });
        expect((client as any)._opts.provider.name).toBe(expectedName);
      }
    });

    it('should set wire_api to Chat for google-ai-studio, Responses for others', async () => {
      await factory.initialize(createMockAgentConfig({
        selectedModelKey: 'google-ai-studio:gemini',
        modelData: {
          model: { modelKey: 'gemini', name: 'G', supportsReasoning: false, contextWindow: 1000000, maxOutputTokens: 8192, creator: 'Google' },
          provider: { id: 'google-ai-studio', name: 'Google AI Studio', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      let client = factory.createClientWithConfig({ provider: 'google-ai-studio', apiKey: 'key' });
      expect((client as any)._opts.provider.wire_api).toBe('Chat');

      await factory.initialize(createMockAgentConfig());
      client = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk' });
      expect((client as any)._opts.provider.wire_api).toBe('Responses');
    });

    it('should set Google-specific base instructions for google-ai-studio', async () => {
      await factory.initialize(createMockAgentConfig({
        selectedModelKey: 'google-ai-studio:gemini-2.5-pro',
        modelData: {
          model: { modelKey: 'gemini-2.5-pro', name: 'Gemini', supportsReasoning: false, contextWindow: 1000000, maxOutputTokens: 8192, creator: 'Google' },
          provider: { id: 'google-ai-studio', name: 'Google AI Studio', apiKey: '', timeout: 30000, models: [] },
        },
      }));
      const client = factory.createClientWithConfig({ provider: 'google-ai-studio', apiKey: 'key' });
      expect((client as any)._opts.modelFamily.base_instructions).toContain('Gemini');
    });
  });

  // =========================================================================
  // hashConfig - caching via createClientWithConfig
  // =========================================================================
  describe('hashConfig - caching behavior', () => {
    it('should use only first 10 chars of API key for cache hashing', () => {
      const c1 = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk-1234567890-aaa' });
      const c2 = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk-1234567890-bbb' });
      // Same first 10 chars => same hash => cached
      expect(c1).toBe(c2);
    });

    it('should differentiate configs with different first 10 chars of API key', () => {
      const c1 = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk-aaaaaaaaaa' });
      const c2 = factory.createClientWithConfig({ provider: 'openai', apiKey: 'sk-bbbbbbbbbb' });
      expect(c1).not.toBe(c2);
    });
  });

  // =========================================================================
  // loadConfigForProvider integration
  // =========================================================================
  describe('loadConfigForProvider - integration via createClient', () => {
    it('should load OpenAI organization from provider config', async () => {
      const config = createMockAgentConfig();
      config.getProvider.mockReturnValue({ id: 'openai', name: 'OpenAI', organization: 'org-test-123' });
      await factory.initialize(config);
      const client = await factory.createClient('openai');
      expect((client as any)._opts.organization).toBe('org-test-123');
    });

    it('should use provider base URL from config', async () => {
      const config = createMockAgentConfig();
      config.getProvider.mockReturnValue({ id: 'openai', name: 'OpenAI', baseUrl: 'https://custom.com/v1' });
      await factory.initialize(config);
      const client = await factory.createClient('openai');
      expect((client as any)._opts.baseUrl).toBe('https://custom.com/v1');
    });
  });
});
