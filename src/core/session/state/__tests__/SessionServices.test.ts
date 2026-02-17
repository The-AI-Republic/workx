/**
 * SessionServices factory tests
 *
 * Tests for createSessionServices, ConsoleNotifier, and InMemoryFeatureFlagRecorder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionServices, type SessionServices } from '../SessionServices';

describe('SessionServices Factory', () => {
  describe('createSessionServices', () => {
    it('should create services with defaults', async () => {
      const services = await createSessionServices({}, false);

      expect(services).toBeDefined();
      expect(services.notifier).toBeDefined();
      expect(services.showRawAgentReasoning).toBe(false);
    });

    it('should create services in test mode', async () => {
      const services = await createSessionServices({}, true);

      expect(services).toBeDefined();
      expect(services.notifier).toBeDefined();
      // Test mode should provide a featureFlagRecorder
      expect(services.featureFlagRecorder).toBeDefined();
    });

    it('should not create featureFlagRecorder in production mode without config', async () => {
      const services = await createSessionServices({}, false);
      expect(services.featureFlagRecorder).toBeUndefined();
    });

    it('should use provided rollout', async () => {
      const mockRollout = {
        recordItems: vi.fn(),
        flush: vi.fn(),
        shutdown: vi.fn(),
      };

      const services = await createSessionServices(
        { rollout: mockRollout as any },
        false
      );

      expect(services.rollout).toBe(mockRollout);
    });

    it('should use provided notifier', async () => {
      const mockNotifier = {
        notify: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
      };

      const services = await createSessionServices(
        { notifier: mockNotifier as any },
        false
      );

      expect(services.notifier).toBe(mockNotifier);
    });

    it('should use provided featureFlagRecorder even in production mode', async () => {
      const mockRecorder = {
        record: vi.fn(),
        isEnabled: vi.fn(),
      };

      const services = await createSessionServices(
        { featureFlagRecorder: mockRecorder },
        false
      );

      expect(services.featureFlagRecorder).toBe(mockRecorder);
    });

    it('should use provided featureFlagRecorder in test mode instead of default', async () => {
      const mockRecorder = {
        record: vi.fn(),
        isEnabled: vi.fn(),
      };

      const services = await createSessionServices(
        { featureFlagRecorder: mockRecorder },
        true
      );

      expect(services.featureFlagRecorder).toBe(mockRecorder);
    });

    it('should use provided DOM service', async () => {
      const mockDOMService = {
        querySelector: vi.fn(),
        querySelectorAll: vi.fn(),
        click: vi.fn(),
        getText: vi.fn(),
        setAttribute: vi.fn(),
      };

      const services = await createSessionServices(
        { domService: mockDOMService as any },
        false
      );

      expect(services.domService).toBe(mockDOMService);
    });

    it('should use provided tab manager', async () => {
      const mockTabManager = {
        getCurrentTab: vi.fn(),
        openTab: vi.fn(),
        closeTab: vi.fn(),
        updateTab: vi.fn(),
        listTabs: vi.fn(),
      };

      const services = await createSessionServices(
        { tabManager: mockTabManager as any },
        false
      );

      expect(services.tabManager).toBe(mockTabManager);
    });

    it('should respect showRawAgentReasoning flag', async () => {
      const services1 = await createSessionServices(
        { showRawAgentReasoning: true },
        false
      );
      expect(services1.showRawAgentReasoning).toBe(true);

      const services2 = await createSessionServices(
        { showRawAgentReasoning: false },
        false
      );
      expect(services2.showRawAgentReasoning).toBe(false);
    });

    it('should default rollout to null when not provided', async () => {
      const services = await createSessionServices({}, false);
      expect(services.rollout).toBeNull();
    });

    it('should default domService to undefined when not provided', async () => {
      const services = await createSessionServices({}, false);
      expect(services.domService).toBeUndefined();
    });

    it('should default tabManager to undefined when not provided', async () => {
      const services = await createSessionServices({}, false);
      expect(services.tabManager).toBeUndefined();
    });

    it('should allow partial service override', async () => {
      const mockNotifier = {
        notify: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
      };

      const services = await createSessionServices(
        {
          notifier: mockNotifier as any,
          showRawAgentReasoning: true,
        },
        false
      );

      expect(services.notifier).toBe(mockNotifier);
      expect(services.showRawAgentReasoning).toBe(true);
      expect(services.rollout).toBeNull();
    });

    it('should create independent service instances', async () => {
      const services1 = await createSessionServices({}, false);
      const services2 = await createSessionServices({}, false);

      expect(services1).not.toBe(services2);
    });
  });

  describe('ConsoleNotifier (default notifier)', () => {
    let services: SessionServices;

    beforeEach(async () => {
      services = await createSessionServices({}, false);
    });

    it('should log info messages with [INFO] prefix via notify()', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      services.notifier.notify('test message');
      expect(logSpy).toHaveBeenCalledWith('[INFO]', 'test message');
    });

    it('should log with specified type prefix via notify()', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      services.notifier.notify('warning msg', 'warning');
      expect(logSpy).toHaveBeenCalledWith('[WARNING]', 'warning msg');
    });

    it('should log with SUCCESS prefix via notify()', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      services.notifier.notify('success msg', 'success');
      expect(logSpy).toHaveBeenCalledWith('[SUCCESS]', 'success msg');
    });

    it('should log with ERROR prefix via notify()', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      services.notifier.notify('error msg', 'error');
      expect(logSpy).toHaveBeenCalledWith('[ERROR]', 'error msg');
    });

    it('should log error messages via error()', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      services.notifier.error('something failed');
      expect(errorSpy).toHaveBeenCalledWith('[ERROR]', 'something failed');
    });

    it('should log success messages via success()', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      services.notifier.success('all good');
      expect(logSpy).toHaveBeenCalledWith('[SUCCESS]', 'all good');
    });

    it('should log warning messages via warning() when available', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (services.notifier.warning) {
        services.notifier.warning('watch out');
        expect(warnSpy).toHaveBeenCalledWith('[WARNING]', 'watch out');
      }
    });

    it('should default to info type when no type is specified', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      services.notifier.notify('default type');
      expect(logSpy).toHaveBeenCalledWith('[INFO]', 'default type');
    });
  });

  describe('InMemoryFeatureFlagRecorder (test mode default)', () => {
    let services: SessionServices;

    beforeEach(async () => {
      services = await createSessionServices({}, true);
    });

    it('should be defined in test mode', () => {
      expect(services.featureFlagRecorder).toBeDefined();
    });

    it('should record and retrieve enabled features', () => {
      const recorder = services.featureFlagRecorder!;
      recorder.record('dark-mode', true);
      expect(recorder.isEnabled('dark-mode')).toBe(true);
    });

    it('should record and retrieve disabled features', () => {
      const recorder = services.featureFlagRecorder!;
      recorder.record('beta-feature', false);
      expect(recorder.isEnabled('beta-feature')).toBe(false);
    });

    it('should return false for unknown features', () => {
      const recorder = services.featureFlagRecorder!;
      expect(recorder.isEnabled('nonexistent')).toBe(false);
    });

    it('should overwrite previous feature flag values', () => {
      const recorder = services.featureFlagRecorder!;
      recorder.record('toggle-feature', true);
      expect(recorder.isEnabled('toggle-feature')).toBe(true);

      recorder.record('toggle-feature', false);
      expect(recorder.isEnabled('toggle-feature')).toBe(false);
    });

    it('should handle multiple features independently', () => {
      const recorder = services.featureFlagRecorder!;
      recorder.record('feature-a', true);
      recorder.record('feature-b', false);
      recorder.record('feature-c', true);

      expect(recorder.isEnabled('feature-a')).toBe(true);
      expect(recorder.isEnabled('feature-b')).toBe(false);
      expect(recorder.isEnabled('feature-c')).toBe(true);
    });

    it('should handle empty string feature names', () => {
      const recorder = services.featureFlagRecorder!;
      recorder.record('', true);
      expect(recorder.isEnabled('')).toBe(true);
    });

    it('should handle feature names with special characters', () => {
      const recorder = services.featureFlagRecorder!;
      recorder.record('feature.with.dots', true);
      recorder.record('feature/with/slashes', false);
      expect(recorder.isEnabled('feature.with.dots')).toBe(true);
      expect(recorder.isEnabled('feature/with/slashes')).toBe(false);
    });
  });

  describe('Service Interface', () => {
    let services: SessionServices;

    beforeEach(async () => {
      services = await createSessionServices({}, false);
    });

    it('should have required notifier with notify method', () => {
      expect(services.notifier).toBeDefined();
      expect(typeof services.notifier.notify).toBe('function');
    });

    it('should have required notifier with error method', () => {
      expect(typeof services.notifier.error).toBe('function');
    });

    it('should have required notifier with success method', () => {
      expect(typeof services.notifier.success).toBe('function');
    });

    it('should have showRawAgentReasoning boolean', () => {
      expect(typeof services.showRawAgentReasoning).toBe('boolean');
    });

    it('should have rollout property (null by default)', () => {
      expect(services.rollout).toBeNull();
    });
  });

  describe('Test Mode vs Production Mode', () => {
    it('should create featureFlagRecorder in test mode but not production', async () => {
      const prodServices = await createSessionServices({}, false);
      const testServices = await createSessionServices({}, true);

      expect(prodServices.featureFlagRecorder).toBeUndefined();
      expect(testServices.featureFlagRecorder).toBeDefined();
    });

    it('should create same notifier type regardless of mode', async () => {
      const prodServices = await createSessionServices({}, false);
      const testServices = await createSessionServices({}, true);

      expect(prodServices.notifier).toBeDefined();
      expect(testServices.notifier).toBeDefined();
      expect(typeof prodServices.notifier.notify).toBe('function');
      expect(typeof testServices.notifier.notify).toBe('function');
    });

    it('should allow service override in test mode', async () => {
      const mockNotifier = {
        notify: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
      };

      const services = await createSessionServices(
        { notifier: mockNotifier as any },
        true
      );

      expect(services.notifier).toBe(mockNotifier);
    });
  });
});
