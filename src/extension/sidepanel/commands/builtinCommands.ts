import { commandRegistry } from './CommandRegistry';

export interface BuiltinCommandCallbacks {
  onNewConversation: () => void;
  onCommandOutput: (title: string, content: string) => void;
  onOpenSettings: () => void;
}

export function initBuiltinCommands(callbacks: BuiltinCommandCallbacks): void {
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
