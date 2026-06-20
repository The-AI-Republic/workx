/**
 * Registers the ripgrep-backed read-only search tools (grep, glob).
 *
 * Read-only ⇒ each is registered with a StaticRiskAssessor(0) so the
 * approval gate auto-approves them (no user prompt), exactly like the
 * read-only terminal commands. Called from the desktop and server tool
 * registrars; never registered for the workx extension (no FS/process).
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { Platform, ToolDefinition, ToolHandler } from '../BaseTool';
import type { IRiskAssessor } from '../../core/approval/types';
import { GrepTool } from './GrepTool';
import { GlobTool } from './GlobTool';
import { ReadFileTool, EditFileTool, WriteFileTool } from './FileAccessTool';

// grep/glob (search) + read/edit/write (file access) share this shape.
interface Registerable {
  name: string;
  toToolDefinition(p: Platform[]): ToolDefinition;
  createHandler(): ToolHandler;
  riskAssessor: IRiskAssessor;
}

export async function registerFileSearchTools(
  registry: ToolRegistry,
  platforms: Platform[]
): Promise<void> {
  // grep/glob are cross-platform (desktop + server). The code-mode file
  // tools (read/edit/write) are DESKTOP ONLY by design — they require the
  // Tauri Rust fs commands; registering them on server would only expose
  // always-erroring tools. read_file auto-approves (StaticRiskAssessor 0);
  // edit_file/write_file carry FileWriteRiskAssessor → ASK (design §4.8).
  const tools: Registerable[] = [new GrepTool(), new GlobTool()];
  if (platforms.includes('desktop')) {
    tools.push(new ReadFileTool(), new EditFileTool(), new WriteFileTool());
  }
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
