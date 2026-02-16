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
import defaultBrowserxPrompt from '../prompts/default_browserx_agent_prompt.md?raw';
import defaultPiPrompt from '../prompts/default_pi_agent_prompt.md?raw';
import userInstructions from '../prompts/user_instruction.md?raw';
import { PromptComposer, type AgentType, type RuntimeContext } from '../prompts/PromptComposer';

// Module-level singleton — configured once, used on every loadPrompt() call
let composer: PromptComposer | null = null;
let configuredAgentType: AgentType = 'browserx';
let staticContext: Partial<RuntimeContext> = {};

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
 * Used by BrowserxAgent to skip re-configuration when the desktop bootstrap
 * has already called configurePromptComposer() with platform context.
 */
export function isComposerConfigured(): boolean {
  return composer !== null;
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
      return composer.composeMainInstruction(configuredAgentType, context);
    } catch (error) {
      console.error('[PromptLoader] composeMainInstruction failed, falling back to default prompt:', error);
    }
  }
  // Fallback: return static default prompt based on build mode
  if (typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop') {
    return defaultPiPrompt;
  }
  return defaultBrowserxPrompt;
}

/**
 * Load user instructions (unchanged).
 */
export async function loadUserInstructions(): Promise<string> {
  return userInstructions;
}
