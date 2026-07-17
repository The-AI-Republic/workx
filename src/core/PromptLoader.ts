/**
 * Prompt Loader
 *
 * Single source of truth for loading system prompts.
 * Uses Vite's ?raw import to bundle the default prompt at build time.
 *
 * Every assembled agent owns an isolated PromptComposer and extension map.
 * Each load call produces a fresh prompt with current per-session metadata;
 * composition failures fall back to the appropriate bundled prompt.
 */

// Import default prompts as raw strings at build time (fallbacks)
import defaultExtensionPrompt from '../prompts/default_workx_agent_prompt.md?raw';
import defaultDesktopPrompt from '../prompts/default_workx_desktop_agent_prompt.md?raw';
import userInstructions from '../prompts/user_instruction.md?raw';
import { PromptComposer, type AgentType, type AgentMode, type RuntimeContext, DEFAULT_MODE, MODES } from '../prompts/PromptComposer';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { TurnContext } from './TurnContext';

export interface PromptRuntimeContext {
  sessionId?: string;
  mode?: AgentMode;
  toolRegistry?: ToolRegistry;
  turnContext?: TurnContext;
}

export type AgentPromptExtension =
  (ctx: PromptRuntimeContext) => string | Promise<string>;

export interface AgentPromptLoader {
  load(mode: AgentMode, runtime?: PromptRuntimeContext): Promise<string>;
  supportsMode(mode: AgentMode): boolean;
  registerExtension(name: string, extension: AgentPromptExtension): () => void;
  dispose(): void;
}

export interface CreatePromptLoaderInput {
  agentType: AgentType;
  staticPlatformContext?: Readonly<Partial<RuntimeContext>>;
  dynamicContext?: (runtime: PromptRuntimeContext) => Partial<RuntimeContext>;
}

/** Create an isolated prompt composer for one assembled agent graph. */
export function createPromptLoader(input: CreatePromptLoaderInput): AgentPromptLoader {
  const instanceComposer = new PromptComposer();
  const staticSnapshot = Object.freeze({ ...(input.staticPlatformContext ?? {}) });
  const extensions = new Map<string, AgentPromptExtension>();
  let disposed = false;

  return {
    async load(mode: AgentMode = DEFAULT_MODE, runtime: PromptRuntimeContext = {}): Promise<string> {
      if (disposed) throw new Error('AgentPromptLoader is disposed');
      const ctx = { ...runtime, mode };
      let base: string;
      try {
        let dynamic: Partial<RuntimeContext> = {};
        try {
          dynamic = input.dynamicContext?.(ctx) ?? {};
        } catch (error) {
          console.warn('[AgentPromptLoader] dynamic context failed:', error);
        }
        base = instanceComposer.composeMainInstruction(input.agentType, mode, {
          ...staticSnapshot,
          ...dynamic,
          currentDateTime: new Date().toISOString(),
        });
      } catch (error) {
        console.warn('[AgentPromptLoader] composition failed; using bundled fallback:', error);
        base = input.agentType === 'workx' ? defaultExtensionPrompt : defaultDesktopPrompt;
      }

      const extras: string[] = [];
      for (const [name, extension] of extensions) {
        try {
          const value = await extension(ctx);
          if (value) extras.push(value);
        } catch (error) {
          console.warn(`[AgentPromptLoader] extension '${name}' failed and was omitted:`, error);
        }
      }
      return extras.length > 0 ? `${base}\n\n${extras.join('\n\n')}` : base;
    },
    supportsMode(mode: AgentMode): boolean {
      return Object.prototype.hasOwnProperty.call(MODES, mode);
    },
    registerExtension(name: string, extension: AgentPromptExtension): () => void {
      if (disposed) throw new Error('AgentPromptLoader is disposed');
      extensions.set(name, extension);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        if (extensions.get(name) === extension) extensions.delete(name);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      extensions.clear();
    },
  };
}

/**
 * Load user instructions (unchanged).
 */
export async function loadUserInstructions(): Promise<string> {
  return userInstructions;
}
