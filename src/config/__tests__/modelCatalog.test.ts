import { describe, expect, it, vi } from 'vitest';
import {
  getModelCatalogOverride,
  initializeModelCatalog,
  setModelCatalogLoader,
} from '../modelCatalog';
import { getDefaultProviders } from '../defaults';

describe('OSS model catalog adapter', () => {
  it('keeps the bundled catalog and does not invoke an installed product loader', async () => {
    const loader = vi.fn(async () => ({}));
    setModelCatalogLoader(loader);

    await initializeModelCatalog();

    expect(loader).not.toHaveBeenCalled();
    expect(getModelCatalogOverride()).toBeNull();
    expect(Object.keys(getDefaultProviders()).length).toBeGreaterThan(0);
  });

  it('defines an explicit OpenHub route for every bundled model', () => {
    const providers = getDefaultProviders();
    expect(Object.fromEntries(Object.entries(providers).flatMap(([providerId, provider]) =>
      provider.models.map((model) => [
        `${providerId}:${model.modelKey}`,
        model.openHubRoute,
      ]),
    ))).toEqual({
      'xai:grok-4-1-fast-reasoning': {
        modelSlug: 'x-ai/grok-4-1-fast-reasoning', providerSlug: 'xai',
      },
      'openai:gpt-5.5': { modelSlug: 'openai/gpt-5.5', providerSlug: 'azure' },
      'openai:gpt-5.4': { modelSlug: 'openai/gpt-5.4', providerSlug: 'azure' },
      'google-ai-studio:gemini-3.1-pro': {
        modelSlug: 'google/gemini-3.1-pro', providerSlug: 'google-ai-studio',
      },
      'deepseek:deepseek-v4-flash': {
        modelSlug: 'deepseek/deepseek-v4-flash', providerSlug: 'deepseek',
      },
      'anthropic:claude-opus-4-8': {
        modelSlug: 'anthropic/claude-opus-4-8', providerSlug: 'deepinfra',
      },
      'anthropic:claude-sonnet-4-6': {
        modelSlug: 'anthropic/claude-sonnet-4-6', providerSlug: 'deepinfra',
      },
      'anthropic:claude-fable-5': {
        modelSlug: 'anthropic/claude-fable-5', providerSlug: 'anthropic',
      },
      'anthropic:claude-haiku-4-5-20251001': {
        modelSlug: 'anthropic/claude-haiku-4.5', providerSlug: 'anthropic',
      },
    });
  });
});
