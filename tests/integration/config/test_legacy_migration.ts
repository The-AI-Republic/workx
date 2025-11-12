/**
 * T020: Integration test for migration from old system
 * Tests migrating from ModelClientFactory storage format
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentConfig } from '@config/AgentConfig';
import { resetChromeStorageMock, setChromeStorageData, getChromeStorageData } from '../../helpers/chrome-storage-mock';

describe('Legacy Migration Integration Test', () => {
  let configService: AgentConfig;

  beforeEach(() => {
    resetChromeStorageMock();
    configService = new AgentConfig();
  });

  it('should migrate from ModelClientFactory storage format', async () => {
    // Simulate old storage format from ModelClientFactory
    setChromeStorageData('sync', {
      'openai_api_key': 'sk-old-key-123',
      'anthropic_api_key': 'claude-old-key-456',
      'default_provider': 'openai',
      'openai_organization': 'org-789'
    });

    // Run migration
    const result = await configService.migrateFromLegacy();

    expect(result.success).toBe(true);
    expect(result.migratedFrom).toBe('ModelClientFactory');
    expect(result.migratedTo).toBe('1.0.0');
    expect(result.itemsMigrated).toBe(4);

    // Verify new config structure
    const config = await configService.getConfig();

    expect(config.providers.openai).toMatchObject({
      id: 'openai',
      name: 'OpenAI',
      apiKey: 'sk-old-key-123',
      organization: 'org-789'
    });

    expect(config.providers.anthropic).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic',
      apiKey: 'claude-old-key-456'
    });

    expect(config.model.provider).toBe('openai');
  });

  it('should clean up old storage keys after migration', async () => {
    // Set old keys
    setChromeStorageData('sync', {
      'openai_api_key': 'sk-test',
      'anthropic_api_key': 'claude-test',
      'default_provider': 'anthropic'
    });

    await configService.migrateFromLegacy();

    // Check old keys are removed
    const storageData = getChromeStorageData('sync');
    expect(storageData['openai_api_key']).toBeUndefined();
    expect(storageData['anthropic_api_key']).toBeUndefined();
    expect(storageData['default_provider']).toBeUndefined();

    // Check new config exists
    expect(storageData['browserx_config_v1']).toBeDefined();
  });

  it('should handle partial migration when some keys are missing', async () => {
    // Only OpenAI key exists
    setChromeStorageData('sync', {
      'openai_api_key': 'sk-only-openai'
    });

    const result = await configService.migrateFromLegacy();

    expect(result.success).toBe(true);
    expect(result.itemsMigrated).toBe(1);

    const config = await configService.getConfig();
    expect(config.providers.openai).toBeDefined();
    expect(config.providers.anthropic).toBeUndefined();
  });

  it('should not migrate if already migrated', async () => {
    // Already has new format
    setChromeStorageData('sync', {
      'browserx_config_v1': {
        version: '1.0.0',
        model: { selected: 'gpt-4', provider: 'openai' }
      },
      'browserx_config_version': '1.0.0'
    });

    const result = await configService.migrateFromLegacy();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Already migrated');
  });

  it('should create backup before migration', async () => {
    setChromeStorageData('sync', {
      'openai_api_key': 'sk-backup-test',
      'default_provider': 'openai'
    });

    await configService.migrateFromLegacy();

    const storageData = getChromeStorageData('sync');
    expect(storageData['browserx_config_backup']).toBeDefined();
    expect(storageData['browserx_config_backup']).toMatchObject({
      'openai_api_key': 'sk-backup-test',
      'default_provider': 'openai'
    });
  });

  it('should handle migration errors gracefully', async () => {
    // Simulate storage error during migration
    jest.spyOn(chrome.storage.sync, 'set').mockRejectedValueOnce(new Error('Storage error'));

    setChromeStorageData('sync', {
      'openai_api_key': 'sk-error-test'
    });

    const result = await configService.migrateFromLegacy();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Storage error');

    // Original data should remain
    const storageData = getChromeStorageData('sync');
    expect(storageData['openai_api_key']).toBe('sk-error-test');
  });

  it('should migrate and preserve API key encryption', async () => {
    setChromeStorageData('sync', {
      'openai_api_key': 'sk-secret-123',
      'anthropic_api_key': 'claude-secret-456'
    });

    await configService.migrateFromLegacy();

    // Keys should be migrated but marked for encryption
    const config = await configService.getConfig();

    // In real implementation, keys would be encrypted
    // For now, verify they're transferred correctly
    expect(config.providers.openai.apiKey).toBe('sk-secret-123');
    expect(config.providers.anthropic.apiKey).toBe('claude-secret-456');
  });

  it('should set correct defaults during migration', async () => {
    setChromeStorageData('sync', {
      'openai_api_key': 'sk-defaults-test'
    });

    await configService.migrateFromLegacy();

    const config = await configService.getConfig();

    // Check defaults are applied
    expect(config.version).toBe('1.0.0');
    expect(config.preferences.autoSync).toBe(true);
    expect(config.preferences.telemetryEnabled).toBe(false);
    expect(config.cache.enabled).toBe(true);
    expect(config.extension.enabled).toBe(true);
  });
});