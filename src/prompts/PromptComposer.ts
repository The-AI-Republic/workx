/**
 * PromptComposer
 *
 * Dynamically composes system prompts from fragment files based on
 * agent type (browserx vs pi) and runtime context.
 *
 * Never called by the agent directly — only by PromptLoader.
 */

// Build-time fragment imports
import browserxIntro from './fragments/browserx_intro.md?raw';
import piIntro from './fragments/applepi_intro.md?raw';
import piServerIntro from './fragments/applepi_server_intro.md?raw';
import coderIntro from './fragments/coder_intro.md?raw';
import safety from './fragments/safety.md?raw';
import browserxTools from './fragments/browserx_tools.md?raw';
import piTools from './fragments/pi_tools.md?raw';
import coderTools from './fragments/coder_tools.md?raw';
import codeGuardrails from './fragments/code_guardrails.md?raw';
import taskPolicies from './fragments/task_execution_policies.md?raw';
import approvalPolicies from './fragments/approval_policies.md?raw';
import compactSummarization from './fragments/compact_summarization.md?raw';
import compactSummaryPrefix from './fragments/compact_summary_prefix.md?raw';

export type AgentType = 'browserx' | 'applepi' | 'applepi-server';

/**
 * Agent persona mode. Orthogonal to AgentType.
 *
 * Adding a mode is additive: extend this union, add a MODES entry, and add
 * fragment manifest rows owned by the new mode. No composer logic changes.
 */
export type AgentMode = 'general' | 'code';

export const DEFAULT_MODE: AgentMode = 'general';

export interface AgentModeSpec {
  id: AgentMode;
  /** Display label for UI selectors */
  label: string;
  /**
   * Platforms that offer this mode. Omitted = all non-browserx platforms.
   * Browserx never exposes modes (composer forces 'general' for it).
   */
  agentTypes?: AgentType[];
}

/**
 * Mode registry. The single source of truth for which modes exist and how
 * they are labelled. UI selectors and slash commands render from this.
 */
export const MODES: Record<AgentMode, AgentModeSpec> = {
  general: { id: 'general', label: 'General' },
  code: { id: 'code', label: 'Code', agentTypes: ['applepi', 'applepi-server'] },
};

/**
 * One composable prompt fragment.
 * - `modes` omitted  → shared/universal (included in every mode)
 * - `agentTypes` omitted → applies to every platform
 * - `body.kind === 'runtime'` → generated at compose time, not a static file
 */
interface FragmentSpec {
  id: string;
  /** Composition order (ascending). */
  order: number;
  agentTypes?: AgentType[];
  modes?: AgentMode[];
  body: { kind: 'static'; content: string } | { kind: 'runtime' };
}

const FRAGMENTS: FragmentSpec[] = [
  // 1. Identity intro
  { id: 'intro', order: 10, agentTypes: ['browserx'], modes: ['general'], body: { kind: 'static', content: browserxIntro } },
  { id: 'intro', order: 10, agentTypes: ['applepi'], modes: ['general'], body: { kind: 'static', content: piIntro } },
  { id: 'intro', order: 10, agentTypes: ['applepi-server'], modes: ['general'], body: { kind: 'static', content: piServerIntro } },
  { id: 'intro', order: 10, agentTypes: ['applepi', 'applepi-server'], modes: ['code'], body: { kind: 'static', content: coderIntro } },
  // 2. Runtime metadata (generated)
  { id: 'runtime', order: 20, body: { kind: 'runtime' } },
  // 3. Safety (shared)
  { id: 'safety', order: 30, body: { kind: 'static', content: safety } },
  // 4. Tool guidance
  { id: 'tools', order: 40, agentTypes: ['browserx'], modes: ['general'], body: { kind: 'static', content: browserxTools } },
  { id: 'tools', order: 40, agentTypes: ['applepi', 'applepi-server'], modes: ['general'], body: { kind: 'static', content: piTools } },
  { id: 'tools', order: 40, agentTypes: ['applepi', 'applepi-server'], modes: ['code'], body: { kind: 'static', content: coderTools } },
  // 5. Task execution policies (shared)
  { id: 'task_policy', order: 50, body: { kind: 'static', content: taskPolicies } },
  // 6. Approval policies (shared)
  { id: 'approval', order: 60, body: { kind: 'static', content: approvalPolicies } },
  // 7. Mode-specific appends
  { id: 'guardrails', order: 70, modes: ['code'], body: { kind: 'static', content: codeGuardrails } },
];

