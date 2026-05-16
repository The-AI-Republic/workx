import { commandRegistry } from './CommandRegistry';
import type { SkillMeta } from '@/core/skills/types';
import { getInitializedUIClient } from '@/core/messaging';
import {
  getX402Config,
  saveX402Config,
  formatX402Cost,
  getX402PaymentCount,
  PaymentKeyStore,
  type PaymentNetwork,
} from '@/core/payments/x402';

export interface BuiltinCommandCallbacks {
  onNewConversation: () => void;
  onCommandOutput: (title: string, content: string) => void;
  onOpenSettings: () => void;
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
- \`/x402 setup <0x-private-key>\` — import a wallet key (desktop)
- \`/x402 remove\` — delete the wallet key + disable

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

      case 'setup': {
        const key = parts[1];
        if (!key) {
          return {
            title,
            content:
              'Usage: /x402 setup <0x-private-key>. Key generation is Phase-4 gated ' +
              '(coinbase/x402 SDK) — import an existing key for now. The extension ' +
              'never custodies a key; run setup on desktop.',
          };
        }
        await new PaymentKeyStore().setPrivateKey(key);
        await saveX402Config({ enabled: true });
        return {
          title,
          content:
            'Wallet key stored and x402 enabled. Fund the address with USDC. ' +
            'Real signing remains Phase-4 gated until the security/legal review completes.',
        };
      }

      case 'remove': {
        await new PaymentKeyStore().deletePrivateKey();
        await saveX402Config({ enabled: false });
        return { title, content: 'Wallet key removed and x402 disabled.' };
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
