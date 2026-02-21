/**
 * Unit tests for encryption utilities
 */

import { describe, it, expect } from 'vitest';
import { encryptApiKey, decryptApiKey } from '@/utils/encryption.js';

describe('encryption utilities', () => {
  describe('encryptApiKey', () => {
    it('should encrypt a plain text API key', () => {
      const plainText = 'sk-ant-api03-test-key-12345';
      const encrypted = encryptApiKey(plainText);

      // Should not equal original
      expect(encrypted).not.toBe(plainText);

      // Should be base64 encoded (contains only valid base64 characters)
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    });

    it('should produce different output than input', () => {
      const plainText = 'sk-test-key';
      const encrypted = encryptApiKey(plainText);

      expect(encrypted).not.toBe(plainText);
    });

    it('should handle empty strings', () => {
      const encrypted = encryptApiKey('');
      expect(encrypted).toBe('');
    });

    it('should produce consistent output for same input', () => {
      const plainText = 'sk-ant-api03-test';
      const encrypted1 = encryptApiKey(plainText);
      const encrypted2 = encryptApiKey(plainText);

      expect(encrypted1).toBe(encrypted2);
    });

    it('should handle special characters', () => {
      const plainText = 'sk-ant-api03-!@#$%^&*()';
      const encrypted = encryptApiKey(plainText);

      expect(encrypted).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    });

    it('should handle long API keys', () => {
      const plainText = 'sk-ant-api03-' + 'a'.repeat(100);
      const encrypted = encryptApiKey(plainText);

      expect(encrypted).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(encrypted.length).toBeGreaterThan(0);
    });
  });

  describe('decryptApiKey', () => {
    it('should decrypt an encrypted API key', () => {
      const plainText = 'sk-ant-api03-test-key-12345';
      const encrypted = encryptApiKey(plainText);
      const decrypted = decryptApiKey(encrypted);

      expect(decrypted).toBe(plainText);
    });

    it('should return null for empty string', () => {
      const result = decryptApiKey('');
      expect(result).toBeNull();
    });

    it('should return null for invalid base64', () => {
      const result = decryptApiKey('not-valid-base64-!!!');
      expect(result).toBeNull();
    });

    it('should handle round-trip encryption/decryption', () => {
      const testCases = [
        'sk-ant-api03-short',
        'sk-ant-api03-' + 'x'.repeat(50),
        'sk-test-123',
        'sk-ant-api03-!@#$%^&*()',
      ];

      testCases.forEach(plainText => {
        const encrypted = encryptApiKey(plainText);
        const decrypted = decryptApiKey(encrypted);
        expect(decrypted).toBe(plainText);
      });
    });

    it('should handle API keys', () => {
      const openaiKey = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz';
      const encrypted = encryptApiKey(openaiKey);
      const decrypted = decryptApiKey(encrypted);

      expect(decrypted).toBe(openaiKey);
    });

    it('should handle Anthropic API keys', () => {
      const anthropicKey = 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz';
      const encrypted = encryptApiKey(anthropicKey);
      const decrypted = decryptApiKey(encrypted);

      expect(decrypted).toBe(anthropicKey);
    });

    it('should not throw on malformed input', () => {
      expect(() => decryptApiKey('$%^&*()')).not.toThrow();
      expect(decryptApiKey('$%^&*()')).toBeNull();
    });
  });

  describe('encryption/decryption integration', () => {
    it('should maintain data integrity through multiple cycles', () => {
      const original = 'sk-ant-api03-test-key';

      // Multiple encryption/decryption cycles
      let current = original;
      for (let i = 0; i < 5; i++) {
        const encrypted = encryptApiKey(current);
        const decrypted = decryptApiKey(encrypted);
        expect(decrypted).toBe(original);
        current = original; // Reset for next cycle
      }
    });

    it('should handle edge case: single character', () => {
      const plainText = 'a';
      const encrypted = encryptApiKey(plainText);
      const decrypted = decryptApiKey(encrypted);

      expect(decrypted).toBe(plainText);
    });
  });
});
