/**
 * FileCredentialStore
 *
 * Server-mode credential store using encrypted JSON on disk.
 * Follows the FileConfigStorageProvider pattern with AES-256-GCM encryption.
 *
 * Credentials stored at: $PI_DATA_DIR/credentials.enc
 *
 * @module server/storage/FileCredentialStore
 */

import type { CredentialStore } from '@/core/storage/CredentialStore';

/** Internal structure: service → account → password */
interface CredentialData {
  [service: string]: {
    [account: string]: string;
  };
}

export class FileCredentialStore implements CredentialStore {
  private filePath: string;
  private data: CredentialData;
  private encryptionKey: Buffer | null = null;

  constructor(dataDir: string) {
    const { join } = require('node:path');
    this.filePath = join(dataDir, 'credentials.enc');
    this.data = this.load();
  }

  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // Use VITE_VAULT_SECRET environment variable as key material
    const secret = process.env.VITE_VAULT_SECRET;
    if (!secret) {
      throw new Error('VITE_VAULT_SECRET not set — required for credential encryption');
    }

    const crypto = require('node:crypto');
    this.encryptionKey = crypto.scryptSync(secret, 'pi-server-credentials', 32);
    return this.encryptionKey;
  }

  private load(): CredentialData {
    try {
      const { existsSync, readFileSync } = require('node:fs');
      if (!existsSync(this.filePath)) return {};

      const raw = readFileSync(this.filePath);
      if (raw.length < 28) return {}; // IV (12) + tag (16) minimum

      const crypto = require('node:crypto');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8'));
    } catch (error) {
      console.warn('[FileCredentialStore] Failed to read credentials, starting fresh:', error);
      return {};
    }
  }

  private persist(): void {
    try {
      const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
      const { dirname } = require('node:path');
      const crypto = require('node:crypto');

      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
      const plaintext = Buffer.from(JSON.stringify(this.data), 'utf-8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      // Format: IV (12 bytes) + auth tag (16 bytes) + ciphertext
      writeFileSync(this.filePath, Buffer.concat([iv, tag, ciphertext]), { mode: 0o600 });
    } catch (error) {
      console.error('[FileCredentialStore] Failed to write credentials:', error);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.data[service]?.[account] ?? null;
  }

  async set(service: string, account: string, password: string): Promise<void> {
    if (!this.data[service]) {
      this.data[service] = {};
    }
    this.data[service][account] = password;
    this.persist();
  }

  async delete(service: string, account: string): Promise<void> {
    if (this.data[service]) {
      delete this.data[service][account];
      if (Object.keys(this.data[service]).length === 0) {
        delete this.data[service];
      }
      this.persist();
    }
  }

  async listAccounts(service: string): Promise<string[]> {
    return Object.keys(this.data[service] ?? {});
  }
}
