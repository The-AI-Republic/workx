/**
 * T007: Contract test for PUT /config
 * Tests updating the complete configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentConfig } from '@config/AgentConfig';
import { IAgentConfig } from '@config/types';
import { resetChromeStorageMock, getChromeStorageData } from '../../helpers/chrome-storage-mock';

describe('PUT /config - Contract Test', () => {
  let configService: AgentConfig;

  beforeEach(() => {
    resetChromeStorageMock();
    configService = new AgentConfig();
  });

  it('should update the entire configuration', async () => {
    const newConfig: Partial<IAgentConfig> = {
      model: {
        selected: 'gpt-4',
        provider: 'openai',
        maxOutputTokens: 4000
      },
      preferences: {
        autoSync: false,
        telemetryEnabled: true,
        theme: 'dark'
      }
    };

    const updatedConfig = await configService.updateConfig(newConfig);

    expect(updatedConfig.model.selected).toBe('gpt-4');
    expect(updatedConfig.model.maxOutputTokens).toBe(4000);
    expect(updatedConfig.preferences.autoSync).toBe(false);
    expect(updatedConfig.preferences.theme).toBe('dark');
  });

  it('should validate configuration before updating', async () => {
    const invalidConfig = {
      model: {
        selected: '', // Invalid: empty string
        provider: 'invalid_provider'
      }
    };

    await expect(configService.updateConfig(invalidConfig)).rejects.toThrow('ValidationError');
  });

  it('should persist changes to Chrome storage', async () => {
    const newConfig = {
      preferences: {
        theme: 'dark'
      }
    };

    await configService.updateConfig(newConfig);

    // Verify storage was updated
    const storageData = getChromeStorageData('sync');
    expect(storageData.browserx_config_v1).toBeDefined();
    expect(storageData.browserx_config_v1.preferences.theme).toBe('dark');
  });

  it('should handle storage quota exceeded errors', async () => {
    const largeConfig = {
      preferences: {
        experimental: Object.fromEntries(
          Array(1000).fill(0).map((_, i) => [`feature_${i}`, true])
        )
      }
    };

    jest.spyOn(chrome.storage.sync, 'set').mockRejectedValueOnce(
      new Error('Quota exceeded')
    );

    await expect(configService.updateConfig(largeConfig)).rejects.toThrow('Quota exceeded');
  });

  it('should emit config change events', async () => {
    const changeHandler = jest.fn();
    configService.on('config-changed', changeHandler);

    await configService.updateConfig({
      model: { selected: 'claude-3' }
    });

    expect(changeHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'config-changed',
        section: 'model',
        newValue: expect.objectContaining({ selected: 'claude-3' })
      })
    );
  });

  it('should return 400 for invalid configuration', async () => {
    const invalidConfig = {
      version: 'not-semver', // Invalid version format
      model: {
        contextWindow: -1 // Invalid: negative number
      }
    };

    try {
      await configService.updateConfig(invalidConfig);
      expect.fail('Should have thrown validation error');
    } catch (error: any) {
      expect(error.name).toBe('ConfigValidationError');
      expect(error.field).toBeDefined();
    }
  });
});