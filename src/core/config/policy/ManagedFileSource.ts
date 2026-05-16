/**
 * ManagedFileSource — admin policy from an OS-protected JSON file (Track 20).
 *
 * The desktop/server analog of the extension's `chrome.storage.managed`. The
 * file is a `{ values, lockedKeys }` document at an OS well-known path the
 * user cannot normally write to. Fail-open: a missing/invalid/unreadable file
 * yields no policy (never a hard-deny).
 *
 * `node:fs` is imported lazily so this module is safe to load in any context
 * (a webview without `node:fs` simply yields no policy).
 *
 * @module core/config/policy/ManagedFileSource
 */

import type { PolicySource, ResolvedPolicy } from './types';

/** OS well-known managed-settings path per platform. */
export function defaultManagedFilePath(): string {
  const plat = (globalThis as { process?: { platform?: string } }).process
    ?.platform;
  if (plat === 'darwin') {
    return '/Library/Application Support/ApplePi/managed-settings.json';
  }
  if (plat === 'win32') {
    const programData =
      (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.ProgramData ?? 'C:\\ProgramData';
    return `${programData}\\ApplePi\\managed-settings.json`;
  }
  return '/etc/applepi/managed-settings.json';
}

function coerce(raw: unknown, origin: 'file'): ResolvedPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const values =
    obj.values && typeof obj.values === 'object' && !Array.isArray(obj.values)
      ? (obj.values as Record<string, unknown>)
      : {};
  const lockedKeys = Array.isArray(obj.lockedKeys)
    ? obj.lockedKeys.filter((k): k is string => typeof k === 'string')
    : [];
  if (Object.keys(values).length === 0 && lockedKeys.length === 0) return null;
  return { values, lockedKeys, origin };
}

export class ManagedFileSource implements PolicySource {
  readonly origin = 'file' as const;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultManagedFilePath();
  }

  async load(): Promise<ResolvedPolicy | null> {
    try {
      const fs = await import('node:fs/promises');
      const text = await fs.readFile(this.filePath, 'utf-8');
      return coerce(JSON.parse(text), 'file');
    } catch {
      // Missing file, parse error, or no node:fs (webview) — fail open.
      return null;
    }
  }

  /**
   * Watch the file for changes. Uses `node:fs.watch` when available; callers
   * that already own a reload seam (the server's `onConfigReload`) need not
   * use this. Returns a no-op unsubscribe if watching is unavailable.
   */
  subscribe(onChange: () => void): () => void {
    let watcher: { close(): void } | undefined;
    void (async () => {
      try {
        const fs = await import('node:fs');
        watcher = fs.watch(this.filePath, { persistent: false }, () =>
          onChange()
        );
      } catch {
        /* no fs / no file — rely on the platform's own reload seam */
      }
    })();
    return () => {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    };
  }
}
