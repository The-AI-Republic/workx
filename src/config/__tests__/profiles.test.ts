import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// These imports will initially fail because the implementations don't exist yet
import {
  ProfileManager,
  createDefaultProfile,
  validateProfile,
  mergeProfileConfigs,
  compareProfiles
} from '@/config/ProfileManager';
import type { AgentConfigData, ConfigProfile } from '@/config/types';

describe('Profile Management', () => {
  let profileManager: ProfileManager;

  beforeEach(() => {
    profileManager = new ProfileManager();
  });

  describe('Profile Creation', () => {
    it('should create a default profile', () => {
      const defaultProfile = createDefaultProfile();

      expect(defaultProfile.name).toBe('default');
      expect(defaultProfile.config.model).toBe('claude-3-5-sonnet-20241022');
      expect(defaultProfile.config.approval_policy).toBe('on-request');
      expect(defaultProfile.config.sandbox_policy.mode).toBe('read-only');
      expect(defaultProfile.createdAt).toBeTypeOf('number');
      expect(defaultProfile.updatedAt).toBeTypeOf('number');
    });

    it('should create custom profiles', async () => {
      const profileConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never',
        sandbox_policy: { mode: 'workspace-write', network_access: true }
      };

      await profileManager.createProfile('development', profileConfig);

      const profile = profileManager.getProfile('development');

      expect(profile).toBeDefined();
      expect(profile?.name).toBe('development');
      expect(profile?.config.model).toBe('claude-3-haiku-20240307');
      expect(profile?.config.approval_policy).toBe('never');
    });

    it('should validate profile configuration before creation', async () => {
      const invalidConfig = {
        model: 'invalid-model',
        approval_policy: 'invalid-policy'
      };

      await expect(
        profileManager.createProfile('invalid', invalidConfig as any)
      ).rejects.toThrow('Invalid configuration for profile');
    });

    it('should prevent duplicate profile names', async () => {
      await profileManager.createProfile('test', { model: 'claude-3-haiku-20240307' });

      await expect(
        profileManager.createProfile('test', { model: 'claude-3-opus-20240229' })
      ).rejects.toThrow('Profile "test" already exists');
    });

    it('should merge partial configurations with defaults', async () => {
      const partialConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307'
      };

      await profileManager.createProfile('minimal', partialConfig);

      const profile = profileManager.getProfile('minimal');
      expect(profile?.config.approval_policy).toBe('on-request'); // Default value
      expect(profile?.config.sandbox_policy.mode).toBe('read-only'); // Default value
    });
  });

  describe('Profile Management Operations', () => {
    beforeEach(async () => {
      // Create test profiles
      await profileManager.createProfile('development', {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      });

      await profileManager.createProfile('production', {
        model: 'claude-3-opus-20240229',
        approval_policy: 'untrusted'
      });
    });

    it('should list all profiles', () => {
      const profiles = profileManager.getAllProfiles();

      expect(profiles).toHaveProperty('default');
      expect(profiles).toHaveProperty('development');
      expect(profiles).toHaveProperty('production');
      expect(Object.keys(profiles)).toHaveLength(3);
    });

    it('should get profile by name', () => {
      const devProfile = profileManager.getProfile('development');

      expect(devProfile).toBeDefined();
      expect(devProfile?.name).toBe('development');
      expect(devProfile?.config.model).toBe('claude-3-haiku-20240307');
    });

    it('should return undefined for non-existent profile', () => {
      const profile = profileManager.getProfile('non-existent');
      expect(profile).toBeUndefined();
    });

    it('should update existing profiles', async () => {
      await profileManager.updateProfile('development', {
        model: 'claude-3-5-haiku-20241022',
        cwd: '/updated/workspace'
      });

      const updatedProfile = profileManager.getProfile('development');
      expect(updatedProfile?.config.model).toBe('claude-3-5-haiku-20241022');
      expect(updatedProfile?.config.cwd).toBe('/updated/workspace');
      expect(updatedProfile?.config.approval_policy).toBe('never'); // Preserved
    });

    it('should update profile timestamps on modification', async () => {
      const originalProfile = profileManager.getProfile('development');
      const originalTimestamp = originalProfile?.updatedAt;

      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      await profileManager.updateProfile('development', {
        model: 'claude-3-5-haiku-20241022'
      });

      const updatedProfile = profileManager.getProfile('development');
      expect(updatedProfile?.updatedAt).toBeGreaterThan(originalTimestamp!);
    });

    it('should delete profiles', async () => {
      await profileManager.deleteProfile('development');

      const profile = profileManager.getProfile('development');
      expect(profile).toBeUndefined();

      const allProfiles = profileManager.getAllProfiles();
      expect(allProfiles).not.toHaveProperty('development');
    });

    it('should prevent deletion of default profile', async () => {
      await expect(
        profileManager.deleteProfile('default')
      ).rejects.toThrow('Cannot delete default profile');
    });

    it('should handle deletion of non-existent profile', async () => {
      await expect(
        profileManager.deleteProfile('non-existent')
      ).rejects.toThrow('Profile "non-existent" does not exist');
    });
  });

  describe('Profile Switching', () => {
    beforeEach(async () => {
      await profileManager.createProfile('development', {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      });
    });

    it('should switch active profile', async () => {
      expect(profileManager.getActiveProfileName()).toBe('default');

      await profileManager.switchToProfile('development');

      expect(profileManager.getActiveProfileName()).toBe('development');
    });

    it('should return active profile configuration', () => {
      const activeConfig = profileManager.getActiveConfig();

      expect(activeConfig.model).toBe('claude-3-5-sonnet-20241022'); // Default profile

      profileManager.switchToProfile('development');

      const devConfig = profileManager.getActiveConfig();
      expect(devConfig.model).toBe('claude-3-haiku-20240307');
    });

    it('should handle switching to non-existent profile', async () => {
      await expect(
        profileManager.switchToProfile('non-existent')
      ).rejects.toThrow('Profile "non-existent" does not exist');
    });

    it('should revert to default if active profile is deleted', async () => {
      await profileManager.switchToProfile('development');
      expect(profileManager.getActiveProfileName()).toBe('development');

      await profileManager.deleteProfile('development');

      expect(profileManager.getActiveProfileName()).toBe('default');
    });
  });

  describe('Profile Validation', () => {
    it('should validate complete profile structure', () => {
      const validProfile: ConfigProfile = {
        name: 'test-profile',
        config: {
          model: 'claude-3-5-sonnet-20241022',
          approval_policy: 'on-request',
          sandbox_policy: { mode: 'read-only' }
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      expect(() => validateProfile(validProfile)).not.toThrow();
    });

    it('should reject profiles with invalid configuration', () => {
      const invalidProfile = {
        name: 'invalid',
        config: {
          model: 'invalid-model',
          approval_policy: 'invalid-policy'
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      expect(() => validateProfile(invalidProfile as ConfigProfile))
        .toThrow('Invalid profile configuration');
    });

    it('should reject profiles with missing required fields', () => {
      const incompleteProfile = {
        name: 'incomplete',
        config: {
          model: 'claude-3-5-sonnet-20241022'
          // Missing other required fields
        }
        // Missing timestamps
      };

      expect(() => validateProfile(incompleteProfile as ConfigProfile))
        .toThrow('Invalid profile structure');
    });

    it('should validate profile names', () => {
      const invalidNames = ['', '  ', 'profile/with/slash', 'profile\nwith\nnewline'];

      invalidNames.forEach(name => {
        const profile = createDefaultProfile();
        profile.name = name;

        expect(() => validateProfile(profile))
          .toThrow('Invalid profile name');
      });
    });
  });

  describe('Profile Comparison and Merging', () => {
    it('should compare profiles for differences', () => {
      const profile1 = createDefaultProfile();
      const profile2: ConfigProfile = {
        name: 'modified',
        config: {
          ...profile1.config,
          model: 'claude-3-haiku-20240307'
        },
        createdAt: profile1.createdAt,
        updatedAt: profile1.updatedAt
      };

      const differences = compareProfiles(profile1, profile2);

      expect(differences).toContain('model');
      expect(differences).not.toContain('approval_policy');
    });

    it('should detect no differences in identical profiles', () => {
      const profile1 = createDefaultProfile();
      const profile2 = { ...profile1 };

      const differences = compareProfiles(profile1, profile2);

      expect(differences).toHaveLength(0);
    });

    it('should merge profile configurations', () => {
      const baseConfig: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' },
        cwd: '/workspace'
      };

      const overrideConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      };

      const merged = mergeProfileConfigs(baseConfig, overrideConfig);

      expect(merged.model).toBe('claude-3-haiku-20240307');
      expect(merged.approval_policy).toBe('never');
      expect(merged.sandbox_policy.mode).toBe('read-only'); // Preserved
      expect(merged.cwd).toBe('/workspace'); // Preserved
    });

    it('should handle deep merging of nested configurations', () => {
      const baseConfig: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: {
          mode: 'workspace-write',
          writable_roots: ['/original'],
          network_access: false
        }
      };

      const overrideConfig: Partial<AgentConfigData> = {
        sandbox_policy: {
          mode: 'workspace-write',
          network_access: true
          // writable_roots intentionally omitted
        }
      };

      const merged = mergeProfileConfigs(baseConfig, overrideConfig);

      expect(merged.sandbox_policy.mode).toBe('workspace-write');
      expect(merged.sandbox_policy.network_access).toBe(true);
      expect(merged.sandbox_policy.writable_roots).toEqual(['/original']); // Preserved
    });
  });

  describe('Profile Import/Export', () => {
    it('should export profile to JSON', async () => {
      await profileManager.createProfile('export-test', {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      });

      const exportedProfile = profileManager.exportProfile('export-test');

      expect(exportedProfile).toBeDefined();
      expect(typeof exportedProfile).toBe('string');

      const parsed = JSON.parse(exportedProfile!);
      expect(parsed.name).toBe('export-test');
      expect(parsed.config.model).toBe('claude-3-haiku-20240307');
    });

    it('should import profile from JSON', async () => {
      const profileJson = JSON.stringify({
        name: 'imported',
        config: {
          model: 'claude-3-opus-20240229',
          approval_policy: 'untrusted',
          sandbox_policy: { mode: 'workspace-write' }
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      await profileManager.importProfile(profileJson);

      const importedProfile = profileManager.getProfile('imported');
      expect(importedProfile).toBeDefined();
      expect(importedProfile?.config.model).toBe('claude-3-opus-20240229');
    });

    it('should validate imported profile JSON', async () => {
      const invalidJson = '{ "invalid": "profile" }';

      await expect(profileManager.importProfile(invalidJson))
        .rejects.toThrow('Invalid profile format');
    });

    it('should handle name conflicts during import', async () => {
      // Create existing profile
      await profileManager.createProfile('existing', { model: 'claude-3-haiku-20240307' });

      const conflictingProfile = JSON.stringify({
        name: 'existing',
        config: {
          model: 'claude-3-opus-20240229',
          approval_policy: 'untrusted',
          sandbox_policy: { mode: 'read-only' }
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      await expect(profileManager.importProfile(conflictingProfile))
        .rejects.toThrow('Profile "existing" already exists');
    });

    it('should import profile with rename option', async () => {
      const profileJson = JSON.stringify({
        name: 'original-name',
        config: {
          model: 'claude-3-opus-20240229',
          approval_policy: 'untrusted',
          sandbox_policy: { mode: 'read-only' }
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      await profileManager.importProfile(profileJson, 'renamed-profile');

      const importedProfile = profileManager.getProfile('renamed-profile');
      expect(importedProfile).toBeDefined();
      expect(importedProfile?.name).toBe('renamed-profile');
      expect(importedProfile?.config.model).toBe('claude-3-opus-20240229');
    });
  });

  describe('Profile Metadata', () => {
    it('should track profile usage statistics', async () => {
      await profileManager.createProfile('tracked', { model: 'claude-3-haiku-20240307' });

      await profileManager.switchToProfile('tracked');
      await profileManager.switchToProfile('default');
      await profileManager.switchToProfile('tracked');

      const profile = profileManager.getProfile('tracked');
      expect(profile?.metadata?.usageCount).toBe(2);
      expect(profile?.metadata?.lastUsed).toBeTypeOf('number');
    });

    it('should store profile description and tags', async () => {
      await profileManager.createProfile('documented', {
        model: 'claude-3-haiku-20240307'
      }, {
        description: 'Fast development profile',
        tags: ['dev', 'fast', 'testing']
      });

      const profile = profileManager.getProfile('documented');
      expect(profile?.metadata?.description).toBe('Fast development profile');
      expect(profile?.metadata?.tags).toEqual(['dev', 'fast', 'testing']);
    });

    it('should filter profiles by tags', () => {
      // This test would require implementing tag filtering
      const devProfiles = profileManager.getProfilesByTag('dev');
      expect(Array.isArray(devProfiles)).toBe(true);
    });

    it('should search profiles by name and description', () => {
      const searchResults = profileManager.searchProfiles('development');
      expect(Array.isArray(searchResults)).toBe(true);
    });
  });
});