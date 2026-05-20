/**
 * Prompt Loader
 *
 * Single source of truth for loading system prompts.
 * Uses Vite's ?raw import to bundle the default prompt at build time.
 *
 * When configured via configurePromptComposer(), delegates to PromptComposer
 * to dynamically compose prompts based on agent type and runtime context.
 * Each loadPrompt() call produces a fresh prompt with current metadata.
 *
 * If not configured, falls back to the default bundled prompt.
 */

// Import default prompts as raw strings at build time (fallbacks)
import defaultPiExtensionPrompt from '../prompts/default_browserx_agent_prompt.md?raw';
import defaultPiPrompt from '../prompts/default_applepi_agent_prompt.md?raw';
import userInstructions from '../prompts/user_instruction.md?raw';
import { PromptComposer, type AgentType, type AgentMode, type RuntimeContext, DEFAULT_MODE } from '../prompts/PromptComposer';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { TurnContext } from './TurnContext';

export interface PromptRuntimeContext {
  sessionId?: string;
  mode?: AgentMode;
  toolRegistry?: ToolRegistry;
  turnContext?: TurnContext;
}

export type PromptExtensionScope =
  | { type: 'global' }
  | { type: 'session'; sessionId: string };

type PromptExtensionFn = (ctx: PromptRuntimeContext) => string;

// Module-level singleton — configured once, used on every loadPrompt() call
let composer: PromptComposer | null = null;
let configuredAgentType: AgentType = 'browserx';
let staticContext: Partial<RuntimeContext> = {};

/** Global prompt extensions appended after the main system prompt, keyed by name. */
let globalPromptExtensions: Map<string, PromptExtensionFn> = new Map();
/** Session-scoped prompt extensions keyed by session id, then extension name. */
let sessionPromptExtensions: Map<string, Map<string, PromptExtensionFn>> = new Map();

/**
 * Optional provider of per-call dynamic RuntimeContext, merged over the
 * static context on every loadPrompt(). Used for state that changes
 * within a session (e.g. Track 14 plan-review active flag) without
 * coupling PromptLoader to the ToolRegistry.
 */
let dynamicContextProvider: ((ctx: PromptRuntimeContext) => Partial<RuntimeContext>) | null = null;

/**
 * Register (or clear, with null) a dynamic RuntimeContext provider.
 * Invoked on every loadPrompt() call; its result is merged over the
 * static context (before currentDateTime).
 */
export function setDynamicRuntimeContext(
  fn: ((ctx: PromptRuntimeContext) => Partial<RuntimeContext>) | null
): void {
  dynamicContextProvider = fn;
}

/**
 * Configure the PromptLoader to use dynamic composition.
 * Called once during agent initialization.
 * After this, every loadPrompt() call returns a freshly composed prompt.
 */
export function configurePromptComposer(
  agentType: AgentType,
  context: Partial<RuntimeContext> = {}
): void {
  composer = new PromptComposer();
  configuredAgentType = agentType;
  staticContext = context;
}

/**
 * Check if the PromptComposer has already been configured.
 * Used by RepublicAgent to skip re-configuration when the desktop bootstrap
 * has already called configurePromptComposer() with platform context.
 */
export function isComposerConfigured(): boolean {
  return composer !== null;
}

/**
 * Register a named dynamic prompt extension.
 * The callback is invoked on every loadPrompt() call and its non-empty
 * return value is appended to the system prompt.
 * If an extension with the same name already exists, it is replaced.
 */
export function registerPromptExtension(
  name: string,
  fn: PromptExtensionFn,
  scope: PromptExtensionScope = { type: 'global' },
): () => void {
  if (scope.type === 'session') {
    let extensions = sessionPromptExtensions.get(scope.sessionId);
    if (!extensions) {
      extensions = new Map();
      sessionPromptExtensions.set(scope.sessionId, extensions);
    }
    extensions.set(name, fn);
    return () => unregisterPromptExtension(name, scope);
  }

  globalPromptExtensions.set(name, fn);
  return () => unregisterPromptExtension(name, scope);
}

/**
 * Unregister a named prompt extension.
 */
export function unregisterPromptExtension(
  name: string,
  scope: PromptExtensionScope = { type: 'global' },
): void {
  if (scope.type === 'session') {
    const extensions = sessionPromptExtensions.get(scope.sessionId);
    extensions?.delete(name);
    if (extensions && extensions.size === 0) {
      sessionPromptExtensions.delete(scope.sessionId);
    }
    return;
  }

  globalPromptExtensions.delete(name);
}

/**
 * Clear all prompt extensions owned by a session.
 */
export function unregisterSessionPromptExtensions(sessionId: string): void {
  sessionPromptExtensions.delete(sessionId);
}

/**
 * Load the system prompt for the agent.
 *
 * If PromptComposer is configured: composes a fresh prompt with current
 * runtime metadata (date/time refreshed on each call).
 *
 * If not configured: returns the default bundled prompt (fallback).
 *
 * Called on every user message submission — safe to call repeatedly.
 *
 * `mode` is per-session (owned by Session/TurnContext) and passed in by the
 * caller — it is NOT module-global state, so concurrent sessions in different
 * modes compose correctly.
 */
export async function loadPrompt(
  mode: AgentMode = DEFAULT_MODE,
  runtimeContext: PromptRuntimeContext = {},
): Promise<string> {
  const ctx: PromptRuntimeContext = {
    ...runtimeContext,
    mode,
  };
  if (composer) {
    try {
      let dynamic: Partial<RuntimeContext> = {};
      try {
        dynamic = dynamicContextProvider?.(ctx) ?? {};
      } catch (e) {
        console.error('[PromptLoader] dynamic context provider failed:', e);
      }
      const context: RuntimeContext = {
        ...staticContext,
        ...dynamic,
        currentDateTime: new Date().toISOString(),
      };
      const prompt = composer.composeMainInstruction(configuredAgentType, mode, context);
      return appendExtensions(prompt, ctx);
    } catch (error) {
      console.error('[PromptLoader] composeMainInstruction failed, falling back to default prompt:', error);
    }
  }
  // Fallback: return static default prompt based on build mode
  let fallback: string;
  if (typeof __BUILD_MODE__ !== 'undefined' && (__BUILD_MODE__ === 'desktop' || __BUILD_MODE__ === 'server')) {
    fallback = defaultPiPrompt;
  } else {
    fallback = defaultPiExtensionPrompt;
  }
  return appendExtensions(fallback, ctx);
}

/**
 * Append registered prompt extensions to the base prompt.
 */
function appendExtensions(base: string, ctx: PromptRuntimeContext): string {
  const extensions = new Map<string, PromptExtensionFn>(globalPromptExtensions);
  if (ctx.sessionId) {
    const sessionExtensions = sessionPromptExtensions.get(ctx.sessionId);
    if (sessionExtensions) {
      for (const [name, fn] of sessionExtensions) {
        extensions.set(name, fn);
      }
    }
  }
  if (extensions.size === 0) return base;

  const extras = Array.from(extensions.values())
    .map((fn) => fn(ctx))
    .filter(Boolean);

  if (extras.length === 0) return base;
  return base + '\n\n' + extras.join('\n\n');
}

/**
 * Load user instructions (unchanged).
 */
export async function loadUserInstructions(): Promise<string> {
  return userInstructions;
}
