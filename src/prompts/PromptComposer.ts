/**
 * PromptComposer
 *
 * Dynamically composes system prompts from fragment files based on
 * agent type (workx vs pi) and runtime context.
 *
 * Never called by the agent directly — only by PromptLoader.
 */

// Build-time fragment imports
import workxIntro from './fragments/workx_intro.md?raw';
import desktopIntro from './fragments/workx_desktop_intro.md?raw';
import serverIntro from './fragments/workx_server_intro.md?raw';
import coderIntro from './fragments/coder_intro.md?raw';
import systemSemantics from './fragments/system_semantics.md?raw';
import safety from './fragments/safety.md?raw';
import actionRiskAndApproval from './fragments/action_risk_and_approval.md?raw';
import workLoop from './fragments/work_loop.md?raw';
import workxTools from './fragments/workx_tools.md?raw';
import desktopTools from './fragments/workx_desktop_tools.md?raw';
import coderTools from './fragments/coder_tools.md?raw';
import codeGuardrails from './fragments/code_guardrails.md?raw';
import communication from './fragments/communication.md?raw';
import compactSummarization from './fragments/compact_summarization.md?raw';
import compactSummaryPrefix from './fragments/compact_summary_prefix.md?raw';
import planReview from './fragments/plan_review.md?raw';
import { resolvePersona } from './PersonaLoader';

export type AgentType = 'workx' | 'workx-desktop' | 'workx-server';

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
   * Platforms that offer this mode. Omitted = every platform. WorkX only
   * supports the general mode; platform-specific modes list their agent types.
   */
  agentTypes?: AgentType[];
}

/**
 * Mode registry. The single source of truth for which modes exist and how
 * they are labelled. UI selectors and slash commands render from this.
 */
export const MODES: Record<AgentMode, AgentModeSpec> = {
  general: { id: 'general', label: 'General' },
  code: { id: 'code', label: 'Code', agentTypes: ['workx-desktop', 'workx-server'] },
};

export function supportsAgentMode(agentType: AgentType, mode: unknown): mode is AgentMode {
  if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODES, mode)) return false;
  const supportedTypes = MODES[mode as AgentMode].agentTypes;
  return !supportedTypes || supportedTypes.includes(agentType);
}

export function normalizeAgentMode(agentType: AgentType, mode: unknown): AgentMode {
  return supportsAgentMode(agentType, mode) ? mode : DEFAULT_MODE;
}

type FragmentContent = string | ((args: {
  agentType: AgentType;
  mode: AgentMode;
  context?: RuntimeContext;
  composer: PromptComposer;
}) => string | null | undefined);

interface FragmentSpec {
  id: string;
  order: number;
  content: FragmentContent;
  agentTypes?: AgentType[];
  modes?: AgentMode[];
  requiresCodingInstructions?: boolean;
}

export const FRAGMENTS: FragmentSpec[] = [
  { id: 'workx-intro', order: 10, agentTypes: ['workx'], content: workxIntro },
  { id: 'workx-desktop-intro', order: 10, agentTypes: ['workx-desktop'], modes: ['general'], content: desktopIntro },
  { id: 'workx-server-intro', order: 10, agentTypes: ['workx-server'], modes: ['general'], content: serverIntro },
  { id: 'coder-intro', order: 10, agentTypes: ['workx-desktop', 'workx-server'], modes: ['code'], content: coderIntro },
  {
    id: 'persona',
    order: 20,
    content: ({ context }) => resolvePersona(context?.personaName)?.prompt,
  },
  {
    id: 'runtime-metadata',
    order: 30,
    content: ({ agentType, context, composer }) => composer.buildRuntimeMetadata(agentType, context),
  },
  { id: 'system-semantics', order: 40, content: systemSemantics },
  { id: 'safety', order: 50, content: safety },
  { id: 'action-risk-and-approval', order: 60, content: actionRiskAndApproval },
  { id: 'work-loop', order: 70, content: workLoop },
  {
    id: 'workx-tools',
    order: 80,
    agentTypes: ['workx'],
    requiresCodingInstructions: true,
    content: workxTools,
  },
  {
    id: 'workx-desktop-tools',
    order: 80,
    agentTypes: ['workx-desktop', 'workx-server'],
    modes: ['general'],
    requiresCodingInstructions: true,
    content: desktopTools,
  },
  {
    id: 'coder-tools',
    order: 80,
    agentTypes: ['workx-desktop', 'workx-server'],
    modes: ['code'],
    requiresCodingInstructions: true,
    content: coderTools,
  },
  { id: 'communication', order: 90, content: communication },
  { id: 'code-guardrails', order: 100, modes: ['code'], content: codeGuardrails },
  {
    id: 'plan-review',
    order: 110,
    content: ({ context }) => context?.planReviewActive ? planReview : null,
  },
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
   * Compose the main agent system prompt for an (agentType, mode) pair.
   *
   * Assembled sections:
   * 1. Self-intro + core directive + capabilities (agent/mode-specific)
   * 2. Output-style persona, if configured
   * 3. Runtime metadata (injected fresh each call)
   * 4. System semantics, safety, action risk, and work loop (shared)
   * 5. Tool guidance + operation strategy (agent/mode-specific)
   * 6. Communication guidance (shared)
   * 7. Code guardrails, when code mode is active
   * 8. Plan review mode guidance, when active
   */
  composeMainInstruction(agentType: AgentType, context?: RuntimeContext): string;
  composeMainInstruction(agentType: AgentType, mode?: AgentMode, context?: RuntimeContext): string;
  composeMainInstruction(
    agentType: AgentType,
    modeOrContext: AgentMode | RuntimeContext = DEFAULT_MODE,
    context?: RuntimeContext
  ): string {
    const requestedMode: AgentMode = typeof modeOrContext === 'string' ? modeOrContext : DEFAULT_MODE;
    const runtimeContext = typeof modeOrContext === 'string' ? context : modeOrContext;
    const effectiveMode: AgentMode = agentType === 'workx' ? 'general' : requestedMode;
    const persona = resolvePersona(runtimeContext?.personaName);

    return FRAGMENTS
      .filter((fragment) => !fragment.agentTypes || fragment.agentTypes.includes(agentType))
      .filter((fragment) => !fragment.modes || fragment.modes.includes(effectiveMode))
      .filter((fragment) => !fragment.requiresCodingInstructions || !persona || persona.keepCodingInstructions)
      .sort((a, b) => a.order - b.order)
      .map((fragment) => typeof fragment.content === 'function'
        ? fragment.content({ agentType, mode: effectiveMode, context: runtimeContext, composer: this })
        : fragment.content)
      .filter((section): section is string => Boolean(section))
      .join('\n\n');
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
  buildRuntimeMetadata(
    agentType: AgentType,
    context?: RuntimeContext
  ): string {
    if (!context) return '';

    const lines: string[] = ['## Runtime Environment'];

    if (context.currentDateTime) {
      lines.push(`- Current date/time: ${context.currentDateTime}`);
    }

    if (agentType === 'workx-desktop' || agentType === 'workx-server') {
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
        bridge: 'WorkX Chrome extension bridge (local_browser_tool; present only while the extension is connected)',
      };
      lines.push(`- Browser connection: ${label[context.browserConnection] || context.browserConnection}`);
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }
}
