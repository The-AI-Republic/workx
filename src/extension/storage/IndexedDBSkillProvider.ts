import type { StorageProvider } from '@/core/storage/StorageProvider';
import type { ISkillProvider } from '@/core/skills/SkillProvider';
import type { Skill, SkillMeta } from '@/core/skills/types';
import { serializeToSkillMd } from '@/core/skills/SkillParser';

const COLLECTION = 'skills';

/**
 * IndexedDB-backed skill provider for Chrome extension.
 * Uses the existing StorageProvider with a 'skills' collection.
 */
export class IndexedDBSkillProvider implements ISkillProvider {
  constructor(private storageProvider: StorageProvider) {}

  async initialize(): Promise<void> {
    // StorageProvider handles IndexedDB initialization
  }

  async listMeta(): Promise<SkillMeta[]> {
    const skills = await this.storageProvider.list<Skill>(COLLECTION);
    return skills.map((s) => ({
      name: s.name,
      description: s.description,
      invocationMode: s.invocationMode,
      trusted: s.trusted,
      source: s.source,
    }));
  }

  async load(name: string): Promise<Skill | null> {
    return this.storageProvider.get<Skill>(COLLECTION, name);
  }

  async loadReference(skillName: string, refPath: string): Promise<string | null> {
    const skill = await this.load(skillName);
    if (!skill) return null;
    const withRefs = skill as Skill & { references?: Record<string, string> };
    return withRefs.references?.[refPath] ?? null;
  }

  async save(skill: Skill): Promise<void> {
    await this.storageProvider.set(COLLECTION, skill.name, skill);
  }

  async delete(name: string): Promise<void> {
    await this.storageProvider.delete(COLLECTION, name);
  }

  async exists(name: string): Promise<boolean> {
    const skill = await this.storageProvider.get(COLLECTION, name);
    return skill !== null;
  }

  async exportAsSkillMd(name: string): Promise<string | null> {
    const skill = await this.load(name);
    if (!skill) return null;
    return serializeToSkillMd(skill);
  }
}
