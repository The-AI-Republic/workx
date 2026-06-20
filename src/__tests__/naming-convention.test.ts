/**
 * Naming Convention Guard-Rail Tests
 *
 * The product is unified under a single brand, **WorkX**, across every surface
 * (extension, desktop, server). The lowercase `workx` codename is used for all
 * internal identifiers (persistence keys, events, DOM attributes, agent types).
 * See docs/NAMING.md.
 *
 * Deep links: `workx://` is the canonical scheme used for all generated links;
 * `applepi://` is retained only as a registered fallback handler so links
 * issued before the rename still resolve.
 *
 * Any rename that breaks these conventions will fail CI.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DB_NAME as CACHE_DB_NAME } from '../storage/IndexedDBAdapter';
import { DB_NAME as ROLLOUT_DB_NAME } from '../storage/rollout/types';
import { VISUAL_EFFECT_EVENT_NAME } from '../extension/content/ui_effect/contracts/domtool-events';

const ROOT = path.resolve(__dirname, '../..');

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal identifiers — all use the lowercase "workx" codename
// ─────────────────────────────────────────────────────────────────────────────

describe('Internal identifiers use "workx"', () => {
  it('IndexedDB cache DB name is "workx_cache"', () => {
    expect(CACHE_DB_NAME).toBe('workx_cache');
  });

  it('Rollout DB name is "WorkXRollouts"', () => {
    expect(ROLLOUT_DB_NAME).toBe('WorkXRollouts');
  });

  it('RepublicAgent class is exported from src/core/RepublicAgent.ts', () => {
    expect(readSource('src/core/RepublicAgent.ts')).toContain('export class RepublicAgent');
  });

  it('AgentConfig credential service is "workx"', () => {
    expect(readSource('src/config/AgentConfig.ts')).toMatch(/CREDENTIAL_SERVICE\s*=\s*['"]workx['"]/);
  });

  it('Runtime credential store service prefix defaults to "workx"', () => {
    expect(readSource('src/desktop-runtime/credentials/ControlFrameCredentialStore.ts')).toMatch(
      /servicePrefix\s*=\s*['"]workx['"]/,
    );
  });

  it('Desktop hotkeys use "workx:" event prefix', () => {
    const src = readSource('src/desktop/hotkeys.ts');
    expect(src).toContain("'workx:focus-input'");
    expect(src).toContain("'workx:quick-action'");
  });

  it('PromptComposer AgentType union is workx / workx-desktop / workx-server', () => {
    const src = readSource('src/prompts/PromptComposer.ts');
    expect(src).toMatch(/AgentType\s*=\s*'workx'\s*\|\s*'workx-desktop'\s*\|\s*'workx-server'/);
  });

  it('ChromeCredentialStore uses "workx-credential:" prefix', () => {
    expect(readSource('src/extension/storage/ChromeCredentialStore.ts')).toMatch(
      /CREDENTIAL_PREFIX\s*=\s*['"]workx-credential:['"]/,
    );
  });

  it('DomService uses "workx:show-visual-effect" event', () => {
    expect(readSource('src/extension/tools/dom/DomService.ts')).toContain('workx:show-visual-effect');
  });

  it('content-script uses "workx:" events and "workx-" element IDs', () => {
    const src = readSource('src/extension/content/content-script.ts');
    expect(src).toContain('workx:init-visual-effects');
    expect(src).toContain('workx-visual-effects-host');
  });

  it('VISUAL_EFFECT_EVENT_NAME is "workx:visual-effect"', () => {
    expect(VISUAL_EFFECT_EVENT_NAME).toBe('workx:visual-effect');
  });

  it('TabManager groupTitle is "workx"', () => {
    expect(readSource('src/core/TabManager.ts')).toMatch(/groupTitle\s*=\s*['"]workx['"]/);
  });

  it('AgentSession tab group uses "workx_s_" prefix', () => {
    expect(readSource('src/core/registry/AgentSession.ts')).toContain('workx_s_');
  });

  it('GoogleDocAddon uses "data-workx-injected" attribute', () => {
    expect(readSource('src/extension/tools/dom/addons/GoogleDocAddon.ts')).toContain('data-workx-injected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// User-facing product identity — "WorkX"
// ─────────────────────────────────────────────────────────────────────────────

describe('User-facing product identity is "WorkX"', () => {
  it('desktop index.html title is "WorkX"', () => {
    expect(readSource('src/desktop/index.html')).toContain('<title>WorkX</title>');
  });

  it('extension name is "WorkX"', () => {
    const messages = JSON.parse(readSource('_locales/en/messages.json'));
    expect(messages.extension_name.message).toBe('WorkX');
  });

  it('default agent prompt identifies as "WorkX"', () => {
    expect(readSource('src/prompts/default_workx_agent_prompt.md')).toContain('WorkX');
  });

  it('tauri.conf.json product identity is "WorkX" (space-free)', () => {
    const conf = JSON.parse(readSource('tauri/tauri.conf.json'));
    expect(conf.productName).toBe('WorkX');
    expect(conf.mainBinaryName).toBe('WorkX');
    expect(conf.app.windows[0].title).toBe('WorkX');
    expect(conf.identifier).toBe('com.airepublic.workx');
  });

  it('desktop title is not bare "Pi"', () => {
    expect(readSource('src/desktop/index.html')).not.toContain('<title>Pi</title>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deep links — workx:// canonical, applepi:// retained as fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('Deep links: workx:// canonical, applepi:// fallback', () => {
  it('registers both the workx (canonical) and applepi (legacy fallback) schemes', () => {
    const conf = JSON.parse(readSource('tauri/tauri.conf.json'));
    const schemes = conf.plugins['deep-link'].desktop.schemes;
    expect(schemes).toContain('workx');
    expect(schemes).toContain('applepi');
  });

  it('Linux desktop entry registers both scheme handlers', () => {
    const desktop = readSource('tauri/templates/linux-desktop.desktop');
    expect(desktop).toContain('Name=WorkX');
    expect(desktop).toContain('StartupWMClass=WorkX');
    expect(desktop).toContain('x-scheme-handler/workx');
    expect(desktop).toContain('x-scheme-handler/applepi');
  });

  it('login callback uses the canonical workx:// scheme', () => {
    expect(readSource('src/config/runtimeUrls.ts')).toContain('workx://auth/callback');
  });
});
