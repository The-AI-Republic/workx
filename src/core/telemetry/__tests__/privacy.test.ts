import { describe, it, expect, afterEach } from 'vitest';
import {
  resolvePrivacyLevel,
  isTelemetryAllowed,
  readEnvOptOut,
} from '../privacy';

describe('telemetry core: privacy', () => {
  const orig = process.env.APPLEPI_NO_TELEMETRY;
  afterEach(() => {
    if (orig === undefined) delete process.env.APPLEPI_NO_TELEMETRY;
    else process.env.APPLEPI_NO_TELEMETRY = orig;
  });

  it('Test 1.e: resolvePrivacyLevel truth table', () => {
    expect(resolvePrivacyLevel(true, false)).toBe('essential-traffic');
    expect(resolvePrivacyLevel(false, false)).toBe('no-telemetry');
    expect(resolvePrivacyLevel(undefined, false)).toBe('no-telemetry');
    // env opt-out can only LOWER, never raise (fail-closed)
    expect(resolvePrivacyLevel(true, true)).toBe('no-telemetry');
    expect(resolvePrivacyLevel(false, true)).toBe('no-telemetry');
    expect(isTelemetryAllowed(true, false)).toBe(true);
    expect(isTelemetryAllowed(true, true)).toBe(false);
    expect(isTelemetryAllowed(false, false)).toBe(false);
  });

  it('readEnvOptOut honors APPLEPI_NO_TELEMETRY truthiness', () => {
    delete process.env.APPLEPI_NO_TELEMETRY;
    expect(readEnvOptOut()).toBe(false);
    process.env.APPLEPI_NO_TELEMETRY = '0';
    expect(readEnvOptOut()).toBe(false);
    process.env.APPLEPI_NO_TELEMETRY = 'false';
    expect(readEnvOptOut()).toBe(false);
    process.env.APPLEPI_NO_TELEMETRY = '';
    expect(readEnvOptOut()).toBe(false);
    process.env.APPLEPI_NO_TELEMETRY = '1';
    expect(readEnvOptOut()).toBe(true);
    process.env.APPLEPI_NO_TELEMETRY = 'true';
    expect(readEnvOptOut()).toBe(true);
  });
});