export interface RuntimeContext {
  /** Operating system: 'linux' | 'macos' | 'windows' */
  os?: string;
  /** CPU architecture: 'x86_64' | 'aarch64' */
  arch?: string;
  /** OS version string */
  osVersion?: string;
  /** Default shell: 'bash' | 'zsh' | 'powershell' */
  shell?: string;
  /** Home directory path */
  homeDir?: string;
  /** Current working directory */
  cwd?: string;
  /** Browser connection method: 'extension' | 'cdp' | 'mcp' */
  browserConnection?: string;
  /** Current date/time string */
  currentDateTime?: string;
  /** Available memory in GB */
  memoryGB?: number;
}

export class PromptComposer {
  /**
   * Compose the main agent system prompt for an (agentType, mode) pair.
   *
   * Assembly is driven by the FRAGMENTS manifest: each fragment declares the
   * platforms and modes it belongs to. Browserx never exposes modes — its
   * `mode` is forced to 'general' regardless of the argument.
   *
   * Slot order: identity → runtime metadata → safety → tool guidance →
   * task policies → approval policies → mode-specific appends.
   */
  composeMainInstruction(
    agentType: AgentType,
    mode: AgentMode = DEFAULT_MODE,
    context?: RuntimeContext
  ): string {
    const effectiveMode: AgentMode = agentType === 'browserx' ? 'general' : mode;

    const sections = FRAGMENTS
      .filter((f) => !f.agentTypes || f.agentTypes.includes(agentType))
      .filter((f) => !f.modes || f.modes.includes(effectiveMode))
      .sort((a, b) => a.order - b.order)
      .map((f) =>
        f.body.kind === 'runtime'
          ? this.buildRuntimeMetadata(agentType, context)
          : f.body.content
      );

    return sections.filter(Boolean).join('\n\n');
  }

  /**
   * Compose the context window compaction prompt.
   */
  composeCompactPrompt(): string {
    return compactSummarization;
  }

  /**
   * Compose the summary prefix for compacted history.
   */
  composeSummaryPrefix(): string {
    return compactSummaryPrefix;
  }

  /**
   * Build runtime metadata section.
   */
  private buildRuntimeMetadata(
    agentType: AgentType,
    context?: RuntimeContext
  ): string {
    if (!context) return '';

    const lines: string[] = ['## Runtime Environment'];

    if (context.currentDateTime) {
      lines.push(`- Current date/time: ${context.currentDateTime}`);
    }

    if (agentType === 'applepi' || agentType === 'applepi-server') {
      // Desktop agent gets OS/platform details
      if (context.os) {
        const osLabel: Record<string, string> = {
          linux: 'Linux',
          macos: 'macOS',
          windows: 'Windows',
        };
        lines.push(`- Operating system: ${osLabel[context.os] || context.os}`);
      }
      if (context.arch) lines.push(`- Architecture: ${context.arch}`);
      if (context.osVersion) lines.push(`- OS version: ${context.osVersion}`);
      if (context.shell) lines.push(`- Default shell: ${context.shell}`);
      if (context.homeDir) lines.push(`- Home directory: ${context.homeDir}`);
      if (context.cwd) lines.push(`- Working directory: ${context.cwd}`);
      if (context.memoryGB) lines.push(`- Available memory: ${context.memoryGB} GB`);
    }

    if (context.browserConnection) {
      const label: Record<string, string> = {
        extension: 'Chrome Extension (direct tab access)',
        cdp: 'Chrome DevTools Protocol',
        mcp: 'MCP browser automation server',
      };
      lines.push(`- Browser connection: ${label[context.browserConnection] || context.browserConnection}`);
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }
}
