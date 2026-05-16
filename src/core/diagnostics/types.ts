/**
 * Operational Diagnostics — shared types (Track 17).
 *
 * A platform-shared registry of discrete, side-effect-free checks. Each check
 * returns a uniform pass/warn/fail result; `buildDoctorReport` aggregates them
 * into a single `DoctorReport`. Mirrors claudy's "discrete checks → one
 * aggregate" pattern, generalized for BrowserX's three deploy targets.
 *
 * @module core/diagnostics/types
 */

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export type DiagnosticPlatform = 'extension' | 'desktop' | 'server';

/** Outcome of a single check. `detail`/`data` MUST be redacted before any
 *  cross-process emission — see {@link module:core/diagnostics/redact}. */
export interface DiagnosticResult {
  id: string;
  title: string;
  status: DiagnosticStatus;
  /** Human-readable summary line. */
  detail: string;
  /** Optional structured payload (counts, ids). Redacted on emission. */
  data?: Record<string, unknown>;
}

/**
 * Instance handles a check may need. Cross-platform singletons
 * (`AgentConfig`, the `core/storage` providers) are resolved by the checks
 * themselves — only instance-held collaborators are injected here so the
 * checks stay unit-testable. Every field is optional; a check must degrade
 * gracefully when its source is absent (uninitialized subsystem / platform
 * without it).
 */
export interface DiagnosticContext {
  platformId: DiagnosticPlatform;
  channelManager?: {
    getChannelInfo(): Array<{ channelId: string }>;
  };
  mcpManager?: {
    getConnections(): Array<{ configId: string; status: string; lastError?: string }>;
    getServers(): Array<unknown>;
  };
  skillRegistry?: {
    getAllSkillMetas?(): unknown;
    getSkillMetas(): unknown;
  };
  scheduler?: {
    getSchedulerState(): Promise<{
      isPaused: boolean;
      missedCount: number;
      jobQueueCount: number;
    }>;
  };
}

export interface DiagnosticCheck {
  id: string;
  title: string;
  /** Platforms this check applies to; filtered at runtime by `platformId`. */
  platforms: DiagnosticPlatform[];
  run(ctx: DiagnosticContext): Promise<DiagnosticResult>;
}

export interface DoctorReport {
  overall: DiagnosticStatus;
  platformId: DiagnosticPlatform;
  generatedAt: number;
  durationMs: number;
  checks: DiagnosticResult[];
}
