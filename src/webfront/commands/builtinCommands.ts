import { push } from 'svelte-spa-router';
import { commandRegistry } from './CommandRegistry';
import type { SkillMeta } from '@/core/skills/types';
import { getInitializedUIClient } from '@/core/messaging';
import {
  getX402Config,
  saveX402Config,
  formatX402Cost,
  getX402PaymentCount,
  type PaymentNetwork,
} from '@/core/payments/x402';

export interface BuiltinCommandCallbacks {
  onNewConversation: () => void;
  onCommandOutput: (title: string, content: string) => void;
  onOpenSettings: () => void;
  /** Submit text to the agent as if the user sent it (Track 14 /plan). */
  onSubmitText: (text: string) => void;
  /** Track 15: open the rewind turn-selector overlay. */
  onOpenRewindSelector: () => void;
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

  // Track 15: /rewind (+ /checkpoint alias) open the turn-selector overlay.
  // The registry has no alias mechanism, so register two commands sharing
  // one action.
  for (const name of ['rewind', 'checkpoint']) {
    commandRegistry.register({
      name,
      description: 'Rewind the conversation to an earlier turn (forks a new branch)',
      loadedFrom: 'builtin',
      action: () => {
        activeCallbacks?.onOpenRewindSelector();
      },
    });
  }

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

  commandRegistry.register({
    name: 'x402',
    description: 'Configure x402 crypto micropayments (USDC) — disabled by default',
    argumentHint: '[status|enable|disable|set-limit|set-session|network|setup|remove]',
    whenToUse:
      'Manage automatic HTTP 402 payments for agent resource fetches (extension/desktop only; the server is config-driven).',
    loadedFrom: 'builtin',
    action: async (args?: string) => {
      const { title, content } = await runX402Command(args ?? '');
      activeCallbacks?.onCommandOutput(title, content);
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

const X402_NETWORKS: PaymentNetwork[] = [
  'base',
  'base-sepolia',
  'ethereum',
  'ethereum-sepolia',
];

const X402_HELP = `**x402 — HTTP 402 Crypto Micropayments (USDC)**

Disabled by default. The extension never holds a key (it surfaces 402s for
approval); desktop is the signer home; the server is config-driven (server.x402)
and is NOT managed here.

- \`/x402 status\` — show config + session spend
- \`/x402 enable\` / \`/x402 disable\`
- \`/x402 set-limit <usd>\` — max per request
- \`/x402 set-session <usd>\` — max per session
- \`/x402 network <${X402_NETWORKS.join('|')}>\`
- \`/x402 setup\` — show agent-side wallet provisioning guidance (never paste a key)
- \`/x402 remove\` — key custody is agent-side only, never over chat

Real payment signing is gated behind a security/legal review (design.md
Phase 4) — no real funds move before then.`;

async function runX402Command(
  rawArgs: string,
): Promise<{ title: string; content: string }> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();
  const title = 'x402';

  try {
    switch (sub) {
      case '':
      case 'help':
        return { title, content: X402_HELP };

      case 'status': {
        const c = await getX402Config();
        const spend = formatX402Cost();
        const lines = [
          `Enabled:         ${c.enabled ? 'Yes' : 'No'}`,
          `Network:         ${c.network}`,
          `Wallet:          ${c.address ?? 'Not configured'}`,
          `Max per request: $${c.maxPaymentPerRequestUSD.toFixed(2)}`,
          `Max per session: $${c.maxSessionSpendUSD.toFixed(2)}`,
          `Session payments: ${getX402PaymentCount()}`,
        ];
        if (spend) lines.push('', spend);
        return { title, content: lines.join('\n') };
      }

      case 'enable': {
        await saveX402Config({ enabled: true });
        return {
          title,
          content:
            'x402 enabled. Note: real signing is Phase-4 gated; without a configured ' +
            'wallet (desktop) or server.x402 allowlist (server) payments still safely decline.',
        };
      }

      case 'disable':
        await saveX402Config({ enabled: false });
        return { title, content: 'x402 disabled.' };

      case 'set-limit': {
        const n = parseFloat(parts[1] ?? '');
        if (!Number.isFinite(n) || n <= 0) {
          return { title, content: 'Usage: /x402 set-limit <usd>  (positive number)' };
        }
        await saveX402Config({ maxPaymentPerRequestUSD: n });
        return { title, content: `Max payment per request set to $${n.toFixed(2)}` };
      }

      case 'set-session': {
        const n = parseFloat(parts[1] ?? '');
        if (!Number.isFinite(n) || n <= 0) {
          return { title, content: 'Usage: /x402 set-session <usd>  (positive number)' };
        }
        await saveX402Config({ maxSessionSpendUSD: n });
        return { title, content: `Max session spend set to $${n.toFixed(2)}` };
      }

      case 'network': {
        const net = parts[1] as PaymentNetwork | undefined;
        if (!net || !X402_NETWORKS.includes(net)) {
          return {
            title,
            content: `Usage: /x402 network <${X402_NETWORKS.join('|')}>`,
          };
        }
        await saveX402Config({ network: net });
        return { title, content: `Network set to ${net}` };
      }

      case 'setup':
      case 'remove': {
        // Security: a private key must NEVER be passed through chat — the
        // conversation is persisted to history/rollout/logs. Key custody is
        // provisioned agent-side only.
        return {
          title,
          content:
            'Wallet key custody is not performed over chat (the conversation is ' +
            'persisted). Provision/remove the x402 key agent-side: desktop = OS ' +
            'keychain; server = the secrets-manager-backed credential store ' +
            '(server.x402 is config-driven). The extension never holds a key. ' +
            'Real signing stays gated until the Phase-4 security/legal review.',
        };
      }

      default:
        return { title, content: `Unknown subcommand '${sub}'.\n\n${X402_HELP}` };
    }
  } catch (err) {
    return {
      title,
      content: `x402 command failed: ${
        err instanceof Error ? err.message : String(err)
      }\n(This surface needs config/credential storage available in the current context.)`,
    };
  }
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
  await syncSkillCommands();
}

/**
 * Re-sync skill commands with the backend.
 * Unregisters stale commands and registers new ones.
 * Call this after creating, deleting, or changing skill invocation modes.
 */
export async function refreshSkillCommands(): Promise<void> {
  if (!storedOnSubmitText) return;
  await syncSkillCommands();
}

async function syncSkillCommands(): Promise<void> {
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
