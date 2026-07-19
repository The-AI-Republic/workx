import type { SkillRegistry } from './SkillRegistry';
import type { SkillMeta } from './types';
import { matchesDomain } from './SkillDomainFilter';

/** Pure per-session projection; never mutates the global skill catalog. */
export class SessionSkillView {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly hostname: () => Promise<string | null>,
  ) {}

  async getVisibleMetas(): Promise<SkillMeta[]> {
    const hostname = (await this.hostname())?.toLowerCase() ?? null;
    return this.registry.getAllSkillMetas().filter((skill) => {
      const patterns = skill.domains?.filter((domain) => domain !== '*' && domain !== '**');
      if (!patterns || patterns.length === 0) return true;
      return hostname !== null && patterns.some((pattern) => matchesDomain(hostname, pattern));
    });
  }

  async buildSystemPrompt(): Promise<string> {
    return this.registry.buildSkillsSystemPrompt(await this.getVisibleMetas());
  }
}
