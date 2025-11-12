/**
 * T009: Contract test for PATCH /config/model
 * Tests updating model configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentConfig } from '@config/AgentConfig';
import { IModelConfig } from '@config/types';
import { resetChromeStorageMock, getChromeStorageData } from '../../helpers/chrome-storage-mock';

describe('PATCH /config/model - Contract Test', () => {
  let configService: AgentConfig;

  beforeEach(() => {
    resetChromeStorageMock();
    configService = new AgentConfig();
  });

  it('should update specific model configuration fields', async () => {
    // Set initial config
    await configService.updateConfig({
      model: {
        selected: 'gpt-3.5-turbo',
        provider: 'openai',
        maxOutputTokens: 2000
      }
    });

    // Update specific fields
    const updatedModel = await configService.updateModelConfig({
      selected: 'gpt-4',
      maxOutputTokens: 4000,
      reasoningEffort: 'high'
    });

    expect(updatedModel.selected).toBe('gpt-4');
    expect(updatedModel.provider).toBe('openai'); // Should remain unchanged
    expect(updatedModel.maxOutputTokens).toBe(4000);
    expect(updatedModel.reasoningEffort).toBe('high');
  });

  it('should validate model provider exists', async () => {
    const invalidUpdate = {
      selected: 'gpt-4',
      provider: 'non-existent-provider'
    };

    await expect(configService.updateModelConfig(invalidUpdate)).rejects.toThrow(
      'Provider not found: non-existent-provider'
    );
  });

  it('should validate maxOutputTokens <= contextWindow', async () => {
    await configService.updateModelConfig({
      contextWindow: 4000,
      maxOutputTokens: 2000
    });

    // Try to set maxOutputTokens > contextWindow
    await expect(
      configService.updateModelConfig({
        maxOutputTokens: 5000 // Greater than contextWindow
      })
    ).rejects.toThrow('maxOutputTokens cannot exceed contextWindow');
  });

  it('should persist model changes to storage', async () => {
    await configService.updateModelConfig({
      selected: 'claude-3-opus-20240229',
      provider: 'anthropic',
      verbosity: 'high'
    });

    const storageData = getChromeStorageData('sync');
    expect(storageData.browserx_config_v1.model).toMatchObject({
      selected: 'claude-3-opus-20240229',
      provider: 'anthropic',
      verbosity: 'high'
    });
  });

  it('should emit model change event', async () => {
    const changeHandler = jest.fn();
    configService.on('config-changed', changeHandler);

    const oldModel = await configService.getModelConfig();

    await configService.updateModelConfig({
      selected: 'gpt-4-turbo'
    });

    expect(changeHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'config-changed',
        section: 'model',
        oldValue: oldModel,
        newValue: expect.objectContaining({
          selected: 'gpt-4-turbo'
        })
      })
    );
  });

  it('should handle partial updates without affecting other fields', async () => {
    // Set complete model config
    await configService.updateModelConfig({
      selected: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxOutputTokens: 4000,
      reasoningEffort: 'medium',
      reasoningSummary: 'brief',
      verbosity: 'low'
    });

    // Update only one field
    await configService.updateModelConfig({
      verbosity: 'high'
    });

    const modelConfig = await configService.getModelConfig();

    // All other fields should remain unchanged
    expect(modelConfig.selected).toBe('gpt-4');
    expect(modelConfig.contextWindow).toBe(128000);
    expect(modelConfig.reasoningEffort).toBe('medium');
    expect(modelConfig.verbosity).toBe('high'); // Only this changed
  });

  it('should validate enum values for reasoningEffort', async () => {
    await expect(
      configService.updateModelConfig({
        reasoningEffort: 'invalid' as any
      })
    ).rejects.toThrow('Invalid reasoningEffort: must be low, medium, or high');
  });

  it('should validate enum values for verbosity', async () => {
    await expect(
      configService.updateModelConfig({
        verbosity: 'invalid' as any
      })
    ).rejects.toThrow('Invalid verbosity: must be low, medium, or high');
  });
});