import type { HookRegistry } from '@/core/hooks/HookRegistry';
import type { TurnContext } from '@/core/TurnContext';
import { SkillRiskAssessor } from '@/core/approval/assessors/SkillRiskAssessor';
import type { SkillRegistry } from './SkillRegistry';
import { SkillExecutor } from './SkillExecutor';
import { buildSubAgentInvoker } from './buildSubAgentInvoker';
import { matchesDomain } from './SkillDomainFilter';
import type { ToolRegistry } from '@/tools/ToolRegistry';

export interface RegisterUseSkillToolOptions {
  toolRegistry: ToolRegistry;
  hookRegistry: HookRegistry;
  skillRegistry: SkillRegistry;
  getTurnContext?: () => TurnContext;
  /** Resolve browser state only after the model has selected use_skill. */
  getCurrentDomain?: () => Promise<string | null>;
}

export async function registerUseSkillTool(options: RegisterUseSkillToolOptions): Promise<boolean> {
  const { toolRegistry, hookRegistry, skillRegistry, getTurnContext, getCurrentDomain } = options;

  const allSkills = skillRegistry.getAllSkillMetas();
  if (allSkills.length === 0) return false;
  if (toolRegistry.getTool('use_skill')) return false;

  await toolRegistry.register(
    {
      type: 'function',
      function: {
        name: 'use_skill',
        description: 'Invoke a user-defined skill by name. When the user types /skill-name, call this tool with that name. Also use proactively when an auto-invocable skill is relevant. Returns the skill body with instructions to follow.',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The skill name to invoke' },
            arguments: { type: 'string', description: 'Optional space-separated arguments for the skill' },
          },
          required: ['name'],
        },
      },
    },
    async (params, ctx) => {
      const skillName = params.name as string;
      const args = params.arguments as string | undefined;
      const meta = skillRegistry.getAllSkillMetas().find((skill) => skill.name === skillName);
      const restrictedDomains = meta?.domains?.filter(
        (domain) => domain !== '*' && domain !== '**',
      ) ?? [];
      if (restrictedDomains.length > 0) {
        const currentDomain = await getCurrentDomain?.().catch(() => null) ?? null;
        const allowed = currentDomain !== null
          && restrictedDomains.some((pattern) => matchesDomain(currentDomain, pattern));
        if (!allowed) {
          return {
            error: currentDomain
              ? `Skill "${skillName}" is not available on ${currentDomain}. Allowed browser domains: ${restrictedDomains.join(', ')}.`
              : `Skill "${skillName}" requires an active browser page on one of these domains: ${restrictedDomains.join(', ')}.`,
          };
        }
      }
      const subAgentInvoker = buildSubAgentInvoker(toolRegistry, ctx);
      const executor = new SkillExecutor(skillRegistry, hookRegistry, subAgentInvoker);
      const result = await executor.execute(skillName, args);

      if (result.status === 'inline') {
        getTurnContext?.()?.setActiveToolAllowList(result.allowedTools);
        return result.body;
      }
      if (result.status === 'forked') {
        if (!result.success && result.error) return { error: result.error };
        return result.result;
      }
      return { error: result.error };
    },
    {
      riskAssessor: new SkillRiskAssessor(skillRegistry),
      exposure: {
        source: 'skill',
        mode: 'always',
        displayName: 'Use Skill',
        searchHint: allSkills.map((skill) => `${skill.name} ${skill.description ?? ''}`).join(' '),
      },
    },
  );

  return true;
}
