/**
 * ManagedDirSource — `managed-settings.d/` drop-in directory (Track 20, Phase 4).
 *
 * The OS-MDM matrix's testable, dependency-free slice: a directory of
 * `*.json` policy fragments merged in deterministic (sorted filename) order —
 * later files override earlier `values`; `lockedKeys` is the union. The
 * macOS-plist / Windows-registry sources are the remaining P3/L subprocess
 * tier (they need a real OS + `plutil`/`reg`), tracked separately; this source
 * lands the Linux/admin-drop-in form behind the same {@link PolicySource}
 * interface with zero contract changes to Phases 1–3.
 *
 * Fail-open: a missing dir, no fragments, or unreadable/invalid files yield
 * no policy (never a hard-deny). `node:fs` is imported lazily so this module
 * is safe to load in any context.
 *
 * @module core/config/policy/ManagedDirSource
 */

import type { PolicySource, ResolvedPolicy } from './types';

export function defaultManagedDirPath(): string {
  const plat = (globalThis as { process?: { platform?: string } }).process
    ?.platform;
  if (plat === 'darwin') {
    return '/Library/Application Support/WorkX/managed-settings.d';
  }
  if (plat === 'win32') {
    const programData =
      (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.ProgramData ?? 'C:\\ProgramData';
    return `${programData}\\WorkX\\managed-settings.d`;
  }
  return '/etc/workx/managed-settings.d';
}

export class ManagedDirSource implements PolicySource {
  readonly origin = 'file' as const;
  private readonly dirPath: string;

  constructor(dirPath?: string) {
    this.dirPath = dirPath ?? defaultManagedDirPath();
  }

  async load(): Promise<ResolvedPolicy | null> {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const entries = (await fs.readdir(this.dirPath))
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .sort(); // deterministic merge order

      const values: Record<string, unknown> = {};
      const lockedKeys = new Set<string>();
      for (const name of entries) {
        try {
          const raw = JSON.parse(
            await fs.readFile(path.join(this.dirPath, name), 'utf-8')
          ) as Record<string, unknown>;
          if (raw && typeof raw.values === 'object' && !Array.isArray(raw.values)) {
            Object.assign(values, raw.values);
          }
          if (Array.isArray(raw?.lockedKeys)) {
            for (const k of raw.lockedKeys) {
              if (typeof k === 'string') lockedKeys.add(k);
            }
          }
        } catch {
          /* skip a single bad fragment — fail open */
        }
      }

      if (Object.keys(values).length === 0 && lockedKeys.size === 0) {
        return null;
      }
      return { values, lockedKeys: [...lockedKeys], origin: 'file' };
    } catch {
      return null; // no dir / no node:fs — fail open
    }
  }
}
