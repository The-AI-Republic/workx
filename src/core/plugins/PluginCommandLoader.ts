import type { HooksConfig } from '@/core/hooks/types';

export interface PluginPromptCommand {
  readonly type: 'prompt';
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly argumentHint?: string;
  readonly loadedFrom: 'plugin';
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'max' | number;
  readonly context?: 'inline' | 'fork';
  readonly agent?: string;
  readonly allowedTools?: readonly string[];
  readonly domains?: readonly string[];
  readonly hooks?: HooksConfig;
  getPromptForCommand(args: string, ctx?: unknown): Promise<string>;
}

export class PluginCommandLoader {
  private readonly byPluginId = new Map<string, PluginPromptCommand[]>();

  add(pluginId: string, commands: PluginPromptCommand[]): void {
    this.byPluginId.set(pluginId, [...commands]);
  }

  removeByPluginId(pluginId: string): void {
    this.byPluginId.delete(pluginId);
  }

  load(): PluginPromptCommand[] {
    const out: PluginPromptCommand[] = [];
    for (const list of this.byPluginId.values()) {
      out.push(...list);
    }
    return out;
  }

  hasAny(): boolean {
    return this.byPluginId.size > 0;
  }

  getPluginIds(): string[] {
    return Array.from(this.byPluginId.keys());
  }
}
