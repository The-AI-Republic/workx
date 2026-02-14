import { describe, it, expect } from 'vitest';

// These imports will initially fail because the implementations don't exist yet
import {
  validateAgentConfig,
  validateModel,
  validateApprovalPolicy,
  validateSandboxPolicy,
  validateReasoningConfig,
  validateProfileName,
  isValidModel,
  isValidApprovalPolicy,
  sanitizeConfig
} from '@/config/validators';
import type { AgentConfigData, SandboxPolicy, AskForApproval } from '@/config/types';

describe('Config Validators', () => {
  describe('validateAgentConfig', () => {
    it('should validate a complete valid configuration', () => {
      const validConfig: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' },
        reasoning: {
          effort: { effort: 'medium' },
          summary: { enabled: true }
        },
        cwd: '/home/user/workspace'
      };

      expect(() => validateAgentConfig(validConfig)).not.toThrow();
    });

    it('should reject configuration with invalid model', () => {
      const invalidConfig = {
        model: 'invalid-model-name',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' }
      };

      expect(() => validateAgentConfig(invalidConfig)).toThrow('Invalid model');
    });

    it('should reject configuration with invalid approval policy', () => {
      const invalidConfig = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'invalid-policy',
        sandbox_policy: { mode: 'read-only' }
      };

      expect(() => validateAgentConfig(invalidConfig)).toThrow('Invalid approval policy');
    });

    it('should reject configuration with invalid sandbox policy', () => {
      const invalidConfig = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'invalid-mode' }
      };

      expect(() => validateAgentConfig(invalidConfig)).toThrow('Invalid sandbox policy');
    });

    it('should validate minimal configuration with defaults', () => {
      const minimalConfig = {
        model: 'claude-3-5-sonnet-20241022'
      };

      expect(() => validateAgentConfig(minimalConfig)).not.toThrow();
    });
  });

  describe('validateModel', () => {
    it('should accept valid Claude models', () => {
      const validModels = [
        'claude-3-5-sonnet-20241022',
        'claude-3-haiku-20240307',
        'claude-3-opus-20240229',
        'claude-3-5-haiku-20241022'
      ];

      validModels.forEach(model => {
        expect(() => validateModel(model)).not.toThrow();
        expect(isValidModel(model)).toBe(true);
      });
    });

    it('should reject invalid model names', () => {
      const invalidModels = [
        '',
        'gpt-4',
        'invalid-model',
        'claude-2',
        null,
        undefined
      ];

      invalidModels.forEach(model => {
        expect(() => validateModel(model as string)).toThrow('Invalid model');
        expect(isValidModel(model as string)).toBe(false);
      });
    });

    it('should handle model versioning correctly', () => {
      expect(isValidModel('claude-3-5-sonnet-20241022')).toBe(true);
      expect(isValidModel('claude-3-5-sonnet-20240101')).toBe(false); // Invalid date
    });
  });

  describe('validateApprovalPolicy', () => {
    it('should accept valid approval policies', () => {
      const validPolicies: AskForApproval[] = [
        'untrusted',
        'on-failure',
        'on-request',
        'never'
      ];

      validPolicies.forEach(policy => {
        expect(() => validateApprovalPolicy(policy)).not.toThrow();
        expect(isValidApprovalPolicy(policy)).toBe(true);
      });
    });

    it('should reject invalid approval policies', () => {
      const invalidPolicies = [
        'always',
        'sometimes',
        'invalid-policy',
        '',
        null,
        undefined
      ];

      invalidPolicies.forEach(policy => {
        expect(() => validateApprovalPolicy(policy as AskForApproval)).toThrow('Invalid approval policy');
        expect(isValidApprovalPolicy(policy as AskForApproval)).toBe(false);
      });
    });
  });

  describe('validateSandboxPolicy', () => {
    it('should accept valid sandbox policies', () => {
      const validPolicies: SandboxPolicy[] = [
        { mode: 'danger-full-access' },
        { mode: 'read-only' },
        {
          mode: 'workspace-write',
          writable_roots: ['/tmp', '/workspace'],
          network_access: true
        },
        {
          mode: 'workspace-write',
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: false
        }
      ];

      validPolicies.forEach(policy => {
        expect(() => validateSandboxPolicy(policy)).not.toThrow();
      });
    });

    it('should reject invalid sandbox policies', () => {
      const invalidPolicies = [
        { mode: 'invalid-mode' },
        { mode: 'workspace-write', writable_roots: 'not-an-array' },
        { mode: 'workspace-write', network_access: 'not-boolean' },
        {},
        null,
        undefined
      ];

      invalidPolicies.forEach(policy => {
        expect(() => validateSandboxPolicy(policy as SandboxPolicy)).toThrow('Invalid sandbox policy');
      });
    });

    it('should validate workspace-write policy options', () => {
      const validWorkspacePolicy: SandboxPolicy = {
        mode: 'workspace-write',
        writable_roots: ['/valid/path', '/another/path'],
        network_access: false
      };

      expect(() => validateSandboxPolicy(validWorkspacePolicy)).not.toThrow();

      const invalidWorkspacePolicy = {
        mode: 'workspace-write',
        writable_roots: [123, 'valid/path'], // Invalid path type
        network_access: true
      };

      expect(() => validateSandboxPolicy(invalidWorkspacePolicy as SandboxPolicy))
        .toThrow('Invalid sandbox policy');
    });
  });

  describe('validateReasoningConfig', () => {
    it('should accept valid reasoning configurations', () => {
      const validConfigs = [
        {
          effort: { effort: 'low' as const },
          summary: { enabled: true }
        },
        {
          effort: { effort: 'medium' as const },
          summary: { enabled: false }
        },
        {
          effort: { effort: 'high' as const },
          summary: { enabled: true }
        }
      ];

      validConfigs.forEach(config => {
        expect(() => validateReasoningConfig(config)).not.toThrow();
      });
    });

    it('should reject invalid reasoning configurations', () => {
      const invalidConfigs = [
        {
          effort: { effort: 'extreme' }, // Invalid effort level
          summary: { enabled: true }
        },
        {
          effort: { effort: 'medium' },
          summary: { enabled: 'yes' } // Invalid enabled type
        },
        {
          effort: 'medium', // Wrong structure
          summary: { enabled: true }
        }
      ];

      invalidConfigs.forEach(config => {
        expect(() => validateReasoningConfig(config as any)).toThrow();
      });
    });

    it('should handle optional reasoning configuration', () => {
      expect(() => validateReasoningConfig(undefined)).not.toThrow();
      expect(() => validateReasoningConfig(null)).toThrow();
    });
  });

  describe('validateProfileName', () => {
    it('should accept valid profile names', () => {
      const validNames = [
        'default',
        'development',
        'production',
        'my-profile',
        'profile_123',
        'Profile.Name'
      ];

      validNames.forEach(name => {
        expect(() => validateProfileName(name)).not.toThrow();
      });
    });

    it('should reject invalid profile names', () => {
      const invalidNames = [
        '',
        '   ',
        'profile/with/slash',
        'profile\\with\\backslash',
        'profile with spaces',
        'profile\nwith\nnewlines',
        'profile\twith\ttabs',
        null,
        undefined
      ];

      invalidNames.forEach(name => {
        expect(() => validateProfileName(name as string)).toThrow('Invalid profile name');
      });
    });

    it('should enforce profile name length limits', () => {
      const tooLong = 'a'.repeat(256);
      expect(() => validateProfileName(tooLong)).toThrow('Profile name too long');

      const maxLength = 'a'.repeat(255);
      expect(() => validateProfileName(maxLength)).not.toThrow();
    });
  });

  describe('sanitizeConfig', () => {
    it('should remove unknown properties from configuration', () => {
      const dirtyConfig = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' },
        unknownProperty: 'should be removed',
        anotherUnknown: 123
      };

      const clean = sanitizeConfig(dirtyConfig);

      expect(clean).toHaveProperty('model');
      expect(clean).toHaveProperty('approval_policy');
      expect(clean).toHaveProperty('sandbox_policy');
      expect(clean).not.toHaveProperty('unknownProperty');
      expect(clean).not.toHaveProperty('anotherUnknown');
    });

    it('should preserve valid nested properties', () => {
      const configWithNested = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: {
          mode: 'workspace-write',
          writable_roots: ['/tmp'],
          network_access: true,
          unknownNested: 'should be removed'
        },
        reasoning: {
          effort: { effort: 'medium' },
          summary: { enabled: true },
          unknownReasoning: 'should be removed'
        }
      };

      const clean = sanitizeConfig(configWithNested);

      expect(clean.sandbox_policy).toEqual({
        mode: 'workspace-write',
        writable_roots: ['/tmp'],
        network_access: true
      });

      expect(clean.reasoning).toEqual({
        effort: { effort: 'medium' },
        summary: { enabled: true }
      });
    });

    it('should handle null and undefined values', () => {
      const configWithNulls = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: null,
        sandbox_policy: undefined,
        reasoning: {
          effort: null,
          summary: { enabled: true }
        }
      };

      const clean = sanitizeConfig(configWithNulls);

      expect(clean.model).toBe('claude-3-5-sonnet-20241022');
      expect(clean.approval_policy).toBeNull();
      expect(clean.sandbox_policy).toBeUndefined();
      expect(clean.reasoning?.effort).toBeNull();
      expect(clean.reasoning?.summary).toEqual({ enabled: true });
    });
  });
});