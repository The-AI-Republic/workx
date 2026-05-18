import { describe, it, expect } from 'vitest';
import {
  sanitizeToolName,
  boundedEnum,
  numericOnly,
  errorClass,
} from '../sanitize';

describe('telemetry core: sanitize', () => {
  it('sanitizeToolName collapses MCP names, passes builtins', () => {
    expect(sanitizeToolName('mcp__browser__scroll') as unknown).toBe(
      'mcp_tool',
    );
    expect(sanitizeToolName('mcp__slack__send') as unknown).toBe('mcp_tool');
    expect(sanitizeToolName('planning_tool') as unknown).toBe('planning_tool');
    expect(sanitizeToolName('sub_agent') as unknown).toBe('sub_agent');
  });

  it('boundedEnum passes members, collapses unknowns to other', () => {
    const allowed = ['running', 'completed', 'failed'] as const;
    expect(boundedEnum('running', allowed) as unknown).toBe('running');
    expect(boundedEnum('weird', allowed) as unknown).toBe('other');
    expect(boundedEnum(undefined, allowed)).toBeUndefined();
  });

  it('numericOnly accepts finite numbers only', () => {
    expect(numericOnly(42)).toBe(42);
    expect(numericOnly(0)).toBe(0);
    expect(numericOnly(NaN)).toBeUndefined();
    expect(numericOnly(Infinity)).toBeUndefined();
    expect(numericOnly('5')).toBeUndefined();
    expect(numericOnly(undefined)).toBeUndefined();
  });

  it('errorClass returns the class name, never the message', () => {
    expect(errorClass(new TypeError('secret /etc/passwd')) as unknown).toBe(
      'TypeError',
    );
    expect(errorClass(new Error('http://token@host')) as unknown).toBe(
      'Error',
    );
    expect(errorClass('a string') as unknown).toBe('string');
    expect(errorClass(null)).toBeUndefined();
    expect(errorClass(undefined)).toBeUndefined();
  });
});
