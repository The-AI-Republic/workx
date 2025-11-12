/**
 * T008: Contract test for GET /config/model
 * Tests retrieving model configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentConfig } from '@config/AgentConfig';
import { IModelConfig } from '@config/types';
import { resetChromeStorageMock, setChromeStorageData } from '../../helpers/chrome-storage-mock';

describe('GET /config/model - Contract Test', () => {
  let configService: AgentConfig;

  beforeEach(() => {
    resetChromeStorageMock();
    configService = new AgentConfig();
  });

  it('should return the current model configuration', async () => {
    // Set initial data
    setChromeStorageData('sync', {
      browserx_config_v1: {
        version: '1.0.0',
        model: {
          selected: 'gpt-4',
          provider: 'openai',
          contextWindow: 128000,
          maxOutputTokens: 4000,
          reasoningEffort: 'high',
          verbosity: 'low'
        }
      }
    });

    const modelConfig = await configService.getModelConfig();

    expect(modelConfig).toEqual({
      selected: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxOutputTokens: 4000,
      reasoningEffort: 'high',
      verbosity: 'low'
    });
  });

  it('should return default model config when not set', async () => {
    const modelConfig = await configService.getModelConfig();

    expect(modelConfig).toHaveProperty('selected');
    expect(modelConfig).toHaveProperty('provider');
    expect(modelConfig.selected).toBe('gpt-3.5-turbo');
    expect(modelConfig.provider).toBe('openai');
  });

  it('should validate response matches IModelConfig interface', async () => {
    const modelConfig = await configService.getModelConfig();

    // Required fields
    expect(modelConfig).toHaveProperty('selected');
    expect(modelConfig).toHaveProperty('provider');

    // Optional fields with correct types
    if (modelConfig.contextWindow !== undefined) {
      expect(typeof modelConfig.contextWindow).toBe('number');
      expect(modelConfig.contextWindow).toBeGreaterThan(0);
    }

    if (modelConfig.maxOutputTokens !== undefined) {
      expect(typeof modelConfig.maxOutputTokens).toBe('number');
      expect(modelConfig.maxOutputTokens).toBeGreaterThan(0);
    }

    if (modelConfig.reasoningEffort !== undefined) {
      expect(['low', 'medium', 'high']).toContain(modelConfig.reasoningEffort);
    }

    if (modelConfig.reasoningSummary !== undefined) {
      expect(['none', 'brief', 'detailed']).toContain(modelConfig.reasoningSummary);
    }
  });

  it('should handle profile-based model config', async () => {
    // Set config with active profile
    setChromeStorageData('sync', {
      browserx_config_v1: {
        version: '1.0.0',
        model: {
          selected: 'gpt-3.5-turbo',
          provider: 'openai'
        },
        activeProfile: 'production',
        profiles: {
          production: {
            name: 'production',
            model: 'gpt-4',
            provider: 'openai',
            modelSettings: {
              maxOutputTokens: 8000,
              reasoningEffort: 'high'
            }
          }
        }
      }
    });

    const modelConfig = await configService.getModelConfig();

    // Should merge profile settings with base model config
    expect(modelConfig.selected).toBe('gpt-4');
    expect(modelConfig.maxOutputTokens).toBe(8000);
    expect(modelConfig.reasoningEffort).toBe('high');
  });
});