import { commandRegistry } from './CommandRegistry';
import type { SkillMeta } from '@/core/skills/types';
import { getInitializedUIClient } from '@/core/messaging';

export interface BuiltinCommandCallbacks {
  onNewConversation: () => void;
  onCommandOutput: (title: string, content: string) => void;
  onOpenSettings: () => void;
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

  // Track 10: /plugin slash command. Subcommands parsed inside the action
  // (webfront splits only on first space, so the rest is `args`).
  commandRegistry.register({
    name: 'plugin',
    description: 'Manage plugins: list | info <id> | enable <id> | disable <id> | reload',
    argumentHint: '<subcommand> [id]',
    loadedFrom: 'builtin',
    action: (args?: string) => {
      void handlePluginCommand(args ?? '');
    },
  });
}

/** Render + dispatch for the `/plugin` command. */
async function handlePluginCommand(rawArgs: string): Promise<void> {
  const out = (title: string, content: string) =>
    activeCallbacks?.onCommandOutput(title, content);

  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'list').toLowerCase();
  const id = parts[1];

  try {
    const client = await getInitializedUIClient();

    switch (sub) {
      case 'list': {
        const rows = await client.serviceRequest<
          Array<{ id: string; version: string; scope: string; status: string; errorVariant?: string }>
        >('plugins.list');
        if (!rows || rows.length === 0) {
          out('Plugins', 'No plugins installed.');
          return;
        }
        const glyph = (s: string) =>
          s === 'enabled' ? '✓' : s === 'error' ? '⚠' : s === 'disabled' ? '○' : '…';
        const lines = rows.map(
          (r) =>
            `${glyph(r.status)} ${r.id}  v${r.version}  ${r.scope}  ${r.status}` +
            (r.errorVariant ? `  (${r.errorVariant})` : ''),
        );
        const enabled = rows.filter((r) => r.status === 'enabled').length;
        const errored = rows.filter((r) => r.status === 'error').length;
        out(
          'Installed plugins',
          `${lines.join('\n')}\n\n${rows.length} plugins · ${enabled} enabled · ${errored} error`,
        );
        return;
      }

      case 'info': {
        if (!id) {
          out('Plugin', 'Usage: /plugin info <id>');
          return;
        }
        const info = await client.serviceRequest<{
          error?: string;
          id: string;
          version: string;
          description?: string;
          scope: string;
          status: string;
          source: string;
          capabilities: Record<string, boolean>;
          loadErrors: string[];
        }>('plugins.info', { id });
        if (!info || info.error) {
          out('Plugin', info?.error ?? `Plugin not found: ${id}`);
          return;
        }
        const caps = Object.entries(info.capabilities)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ') || 'none';
        const errs =
          info.loadErrors.length > 0
            ? `\n\nLoad errors:\n${info.loadErrors.map((e) => `  - ${e}`).join('\n')}`
            : '\n\nNo load errors.';
        out(
          `${info.id} (v${info.version})`,
          `${info.description ?? ''}\n` +
            `Source: ${info.source}\n` +
            `Scope: ${info.scope}\n` +
            `Status: ${info.status}\n\n` +
            `Capabilities: ${caps}${errs}`,
        );
        return;
      }

      case 'enable': {
        if (!id) {
          out('Plugin', 'Usage: /plugin enable <id>');
          return;
        }
        const res = await client.serviceRequest<{
          success: boolean;
          error?: string;
          loadErrors?: string[];
        }>('plugins.enable', { id });
        if (res?.success) {
          out('Plugin', `✓ Enabled ${id}. Effective on next message.`);
        } else {
          const detail = res?.loadErrors?.length
            ? `\n${res.loadErrors.map((e) => `  - ${e}`).join('\n')}`
            : '';
          out('Plugin', `✗ Failed to enable ${id}: ${res?.error ?? 'unknown'}${detail}`);
        }
        return;
      }

      case 'disable': {
        if (!id) {
          out('Plugin', 'Usage: /plugin disable <id>');
          return;
        }
        const res = await client.serviceRequest<{ success: boolean; error?: string }>(
          'plugins.disable',
          { id },
        );
        out(
          'Plugin',
          res?.success
            ? `✓ Disabled ${id}.`
            : `✗ Failed to disable ${id}: ${res?.error ?? 'unknown'}`,
        );
        return;
      }

      case 'reload': {
        const res = await client.serviceRequest<{
          success: boolean;
          error?: string;
          enabled?: Array<{ id: string }>;
          errors?: string[];
        }>('plugins.reload');
        if (res?.success) {
          const n = res.enabled?.length ?? 0;
          const errs = res.errors?.length
            ? `\n${res.errors.map((e) => `  - ${e}`).join('\n')}`
            : '';
          out('Plugin', `Reloaded ${n} plugin(s).${errs}`);
        } else {
          out('Plugin', `✗ Cannot reload: ${res?.error ?? 'unknown'}`);
        }
        return;
      }

      case 'install': {
        if (!id) {
          out('Plugin', 'Usage: /plugin install <id>@<marketplace>');
          return;
        }
        const res = await client.serviceRequest<{
          success: boolean;
          error?: string;
          installed?: string[];
        }>('plugins.install', { id });
        if (res?.success) {
          const n = res.installed?.length ?? 1;
          out(
            'Plugin',
            `✓ Installed ${id}${n > 1 ? ` + ${n - 1} dependency(ies)` : ''}.\n` +
              `Run /plugin enable ${id} to activate.`,
          );
        } else {
          out('Plugin', `✗ Install failed: ${res?.error ?? 'unknown'}`);
        }
        return;
      }

      case 'uninstall': {
        if (!id) {
          out('Plugin', 'Usage: /plugin uninstall <id>');
          return;
        }
        const res = await client.serviceRequest<{ success: boolean; error?: string }>(
          'plugins.uninstall',
          { id },
        );
        out(
          'Plugin',
          res?.success
            ? `✓ Uninstalled ${id}. Files marked for cleanup (7-day grace).`
            : `✗ Uninstall failed: ${res?.error ?? 'unknown'}`,
        );
        return;
      }

      case 'marketplace':
      case 'market': {
        const action = parts[1];
        const target = parts.slice(2).join(' ');
        if (action === 'add') {
          const res = await client.serviceRequest<{ success: boolean; name?: string; error?: string }>(
            'plugins.marketplace.add',
            { url: target },
          );
          out(
            'Plugin',
            res?.success
              ? `✓ Added marketplace "${res.name}".`
              : `✗ ${res?.error ?? 'add failed'}`,
          );
        } else if (action === 'remove' || action === 'rm') {
          const res = await client.serviceRequest<{ success: boolean }>(
            'plugins.marketplace.remove',
            { name: target },
          );
          out('Plugin', res?.success ? `✓ Removed marketplace "${target}".` : `✗ Not found: ${target}`);
        } else {
          const rows = await client.serviceRequest<
            Array<{ name: string; sourceRef: string; pluginCount: number }>
          >('plugins.marketplace.list');
          if (!rows || rows.length === 0) {
            out('Plugin', 'No marketplaces added. /plugin marketplace add <url>');
          } else {
            out(
              'Marketplaces',
              rows
                .map((r) => `- ${r.name} (${r.pluginCount} plugins) — ${r.sourceRef}`)
                .join('\n'),
            );
          }
        }
        return;
      }

      default:
        out(
          'Plugin',
          `Unknown subcommand "${sub}". Usage: /plugin list | info <id> | enable <id> | ` +
            `disable <id> | reload | install <id>@<mkt> | uninstall <id> | marketplace add|list|remove`,
        );
    }
  } catch (e) {
    out('Plugin', `Error: ${e instanceof Error ? e.message : String(e)}`);
  }
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
