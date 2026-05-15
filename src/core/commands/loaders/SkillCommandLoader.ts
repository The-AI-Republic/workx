/**
 * SkillCommandLoader
 *
 * Adapts SkillRegistry's discovered SkillMeta entries into typed PromptCommand[]
 * for the new typed command surface. The PromptCommand returned here is a
 * lightweight wrapper — `getPromptForCommand` defers body load to invocation
 * time (matches SkillRegistry's Level 1 / Level 2 split).
 */

import type { SkillRegistry } from '@/core/skills/SkillRegistry';
import type { SkillMeta } from '@/core/skills/types';
import type { PromptCommand } from '../types';

export class SkillCommandLoader {
  constructor(private readonly skillRegistry: SkillRegistry) {}

  load(): PromptCommand[] {
    const metas = this.skillRegistry.getSkillMetas();
    return metas.map((meta) => this.toPromptCommand(meta));
  }

  private toPromptCommand(meta: SkillMeta): PromptCommand {
    const skillRegistry = this.skillRegistry;
    return {
      type: 'prompt',
      name: meta.name,
      description: meta.description,
      loadedFrom: 'skill',
      whenToUse: meta.whenToUse,
      argumentHint: meta.argumentHint,
      userInvocable: meta.userInvocable ?? true,
      disableModelInvocation: meta.disableModelInvocation ?? false,
      context: meta.context ?? 'inline',
      agent: meta.agent,
      domains: meta.domains,
      // model / effort / allowedTools / hooks live on the full Skill record;
      // they're not surfaced via SkillMeta to avoid loading the body just to list.
      async getPromptForCommand(args: string): Promise<string> {
        const argsArray = args ? args.split(/\s+/) : [];
        const body = await skillRegistry.invoke(meta.name, argsArray);
        if (body == null) {
          throw new Error(`Skill "${meta.name}" not found`);
        }
        return body;
      },
    };
  }
}
