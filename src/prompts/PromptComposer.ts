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
import systemSemantics from './fragments/system_semantics.md?raw';
import safety from './fragments/safety.md?raw';
import actionRiskAndApproval from './fragments/action_risk_and_approval.md?raw';
import workLoop from './fragments/work_loop.md?raw';
import browserxTools from './fragments/browserx_tools.md?raw';
import piTools from './fragments/pi_tools.md?raw';
import communication from './fragments/communication.md?raw';
import compactSummarization from './fragments/compact_summarization.md?raw';
import compactSummaryPrefix from './fragments/compact_summary_prefix.md?raw';
import planReview from './fragments/plan_review.md?raw';
import { resolvePersona } from './PersonaLoader';

export type AgentType = 'browserx' | 'applepi' | 'applepi-server';

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
  /**
   * Track 14 Plan Review: when true, the read-only-exploration fragment
   * is appended so the model keeps proposing (not executing) across
   * turns. Re-evaluated every compose() call → persists for the whole
   * review. Orthogonal to the agent operating-mode axis.
   */
  planReviewActive?: boolean;
  /** Selected output-style persona name (Track 24.2). Unknown → no-op. */
  personaName?: string;
}

export class PromptComposer {
  /**
   * Compose the main agent system prompt.
   *
   * Assembled sections:
   * 1. Self-intro + core directive + capabilities (agent-specific)
   * 2. Output-style persona, if configured
   * 3. Runtime metadata (injected fresh each call)
   * 4. System semantics, safety, action risk, and work loop (shared)
   * 5. Tool guidance + operation strategy (agent-specific, static for MVP)
   * 6. Communication guidance (shared)
   * 7. Plan review mode guidance, when active
   */
  composeMainInstruction(agentType: AgentType, context?: RuntimeContext): string {
    const sections: string[] = [];

    // 1. Agent identity & mission
    const intro = agentType === 'browserx'
      ? browserxIntro
      : agentType === 'applepi-server'
        ? piServerIntro
        : piIntro;
    sections.push(intro);

    // 1b. Output-style persona (Track 24.2). Additive; unknown/unset → null.
    const persona = resolvePersona(context?.personaName);
    if (persona) sections.push(persona.prompt);

    // 2. Runtime metadata
    sections.push(this.buildRuntimeMetadata(agentType, context));

    // 3. Runtime and safety semantics
    sections.push(systemSemantics);
    sections.push(safety);
    sections.push(actionRiskAndApproval);
    sections.push(workLoop);

    // 4. Tool guidance (static listing for MVP). A persona may opt out of the
    //    coding/tool instructions via `keepCodingInstructions: false`.
    if (!persona || persona.keepCodingInstructions) {
      sections.push(agentType === 'browserx' ? browserxTools : piTools);
    }

    // 5. Communication guidance remains shared even for personas that opt out
    //    of platform tool routing.
    sections.push(communication);

    // 6. Plan Review (Track 14) — appended last (highest salience) only
    //    while the freeze is active, so the model proposes a plan instead
    //    of executing. The freeze itself is the hard guarantee; this is
    //    the soft cross-turn guidance so it doesn't waste turns on denied
    //    mutations.
    if (context?.planReviewActive) {
      sections.push(planReview);
    }

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
