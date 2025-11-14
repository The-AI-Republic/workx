/**
 * Contract test for GET /config
 * Tests retrieving the complete configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentConfig } from '@config/AgentConfig';
import { IAgentConfig } from '@config/types';
import { resetChromeStorageMock } from '../../helpers/chrome-storage-mock';

describe('GET /config - Contract Test', () => {
  let configService: AgentConfig;

  beforeEach(() => {
    resetChromeStorageMock();
    configService = new AgentConfig();
  });

  it('should return the complete configuration object', async () => {
    // This test MUST fail initially as AgentConfig doesn't exist yet
    const config = await configService.getConfig();

    // Validate contract structure
    expect(config).toHaveProperty('version');
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('providers');
    expect(config).toHaveProperty('preferences');
    expect(config).toHaveProperty('cache');
    expect(config).toHaveProperty('extension');

    // Validate types
    expect(typeof config.version).toBe('string');
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof config.model).toBe('object');
    expect(typeof config.providers).toBe('object');
  });

  it('should return default configuration when storage is empty', async () => {
    const config = await configService.getConfig();

    expect(config.version).toBe('1.0.0');
    expect(config.extension.enabled).toBe(true);
    expect(config.cache.enabled).toBe(true);
    expect(config.preferences.autoSync).toBe(true);
  });

  it('should handle storage read errors gracefully', async () => {
    // Simulate storage error
    jest.spyOn(chrome.storage.sync, 'get').mockRejectedValueOnce(new Error('Storage error'));

    const config = await configService.getConfig();

    // Should return default config on error
    expect(config).toBeDefined();
    expect(config.version).toBe('1.0.0');
  });

  it('should validate response schema matches OpenAPI contract', async () => {
    const config = await configService.getConfig();

    // From config-api.yaml schema
    const requiredFields = ['version', 'model', 'providers', 'preferences', 'cache', 'extension'];
    requiredFields.forEach(field => {
      expect(config).toHaveProperty(field);
    });

    // Model config validation
    expect(config.model).toHaveProperty('selected');
    expect(config.model).toHaveProperty('provider');

    // Extension settings validation
    expect(config.extension).toHaveProperty('enabled');
    expect(config.extension).toHaveProperty('contentScriptEnabled');
  });
});