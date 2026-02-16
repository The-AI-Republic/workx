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
import piIntro from './fragments/pi_intro.md?raw';
import safety from './fragments/safety.md?raw';
import browserxTools from './fragments/browserx_tools.md?raw';
import piTools from './fragments/pi_tools.md?raw';
import taskPolicies from './fragments/task_execution_policies.md?raw';
import compactSummarization from './fragments/compact_summarization.md?raw';
import compactSummaryPrefix from './fragments/compact_summary_prefix.md?raw';

export type AgentType = 'browserx' | 'pi';

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
   * Compose the main agent system prompt.
   *
   * Assembled sections:
   * 1. Self-intro + core directive + capabilities (agent-specific)
   * 2. Runtime metadata (injected fresh each call)
   * 3. Safety guidance (shared)
   * 4. Tool guidance + operation strategy (agent-specific, static for MVP)
   * 5. Task execution policies (shared)
   */
  composeMainInstruction(agentType: AgentType, context?: RuntimeContext): string {
    const sections: string[] = [];

    // 1. Agent identity & mission
    sections.push(agentType === 'browserx' ? browserxIntro : piIntro);

    // 2. Runtime metadata
    sections.push(this.buildRuntimeMetadata(agentType, context));

    // 3. Safety & ethics
    sections.push(safety);

    // 4. Tool guidance (static listing for MVP)
    sections.push(agentType === 'browserx' ? browserxTools : piTools);

    // 5. Task execution policies
    sections.push(taskPolicies);

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

    if (agentType === 'pi') {
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
