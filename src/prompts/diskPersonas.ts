/**
 * Filesystem persona scanner (Track 24.2) — Node-only.
 *
 * Imported solely by Node entrypoints (the server bootstrap). It is NOT
 * imported by `PersonaLoader` or any browser/extension bundle, so `node:fs`
 * never reaches a web build.
 *
 * @module prompts/diskPersonas
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePersona, type Persona } from './PersonaLoader';

function scanDir(dir: string): Persona[] {
  const out: Persona[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir absent / unreadable — fine, just no overrides
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, 'utf-8');
      out.push(parsePersona(raw, entry.replace(/\.md$/, '')));
    } catch {
      // Skip an unreadable/garbled file rather than fail the whole scan.
    }
  }
  return out;
}

/**
 * Scan persona directories in LOWEST-to-HIGHEST precedence order so the
 * returned list can be handed straight to `registerExternalPersonas`
 * (later entries overwrite earlier). Given `[userDir, projectDir]`, project
 * personas win over user, and both win over built-ins.
 */
export function scanDiskPersonas(dirsLowToHigh: string[]): Persona[] {
  const result: Persona[] = [];
  for (const dir of dirsLowToHigh) {
    result.push(...scanDir(dir));
  }
  return result;
}
