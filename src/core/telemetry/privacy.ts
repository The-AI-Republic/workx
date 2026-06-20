/**
 * Privacy-level resolution — zero-dependency, pure.
 *
 * The caller (platform bootstrap) reads `AgentConfig` and passes the
 * preference value in; this module never imports `AgentConfig` (keeps the
 * telemetry core acyclic — verified `AgentConfig.ts` has no telemetry import).
 *
 * Ordered: `no-telemetry` (0) < `essential-traffic` (1). The source is a
 * boolean (`preferences.telemetryEnabled`, runtime default `false`), so
 * `default` collapses to `no-telemetry`. Env can only LOWER the level
 * (privacy fails closed); it can never force telemetry on.
 *
 * See `.ai_design/agent_improvements/16_telemetry_analytics/design.md` §5.
 */

export type PrivacyLevel = 'no-telemetry' | 'essential-traffic';

/**
 * Resolve the effective privacy level.
 *
 * @param telemetryEnabled `AgentConfig` preference, read by the caller.
 * @param envOptOut         result of {@link readEnvOptOut} (caller-injected).
 */
export function resolvePrivacyLevel(
  telemetryEnabled: boolean | undefined,
  envOptOut: boolean,
): PrivacyLevel {
  if (envOptOut) return 'no-telemetry'; // env can only lower (fail-closed)
  return telemetryEnabled === true ? 'essential-traffic' : 'no-telemetry';
}

/** True when telemetry may be emitted. Convenience for the injected gate. */
export function isTelemetryAllowed(
  telemetryEnabled: boolean | undefined,
  envOptOut: boolean,
): boolean {
  return resolvePrivacyLevel(telemetryEnabled, envOptOut) !== 'no-telemetry';
}

/**
 * Read the `WORKX_NO_TELEMETRY` opt-out behind a guard that is safe in the
 * extension service worker (no `process` there). Lifted from the
 * `typeof process !== 'undefined'` pattern in `utils/logger.ts`.
 */
export function readEnvOptOut(): boolean {
  if (
    typeof process !== 'undefined' &&
    process.env?.WORKX_NO_TELEMETRY != null
  ) {
    const v = process.env.WORKX_NO_TELEMETRY;
    return v !== '' && v !== 'false' && v !== '0';
  }
  return false;
}
