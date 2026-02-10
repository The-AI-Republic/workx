/**
 * Prompt Loader
 *
 * Loads prompt files. Uses Vite's ?raw import to bundle prompts at build time,
 * making them available in both extension and desktop modes.
 */

// Import prompts as raw strings at build time
import agentPrompt from '../prompts/agent_prompt.md?raw';
import userInstructions from '../prompts/user_instruction.md?raw';

export async function loadPrompt(): Promise<string> {
  return agentPrompt;
}

export async function loadUserInstructions(): Promise<string> {
  return userInstructions;
}