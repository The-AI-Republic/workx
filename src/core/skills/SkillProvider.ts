import type { Skill, SkillMeta } from './types';

/**
 * Platform-agnostic skill storage interface.
 * Implemented by IndexedDBSkillProvider (extension) and FilesystemSkillProvider (desktop).
 */
export interface ISkillProvider {
  /** Initialize the provider (create directories, open DB connections) */
  initialize(): Promise<void>;

  /** List all skill metadata (Level 1 — name + description + invocationMode) */
  listMeta(): Promise<SkillMeta[]>;

  /** Load a full skill by name (Level 2 — includes body) */
  load(name: string): Promise<Skill | null>;

  /** Load a referenced file from a skill (Level 3) */
  loadReference(skillName: string, refPath: string): Promise<string | null>;

  /** Save a skill (create or update) */
  save(skill: Skill): Promise<void>;

  /** Delete a skill by name */
  delete(name: string): Promise<void>;

  /** Check if a skill exists */
  exists(name: string): Promise<boolean>;

  /** Export a skill as standard-compliant SKILL.md content (no invocationMode) */
  exportAsSkillMd(name: string): Promise<string | null>;
}
