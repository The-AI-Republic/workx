/**
 * Custom endpoint (BYOK) persistence round-trip.
 *
 * Built-in provider metadata is reloaded from default.json each boot and is
 * intentionally NOT persisted. User-defined custom providers have no
 * default.json entry, so their full definition must survive the
 * extractStoredConfig → buildRuntimeConfig round-trip, and a selected custom
 * model must not be treated as "missing" and reset to the default.
 */

import { describe, it, expect } from 'vitest';
import { getDefaultAgentConfig, extractStoredConfig, buildRuntimeConfig } from '@/config/defaults';
import type { IProviderConfig } from '@/config/types';

function makeCustomProvider(): IProviderConfig {
  return {
    id: 'custom-abc',
    name: 'My LLM',
    apiKey: '[SECURED]',
    baseUrl: 'https://api.example.com/v1',
    timeout: 30000,
    retryConfig: { maxRetries: 3, initialDelay: 1000, maxDelay: 10000, backoffMultiplier: 2 },
    isCustom: true,
    apiFormat: 'chat_completions',
    models: [
      {
        name: 'My LLM',
        modelKey: 'my-model',
        creator: 'Custom',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsReasoning: false,
        supportsImage: false,
        supportBackendMode: 0,
      },
    ],
  };
}

describe('custom endpoint persistence', () => {
  it('extractStoredConfig moves custom providers into customProviders (not providerKeys)', () => {
    const config = getDefaultAgentConfig();
    config.providers['custom-abc'] = makeCustomProvider();

    const stored = extractStoredConfig(config);

    expect(stored.customProviders).toBeDefined();
    expect(stored.customProviders).toHaveLength(1);
    expect(stored.customProviders![0].id).toBe('custom-abc');
    expect(stored.customProviders![0].apiFormat).toBe('chat_completions');
    // Custom providers must NOT leak into providerKeys (which is for built-ins).
    expect(stored.providerKeys['custom-abc']).toBeUndefined();
  });

  it('omits customProviders entirely when there are none', () => {
    const stored = extractStoredConfig(getDefaultAgentConfig());
    expect(stored.customProviders).toBeUndefined();
  });

  it('buildRuntimeConfig re-injects persisted custom providers with isCustom set', () => {
    const config = getDefaultAgentConfig();
    config.providers['custom-abc'] = makeCustomProvider();

    const stored = extractStoredConfig(config);
    const rebuilt = buildRuntimeConfig(stored);

    const restored = rebuilt.providers['custom-abc'];
    expect(restored).toBeDefined();
    expect(restored.isCustom).toBe(true);
    expect(restored.baseUrl).toBe('https://api.example.com/v1');
    expect(restored.models[0].modelKey).toBe('my-model');
  });

  it('does not reset a selected custom model on reload', () => {
    const config = getDefaultAgentConfig();
    config.providers['custom-abc'] = makeCustomProvider();
    config.selectedModelKey = 'custom-abc:my-model';

    const rebuilt = buildRuntimeConfig(extractStoredConfig(config));

    expect(rebuilt.selectedModelKey).toBe('custom-abc:my-model');
  });

  it('survives a second round-trip (build → extract → build)', () => {
    const config = getDefaultAgentConfig();
    config.providers['custom-abc'] = makeCustomProvider();
    config.selectedModelKey = 'custom-abc:my-model';

    const once = buildRuntimeConfig(extractStoredConfig(config));
    const twice = buildRuntimeConfig(extractStoredConfig(once));

    expect(twice.providers['custom-abc']?.isCustom).toBe(true);
    expect(twice.providers['custom-abc']?.models[0].modelKey).toBe('my-model');
    expect(twice.selectedModelKey).toBe('custom-abc:my-model');
  });
});
