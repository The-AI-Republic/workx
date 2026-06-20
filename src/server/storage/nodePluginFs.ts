/**
 * Node filesystem helpers for plugin slot loaders (server runtime).
 *
 * The slot loaders (`SkillSlotLoader`, `SubAgentSlotLoader`,
 * `CommandSlotLoader`) take injected `readFile` / `listDirs` functions so
 * they stay platform-agnostic. On the server these are backed by Node `fs`.
 */

import { promises as fs } from 'node:fs';

/** Read a UTF-8 file, returning null if it doesn't exist. */
export async function nodeReadFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/** List immediate directory entries (names only), [] if the dir is missing. */
export async function nodeListDirs(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}
