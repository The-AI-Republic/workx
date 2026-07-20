import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeAppServerConfig,
  isLoopbackHost,
  AppServerConfigError,
  APP_SERVER_DEFAULTS,
} from '../appServerConfig';
import { getDefaultAgentConfig } from '@/config/defaults';

describe('appServerConfig', () => {
  afterEach(() => {
    delete process.env.WORKX_APP_SERVER_DEV_ALLOW_NO_AUTH;
  });

  it('applies defaults for an empty config', () => {
    const cfg = normalizeAppServerConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.port).toBe(18101);
    expect(cfg.requireAuth).toBe(true);
    expect(cfg.rejectBrowserOrigins).toBe(true);
  });

  it('matches the exported defaults', () => {
    expect(APP_SERVER_DEFAULTS.port).toBe(18101);
    expect(APP_SERVER_DEFAULTS.maxConnections).toBe(16);
  });

  it('identifies loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });

  it('rejects a non-loopback bind when allowLan is false', () => {
    expect(() =>
      normalizeAppServerConfig({ enabled: true, bindHost: '0.0.0.0', allowLan: false }),
    ).toThrow(AppServerConfigError);
  });

  it('permits a non-loopback bind when allowLan is true', () => {
    const cfg = normalizeAppServerConfig({ enabled: true, bindHost: '0.0.0.0', allowLan: true });
    expect(cfg.bindHost).toBe('0.0.0.0');
  });

  it('rejects requireAuth=false without the dev override', () => {
    expect(() => normalizeAppServerConfig({ requireAuth: false })).toThrow(AppServerConfigError);
  });

  it('permits requireAuth=false with the dev override env', () => {
    process.env.WORKX_APP_SERVER_DEV_ALLOW_NO_AUTH = '1';
    const cfg = normalizeAppServerConfig({ requireAuth: false });
    expect(cfg.requireAuth).toBe(false);
  });

  it('clamps out-of-range numeric fields by throwing', () => {
    expect(() => normalizeAppServerConfig({ port: 70000 })).toThrow(AppServerConfigError);
    expect(() => normalizeAppServerConfig({ maxConnections: 0 })).toThrow(AppServerConfigError);
    expect(() => normalizeAppServerConfig({ requestQueueCapacity: 99999 })).toThrow(AppServerConfigError);
    expect(() => normalizeAppServerConfig({ maxPayloadBytes: 10 })).toThrow(AppServerConfigError);
  });

  it('rejects an unknown transport', () => {
    expect(() =>
      normalizeAppServerConfig({ transport: 'carrier-pigeon' as unknown as 'websocket' }),
    ).toThrow(AppServerConfigError);
  });

  it('allows port 0 (OS-assigned)', () => {
    const cfg = normalizeAppServerConfig({ port: 0 });
    expect(cfg.port).toBe(0);
  });

  it('is enabled by default in the shipped agent config (loopback + token-gated)', () => {
    const cfg = getDefaultAgentConfig();
    // Enabled so the browser bridge works out-of-box; still loopback-bound and
    // token-required so the exposure stays local + authenticated.
    expect(cfg.appServer?.enabled).toBe(true);
    expect(cfg.appServer?.bindHost).toBe('127.0.0.1');
    expect(cfg.appServer?.requireAuth).toBe(true);
  });
});
