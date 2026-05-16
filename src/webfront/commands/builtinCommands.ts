import { push } from 'svelte-spa-router';
import { commandRegistry } from './CommandRegistry';
import type { SkillMeta } from '@/core/skills/types';
import { getInitializedUIClient } from '@/core/messaging';

export interface BuiltinCommandCallbacks {
  onNewConversation: () => void;
  onCommandOutput: (title: string, content: string) => void;
  onOpenSettings: () => void;
  /** Submit text to the agent as if the user sent it (Track 14 /plan). */
  onSubmitText: (text: string) => void;
  onOpenDoctor: () => void;
}

/** Mutable reference that always points to the live component's callbacks. */
let activeCallbacks: BuiltinCommandCallbacks | null = null;

export function initBuiltinCommands(callbacks: BuiltinCommandCallbacks): void {
  // Always update the reference so command actions use the live component,
  // even after a remount (the singleton registry survives component destroy).
  activeCallbacks = callbacks;

  // Only register once — the actions read from activeCallbacks, not from
  // the captured `callbacks` parameter, so they stay current.
  if (commandRegistry.has('new')) return;

  commandRegistry.register({
    name: 'new',
    description: 'Reset the current conversation',
    loadedFrom: 'builtin',
    action: () => {
      activeCallbacks?.onNewConversation();
    },
  });

  commandRegistry.register({
    name: 'help',
    description: 'List all available commands',
    loadedFrom: 'builtin',
    action: () => {
      const commands = commandRegistry.getAll();
      const lines = commands.map((cmd) => {
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
        const usage = cmd.whenToUse ? `\n  _${cmd.whenToUse}_` : '';
        return `**/${cmd.name}**${hint} — ${cmd.description}${usage}`;
      });
      activeCallbacks?.onCommandOutput('Available Commands', lines.join('\n'));
    },
  });

  commandRegistry.register({
    name: 'settings',
    description: 'Open the settings panel',
    loadedFrom: 'builtin',
    action: () => {
      activeCallbacks?.onOpenSettings();
    },
  });

  commandRegistry.register({
    name: 'plan',
    description: 'Plan review: explore read-only and approve a plan before acting',
    argumentHint: '<task>',
    whenToUse:
      'Use when you want the agent to propose a complete plan and freeze all ' +
      'state-changing actions until you approve it.',
    loadedFrom: 'builtin',
    action: (args?: string) => {
      const task = (args ?? '').trim();
      const directive = task
        ? 'Enter plan review for the following task. Call the BeginPlan tool, ' +
          'then explore the page read-only to understand what is needed, and ' +
          'present a complete plan via SubmitPlanForReview for my approval ' +
          'before doing anything that changes state.\n\nTask: ' +
          task
        : 'Enter plan review: call the BeginPlan tool, explore read-only to ' +
          'understand the current task, then present a complete plan via ' +
          'SubmitPlanForReview for my approval before changing anything.';
      activeCallbacks?.onSubmitText(directive);
    },
  });

  commandRegistry.register({
    name: 'doctor',
    description: 'Run operational diagnostics and show a health report',
    whenToUse:
      'When the agent is misbehaving — checks config, credentials, channels, MCP, skills, and the scheduler.',
    loadedFrom: 'builtin',
    action: () => {
      activeCallbacks?.onOpenDoctor();
    },
  });

  // Track 18: /cost and /usage both open the usage dashboard (which shows
  // cumulative USD, per-model and per-day cost). The registry has no alias
  // field, so register both; the has('new') guard above keeps it idempotent.
  commandRegistry.register({
    name: 'cost',
    description: 'Show session and historical USD cost',
    loadedFrom: 'builtin',
    action: () => {
      push('/usage');
    },
  });

  commandRegistry.register({
    name: 'usage',
    description: 'Show token & cost usage dashboard',
    loadedFrom: 'builtin',
    action: () => {
      push('/usage');
    },
  });
}

/** Track which command names were registered by the skill system */
const registeredSkillNames = new Set<string>();

/** Stored callback from first registerSkillCommands() call */
let storedOnSubmitText: ((text: string) => void) | null = null;

/**
 * Load skills from the backend and register manual/hybrid ones as commands.
 * Called after builtins are initialized. Stores the callback for refreshSkillCommands().
 */
export async function registerSkillCommands(
  onSubmitText: (text: string) => void
): Promise<void> {
  storedOnSubmitText = onSubmitText;
  await syncSkillCommands(onSubmitText);
}

/**
 * Re-sync skill commands with the backend.
 * Unregisters stale commands and registers new ones.
 * Call this after creating, deleting, or changing skill invocation modes.
 */
export async function refreshSkillCommands(): Promise<void> {
  if (!storedOnSubmitText) return;
  await syncSkillCommands(storedOnSubmitText);
}

async function syncSkillCommands(
  onSubmitText: (text: string) => void
): Promise<void> {
  try {
    const skills = await (await getInitializedUIClient()).serviceRequest<SkillMeta[]>('skills.list');
    const currentSkillNames = new Set<string>();

    if (skills?.length) {
      for (const skill of skills) {
        // Only register manual/hybrid skills as / commands
        if (skill.invocationMode === 'auto') continue;
        currentSkillNames.add(skill.name);
      }
    }

    // Unregister skills that were removed or switched to auto mode
    for (const name of registeredSkillNames) {
      if (!currentSkillNames.has(name)) {
        commandRegistry.unregister(name);
        registeredSkillNames.delete(name);
      }
    }

    // Register new skills
    for (const skill of skills ?? []) {
      if (skill.invocationMode === 'auto') continue;
      if (commandRegistry.has(skill.name)) continue;

      const name = skill.name;
      commandRegistry.register({
        name,
        description: skill.description,
        argumentHint: '$ARGUMENTS',
        loadedFrom: 'skill',
        action: (args?: string) => {
          storedOnSubmitText?.(`/${name}${args ? ' ' + args : ''}`);
        },
      });
      registeredSkillNames.add(name);
    }
  } catch (error) {
    console.warn('[builtinCommands] Failed to register skill commands:', error);
  }
}
