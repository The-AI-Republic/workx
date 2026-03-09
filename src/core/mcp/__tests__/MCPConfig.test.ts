/**
 * Unit tests for MCPConfig validation schemas
 * Task: T013 [US1]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MCPServerNameSchema,
  MCPServerUrlSchema,
  MCPTimeoutSchema,
  MCPTransportTypeSchema,
  MCPPlatformScopeSchema,
  MCPServerConfigSchema,
  MCPServerConfigCreateSchema,
  MCPServerConfigUpdateSchema,
  createServerConfig,
  updateServerConfig,
  validateServerConfig,
} from '../MCPConfig';
import type { IMCPServerConfig, IMCPServerConfigCreate } from '../types';

describe('MCPConfig Validation Schemas', () => {
  describe('MCPServerNameSchema', () => {
    it('should accept valid server names', () => {
      const validNames = ['github', 'my-server', 'Server123', 'a', 'test-server-1'];

      for (const name of validNames) {
        expect(() => MCPServerNameSchema.parse(name)).not.toThrow();
      }
    });

    it('should reject empty names', () => {
      expect(() => MCPServerNameSchema.parse('')).toThrow();
    });

    it('should reject names over 50 characters', () => {
      const longName = 'a'.repeat(51);
      expect(() => MCPServerNameSchema.parse(longName)).toThrow();
    });

    it('should accept names exactly 50 characters', () => {
      const name50 = 'a'.repeat(50);
      expect(() => MCPServerNameSchema.parse(name50)).not.toThrow();
    });

    it('should reject names with special characters', () => {
      const invalidNames = ['my server', 'server@name', 'server.name', 'server_name', 'server!'];

      for (const name of invalidNames) {
        expect(() => MCPServerNameSchema.parse(name)).toThrow();
      }
    });

    it('should reject names with only whitespace', () => {
      expect(() => MCPServerNameSchema.parse('   ')).toThrow();
    });
  });

  describe('MCPServerUrlSchema', () => {
    it('should accept valid HTTP URLs', () => {
      const validUrls = [
        'http://localhost:3000',
        'http://example.com/mcp',
        'https://api.example.com/v1/mcp',
        'https://example.com:8080/mcp',
      ];

      for (const url of validUrls) {
        expect(() => MCPServerUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should reject invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'ftp://example.com',
        'ws://example.com',
        'example.com/mcp',
        '/relative/path',
      ];

      for (const url of invalidUrls) {
        expect(() => MCPServerUrlSchema.parse(url)).toThrow();
      }
    });

    it('should reject empty URLs', () => {
      expect(() => MCPServerUrlSchema.parse('')).toThrow();
    });
  });

  describe('MCPTimeoutSchema', () => {
    it('should accept valid timeout values', () => {
      const validTimeouts = [5000, 30000, 60000, 120000];

      for (const timeout of validTimeouts) {
        expect(() => MCPTimeoutSchema.parse(timeout)).not.toThrow();
      }
    });

    it('should reject timeouts below 5000ms', () => {
      expect(() => MCPTimeoutSchema.parse(4999)).toThrow();
      expect(() => MCPTimeoutSchema.parse(1000)).toThrow();
      expect(() => MCPTimeoutSchema.parse(0)).toThrow();
    });

    it('should reject timeouts above 180000ms', () => {
      expect(() => MCPTimeoutSchema.parse(180001)).toThrow();
      expect(() => MCPTimeoutSchema.parse(300000)).toThrow();
    });

    it('should default to 30000ms if not provided', () => {
      const result = MCPTimeoutSchema.parse(undefined);
      expect(result).toBe(30000);
    });

    it('should accept exactly 5000ms and 180000ms', () => {
      expect(() => MCPTimeoutSchema.parse(5000)).not.toThrow();
      expect(() => MCPTimeoutSchema.parse(180000)).not.toThrow();
    });
  });

  describe('MCPServerConfigSchema', () => {
    const validConfig: IMCPServerConfig = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'github',
      url: 'https://mcp.github.example.com',
      enabled: true,
      timeout: 30000,
      transport: 'sse' as const,
      platform: 'shared' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    it('should accept valid complete configuration', () => {
      expect(() => MCPServerConfigSchema.parse(validConfig)).not.toThrow();
    });

    it('should accept configuration with optional apiKey', () => {
      const configWithKey = { ...validConfig, apiKey: 'encrypted:abc123' };
      expect(() => MCPServerConfigSchema.parse(configWithKey)).not.toThrow();
    });

    it('should reject invalid UUID', () => {
      const invalidConfig = { ...validConfig, id: 'not-a-uuid' };
      expect(() => MCPServerConfigSchema.parse(invalidConfig)).toThrow();
    });

    it('should reject missing required fields', () => {
      const { name, ...missingName } = validConfig;
      expect(() => MCPServerConfigSchema.parse(missingName)).toThrow();
    });

    it('should default url to empty string when not provided', () => {
      const { url, ...noUrl } = validConfig;
      const result = MCPServerConfigSchema.parse(noUrl);
      expect(result.url).toBe('');
    });

    it('should accept transport and platform fields', () => {
      const configWithTransport = {
        ...validConfig,
        transport: 'stdio' as const,
        platform: 'desktop' as const,
        command: 'npx',
        args: ['chrome-devtools-mcp'],
      };
      expect(() => MCPServerConfigSchema.parse(configWithTransport)).not.toThrow();
    });

    it('should default transport to sse and platform to shared', () => {
      const result = MCPServerConfigSchema.parse(validConfig);
      expect(result.transport).toBe('sse');
      expect(result.platform).toBe('shared');
    });

    it('should accept builtin flag', () => {
      const builtinConfig = { ...validConfig, builtin: true };
      const result = MCPServerConfigSchema.parse(builtinConfig);
      expect(result.builtin).toBe(true);
    });
  });

  describe('MCPTransportTypeSchema', () => {
    it('should accept sse and stdio', () => {
      expect(() => MCPTransportTypeSchema.parse('sse')).not.toThrow();
      expect(() => MCPTransportTypeSchema.parse('stdio')).not.toThrow();
    });

    it('should reject invalid transport types', () => {
      expect(() => MCPTransportTypeSchema.parse('websocket')).toThrow();
      expect(() => MCPTransportTypeSchema.parse('')).toThrow();
    });
  });

  describe('MCPPlatformScopeSchema', () => {
    it('should accept shared, extension, desktop, and server', () => {
      expect(() => MCPPlatformScopeSchema.parse('shared')).not.toThrow();
      expect(() => MCPPlatformScopeSchema.parse('extension')).not.toThrow();
      expect(() => MCPPlatformScopeSchema.parse('desktop')).not.toThrow();
      expect(() => MCPPlatformScopeSchema.parse('server')).not.toThrow();
    });

    it('should reject invalid platform scopes', () => {
      expect(() => MCPPlatformScopeSchema.parse('web')).toThrow();
      expect(() => MCPPlatformScopeSchema.parse('')).toThrow();
    });
  });

  describe('MCPServerConfigCreateSchema', () => {
    it('should accept valid SSE create input', () => {
      const input: IMCPServerConfigCreate = {
        name: 'github',
        url: 'https://mcp.github.example.com',
      };

      const result = MCPServerConfigCreateSchema.parse(input);

      expect(result.name).toBe('github');
      expect(result.url).toBe('https://mcp.github.example.com');
      expect(result.enabled).toBe(true); // default
      expect(result.timeout).toBe(30000); // default
      expect(result.transport).toBe('sse'); // default
      expect(result.platform).toBe('shared'); // default
    });

    it('should accept valid stdio create input', () => {
      const input = {
        name: 'browser',
        transport: 'stdio' as const,
        platform: 'desktop' as const,
        command: 'npx',
        args: ['chrome-devtools-mcp'],
      };

      const result = MCPServerConfigCreateSchema.parse(input);

      expect(result.name).toBe('browser');
      expect(result.transport).toBe('stdio');
      expect(result.command).toBe('npx');
      expect(result.args).toEqual(['chrome-devtools-mcp']);
    });

    it('should reject SSE transport without url', () => {
      const input = {
        name: 'github',
        transport: 'sse' as const,
        // no url
      };

      expect(() => MCPServerConfigCreateSchema.parse(input)).toThrow();
    });

    it('should reject stdio transport without command', () => {
      const input = {
        name: 'browser',
        transport: 'stdio' as const,
        // no command
      };

      expect(() => MCPServerConfigCreateSchema.parse(input)).toThrow();
    });

    it('should accept all optional fields', () => {
      const input = {
        name: 'github',
        url: 'https://mcp.github.example.com',
        apiKey: 'secret-key',
        enabled: false,
        timeout: 60000,
      };

      const result = MCPServerConfigCreateSchema.parse(input);

      expect(result.enabled).toBe(false);
      expect(result.timeout).toBe(60000);
      expect(result.apiKey).toBe('secret-key');
    });

    it('should not require id, createdAt, or updatedAt', () => {
      const input = {
        name: 'github',
        url: 'https://mcp.github.example.com',
      };

      expect(() => MCPServerConfigCreateSchema.parse(input)).not.toThrow();
    });
  });

  describe('MCPServerConfigUpdateSchema', () => {
    it('should accept partial updates', () => {
      expect(() => MCPServerConfigUpdateSchema.parse({ name: 'new-name' })).not.toThrow();
      expect(() => MCPServerConfigUpdateSchema.parse({ url: 'https://new.example.com' })).not.toThrow();
      expect(() => MCPServerConfigUpdateSchema.parse({ enabled: false })).not.toThrow();
      expect(() => MCPServerConfigUpdateSchema.parse({ timeout: 60000 })).not.toThrow();
    });

    it('should accept transport and platform updates', () => {
      expect(() => MCPServerConfigUpdateSchema.parse({ transport: 'stdio' })).not.toThrow();
      expect(() => MCPServerConfigUpdateSchema.parse({ platform: 'desktop' })).not.toThrow();
      expect(() => MCPServerConfigUpdateSchema.parse({ command: 'npx', args: ['mcp-server'] })).not.toThrow();
    });

    it('should accept empty update object', () => {
      expect(() => MCPServerConfigUpdateSchema.parse({})).not.toThrow();
    });

    it('should still validate field values', () => {
      expect(() => MCPServerConfigUpdateSchema.parse({ name: '' })).toThrow();
      expect(() => MCPServerConfigUpdateSchema.parse({ timeout: 1000 })).toThrow();
    });
  });
});

describe('MCPConfig Functions', () => {
  describe('createServerConfig', () => {
    it('should create a valid server config with generated ID and timestamps', () => {
      const input: IMCPServerConfigCreate = {
        name: 'github',
        url: 'https://mcp.github.example.com',
      };

      const result = createServerConfig(input, []);

      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(result.name).toBe('github');
      expect(result.url).toBe('https://mcp.github.example.com');
      expect(result.enabled).toBe(true);
      expect(result.timeout).toBe(30000);
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBe(result.createdAt);
    });

    it('should throw on duplicate server name', () => {
      const existingServers: IMCPServerConfig[] = [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'github',
          url: 'https://old.example.com',
          enabled: true,
          timeout: 30000,
          transport: 'sse' as const,
          platform: 'shared' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const input: IMCPServerConfigCreate = {
        name: 'GitHub', // Case-insensitive match
        url: 'https://new.example.com',
      };

      expect(() => createServerConfig(input, existingServers)).toThrow(
        /already exists/i
      );
    });

    it('should allow same name with different case if not existing', () => {
      const existingServers: IMCPServerConfig[] = [];

      const input: IMCPServerConfigCreate = {
        name: 'GitHub',
        url: 'https://example.com',
      };

      expect(() => createServerConfig(input, existingServers)).not.toThrow();
    });
  });

  describe('updateServerConfig', () => {
    const existingConfig: IMCPServerConfig = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'github',
      url: 'https://mcp.github.example.com',
      enabled: true,
      timeout: 30000,
      transport: 'sse',
      platform: 'shared',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    };

    it('should update specified fields and updatedAt timestamp', () => {
      const updated = updateServerConfig(
        existingConfig,
        { name: 'new-name', enabled: false },
        [existingConfig]
      );

      expect(updated.name).toBe('new-name');
      expect(updated.enabled).toBe(false);
      expect(updated.url).toBe(existingConfig.url); // unchanged
      expect(updated.updatedAt).toBeGreaterThan(existingConfig.updatedAt);
    });

    it('should throw on duplicate name during update', () => {
      const otherServer: IMCPServerConfig = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'other-server',
        url: 'https://other.example.com',
        enabled: true,
        timeout: 30000,
        transport: 'sse',
        platform: 'shared',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const allServers = [existingConfig, otherServer];

      expect(() =>
        updateServerConfig(existingConfig, { name: 'other-server' }, allServers)
      ).toThrow(/already exists/i);
    });

    it('should allow keeping the same name', () => {
      const updated = updateServerConfig(
        existingConfig,
        { name: 'github' },
        [existingConfig]
      );

      expect(updated.name).toBe('github');
    });

    it('should preserve createdAt timestamp', () => {
      const updated = updateServerConfig(existingConfig, { name: 'new-name' }, [
        existingConfig,
      ]);

      expect(updated.createdAt).toBe(existingConfig.createdAt);
    });
  });

  describe('validateServerConfig', () => {
    it('should return success for valid input', () => {
      const result = validateServerConfig({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should return error for invalid input', () => {
      const result = validateServerConfig({
        name: '',
        url: 'not-a-url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return formatted error messages', () => {
      const result = validateServerConfig({
        name: '',
        url: 'https://valid.url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });
  });
});
