/**
 * Registers the ripgrep-backed read-only search tools (grep, glob).
 *
 * Read-only ⇒ each is registered with a StaticRiskAssessor(0) so the
 * approval gate auto-approves them (no user prompt), exactly like the
 * read-only terminal commands. Called from the desktop and server tool
 * registrars; never registered for the browserx extension (no FS/process).
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { Platform } from '../BaseTool';
import { GrepTool } from './GrepTool';
import { GlobTool } from './GlobTool';
import { FileSearchTool } from './FileSearchTool';

export async function registerFileSearchTools(
  registry: ToolRegistry,
  platforms: Platform[]
): Promise<void> {
  const tools: FileSearchTool[] = [new GrepTool(), new GlobTool()];
  for (const tool of tools) {
    // Idempotent — match the registrar pattern (planning/web_search skip
    // when already present) so repeated registration is a no-op.
    if (registry.getTool(tool.name)) continue;
    await registry.register(
      tool.toToolDefinition(platforms),
      tool.createHandler(),
      tool.riskAssessor
    );
  }
}
