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
import defaultPiPrompt from '../prompts/default_pi_agent_prompt.md?raw';
import userInstructions from '../prompts/user_instruction.md?raw';
import { PromptComposer, type AgentType, type RuntimeContext } from '../prompts/PromptComposer';

// Module-level singleton — configured once, used on every loadPrompt() call
let composer: PromptComposer | null = null;
let configuredAgentType: AgentType = 'browserx';
let staticContext: Partial<RuntimeContext> = {};

/** Dynamic prompt extensions appended after the main system prompt */
let promptExtensions: Array<() => string> = [];

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
 * Register a dynamic prompt extension.
 * The callback is invoked on every loadPrompt() call and its non-empty
 * return value is appended to the system prompt.
 */
export function registerPromptExtension(fn: () => string): void {
  promptExtensions.push(fn);
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
 */
export async function loadPrompt(): Promise<string> {
  if (composer) {
    try {
      const context: RuntimeContext = {
        ...staticContext,
        currentDateTime: new Date().toISOString(),
      };
      const prompt = composer.composeMainInstruction(configuredAgentType, context);
      return appendExtensions(prompt);
    } catch (error) {
      console.error('[PromptLoader] composeMainInstruction failed, falling back to default prompt:', error);
    }
  }
  // Fallback: return static default prompt based on build mode
  let fallback: string;
  if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop') {
    fallback = defaultPiPrompt;
  } else {
    fallback = defaultPiExtensionPrompt;
  }
  return appendExtensions(fallback);
}

/**
 * Append registered prompt extensions to the base prompt.
 */
function appendExtensions(base: string): string {
  if (promptExtensions.length === 0) return base;

  const extras = promptExtensions
    .map((fn) => fn())
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
