/**
 * Centralized telemetry — public barrel.
 *
 * One privacy-typed `logEvent` contract that every diagnostic signal flows
 * through. No-op by default; the platform bootstrap injects a privacy gate
 * and attaches a sink.
 *
 * See `.ai_design/agent_improvements/16_telemetry_analytics/design.md`.
 */

export {
  logEvent,
  logEventAsync,
  attachSink,
  setTelemetryGate,
  stripProtoFields,
  getDroppedCount,
  NoopSink,
  _resetForTesting,
} from './analytics';
export type {
  TelemetryEvent,
  TelemetrySink,
  LogEventMetadata,
  TelemetryMeta_VERIFIED_NOT_CONTENT,
  TelemetryMeta_VERIFIED_PII_TAGGED,
} from './analytics';

export {
  sanitizeToolName,
  boundedEnum,
  numericOnly,
  errorClass,
  modelId,
} from './sanitize';

export {
  resolvePrivacyLevel,
  isTelemetryAllowed,
  readEnvOptOut,
} from './privacy';
export type { PrivacyLevel } from './privacy';
