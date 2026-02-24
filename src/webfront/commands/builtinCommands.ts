import { commandRegistry } from './CommandRegistry';
import type { SkillMeta } from '@/core/skills/types';
import { sendMessage, MessageType } from '../lib/messaging';

export interface BuiltinCommandCallbacks {
  onNewConversation: () => void;
  onCommandOutput: (title: string, content: string) => void;
  onOpenSettings: () => void;
}

export function initBuiltinCommands(callbacks: BuiltinCommandCallbacks): void {
  if (commandRegistry.has('new')) return;

  commandRegistry.register({
    name: 'new',
    description: 'Reset the current conversation',
    action: () => {
      callbacks.onNewConversation();
    },
  });

  commandRegistry.register({
    name: 'help',
    description: 'List all available commands',
    action: () => {
      const commands = commandRegistry.getAll();
      const lines = commands.map((cmd) => {
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
        return `**/${cmd.name}**${hint} — ${cmd.description}`;
      });
      callbacks.onCommandOutput('Available Commands', lines.join('\n'));
    },
  });

  commandRegistry.register({
    name: 'settings',
    description: 'Open the settings panel',
    action: () => {
      callbacks.onOpenSettings();
    },
  });
}

/**
 * Load skills from the backend and register manual/hybrid ones as commands.
 * Called after builtins are initialized. Safe to call multiple times —
 * skips already-registered names.
 */
export async function registerSkillCommands(
  onSkillInvoked: (name: string, body: string) => void
): Promise<void> {
  try {
    const skills = await sendMessage<SkillMeta[]>(MessageType.SKILLS_LIST);
    if (!skills?.length) return;

    for (const skill of skills) {
      // Only register manual/hybrid skills as / commands
      if (skill.invocationMode === 'auto') continue;
      // Skip if name conflicts with existing command
      if (commandRegistry.has(skill.name)) continue;

      const name = skill.name;
      commandRegistry.register({
        name,
        description: skill.description,
        argumentHint: '$ARGUMENTS',
        action: async (args?: string) => {
          const body = await sendMessage<string | null>(MessageType.SKILLS_LOAD, { name, args });
          if (body) {
            onSkillInvoked(name, body);
          }
        },
      });
    }
  } catch (error) {
    console.warn('[builtinCommands] Failed to register skill commands:', error);
  }
}
