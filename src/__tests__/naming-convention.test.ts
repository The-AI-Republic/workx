/**
 * Naming Convention Guard-Rail Tests
 *
 * Enforces the three-tier naming convention from spec 022-project-rename-pi:
 *
 *   Tier 1 — Shared / Core    → uses "applepi"
 *   Tier 2 — Extension-specific → retains "browserx"
 *   Tier 3 — Desktop user-facing → uses "WorkX"
 *
 * Any rename that breaks these conventions will fail CI.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Direct imports for safely-exported constants ────────────────────────────

import { DB_NAME as CACHE_DB_NAME } from '../storage/IndexedDBAdapter';
import { DB_NAME as ROLLOUT_DB_NAME } from '../storage/rollout/types';
import { VISUAL_EFFECT_EVENT_NAME } from '../extension/content/ui_effect/contracts/domtool-events';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..');

/** Read a source file relative to project root. */
function readSource(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

/**
 * Strip import/require lines and single-line comments so that
 * `import ... from '../browserx/...'` doesn't create false positives
 * when scanning for forbidden string literals.
 */
function stripImportsAndComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('import ')) return false;
      if (trimmed.startsWith('from ')) return false;
      if (trimmed.startsWith('require(')) return false;
      if (trimmed.startsWith('//')) return false;
      if (trimmed.startsWith('*')) return false; // JSDoc / block-comment continuation
      return true;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1: Shared / Core → must use "applepi"
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 1: Shared/Core uses "applepi"', () => {
  it('IndexedDB cache DB name is "applepi_cache"', () => {
    expect(CACHE_DB_NAME).toBe('applepi_cache');
  });

  it('Rollout DB name is "ApplePiRollouts"', () => {
    expect(ROLLOUT_DB_NAME).toBe('ApplePiRollouts');
  });

  it('RepublicAgent class is exported from src/core/RepublicAgent.ts', () => {
    const src = readSource('src/core/RepublicAgent.ts');
    expect(src).toContain('export class RepublicAgent');
  });

  it('AgentConfig credential service is "applepi"', () => {
    const src = readSource('src/config/AgentConfig.ts');
    expect(src).toMatch(/CREDENTIAL_SERVICE\s*=\s*['"]applepi['"]/);
  });

  it('Runtime credential store service prefix defaults to "applepi"', () => {
    // Track 43: KeytarCredentialStore (WebView) was deleted. The keychain
    // service prefix now lives on the runtime side, in the
    // ControlFrameCredentialStore default and in the Rust handshake.
    const src = readSource('src/desktop-runtime/credentials/ControlFrameCredentialStore.ts');
    expect(src).toMatch(/servicePrefix\s*=\s*['"]applepi['"]/);
  });

  it('Desktop hotkeys use "applepi:" event prefix', () => {
    const src = readSource('src/desktop/hotkeys.ts');
    expect(src).toContain("'applepi:focus-input'");
    expect(src).toContain("'applepi:quick-action'");
  });

  it('PromptComposer AgentType includes "applepi"', () => {
    const src = readSource('src/prompts/PromptComposer.ts');
    expect(src).toMatch(/AgentType\s*=.*['"]applepi['"]/);
  });

  it('GoogleDocAddon uses "data-applepi-injected" attribute', () => {
    const src = readSource('src/extension/tools/dom/addons/GoogleDocAddon.ts');
    expect(src).toContain('data-applepi-injected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: Extension-specific → retains "browserx"
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 2: Extension-specific retains "browserx"', () => {
  it('ChromeCredentialStore uses "browserx-credential:" prefix', () => {
    const src = readSource('src/extension/storage/ChromeCredentialStore.ts');
    expect(src).toMatch(/CREDENTIAL_PREFIX\s*=\s*['"]browserx-credential:['"]/);
  });

  it('DomService uses "browserx:show-visual-effect" event', () => {
    const src = readSource('src/extension/tools/dom/DomService.ts');
    expect(src).toContain('browserx:show-visual-effect');
  });

  it('content-script uses "browserx:" events and "browserx-" element IDs', () => {
    const src = readSource('src/extension/content/content-script.ts');
    expect(src).toContain('browserx:init-visual-effects');
    expect(src).toContain('browserx-visual-effects-host');
  });

  it('VISUAL_EFFECT_EVENT_NAME is "browserx:visual-effect"', () => {
    expect(VISUAL_EFFECT_EVENT_NAME).toBe('browserx:visual-effect');
  });

  it('TabManager groupTitle is "browserx"', () => {
    const src = readSource('src/core/TabManager.ts');
    expect(src).toMatch(/groupTitle\s*=\s*['"]browserx['"]/);
  });

  it('AgentSession tab group uses "browserx_s_" prefix', () => {
    const src = readSource('src/core/registry/AgentSession.ts');
    expect(src).toContain('browserx_s_');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3: Desktop user-facing → uses "WorkX"
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 3: Desktop user-facing uses "WorkX"', () => {
  it('desktop index.html title is "WorkX"', () => {
    const src = readSource('src/desktop/index.html');
    expect(src).toContain('<title>WorkX</title>');
  });

  it('default agent prompt identifies as "WorkX"', () => {
    const src = readSource('src/prompts/default_applepi_agent_prompt.md');
    expect(src).toContain('WorkX');
  });

  it('tauri.conf.json package identity is space-free', () => {
    const conf = JSON.parse(readSource('tauri/tauri.conf.json'));
    expect(conf.productName).toBe('WorkX');
    expect(conf.mainBinaryName).toBe('WorkX');
    expect(conf.app.windows[0].title).toBe('WorkX');
  });

  it('deep-link registers both legacy "applepi" and new "workx" schemes', () => {
    const conf = JSON.parse(readSource('tauri/tauri.conf.json'));
    const schemes = conf.plugins['deep-link'].desktop.schemes;
    // `applepi` is retained for backward compatibility; `workx` is the new
    // canonical scheme.
    expect(schemes).toContain('applepi');
    expect(schemes).toContain('workx');
  });

  it('Linux desktop scheme handler forwards callback URLs to WorkX (both schemes)', () => {
    const desktop = readSource('tauri/templates/linux-desktop.desktop');
    expect(desktop).toContain('Name=WorkX');
    expect(desktop).toContain('StartupWMClass=WorkX');
    expect(desktop).toContain('Exec={{exec}} %u');
    // Both the legacy and new scheme handlers are registered.
    expect(desktop).toContain('x-scheme-handler/applepi');
    expect(desktop).toContain('x-scheme-handler/workx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard-rails: Forbidden patterns in wrong layers
// ─────────────────────────────────────────────────────────────────────────────

describe('Guard-rails: no cross-tier naming leaks', () => {
  // Core/shared files must NOT contain 'browserx' string literals
  // (excluding imports, comments, and the AgentType union which intentionally includes both)
  const coreFiles: [string, string][] = [
    ['src/config/AgentConfig.ts', 'AgentConfig'],
    ['src/desktop-runtime/credentials/ControlFrameCredentialStore.ts', 'ControlFrameCredentialStore'],
    ['src/core/registry/AgentSession.ts', 'AgentSession'],
    ['src/desktop/hotkeys.ts', 'hotkeys'],
    ['src/extension/tools/dom/addons/GoogleDocAddon.ts', 'GoogleDocAddon'],
    ['src/desktop/index.html', 'desktop index.html'],
    ['src/storage/IndexedDBAdapter.ts', 'IndexedDBAdapter'],
  ];

  for (const [filePath, label] of coreFiles) {
    it(`${label} does not contain "browserx" string literals`, () => {
      const raw = readSource(filePath);
      const cleaned = stripImportsAndComments(raw);
      // Match 'browserx' or "browserx" as standalone string or prefix (e.g. 'browserx-foo')
      const matches = cleaned.match(/['"]browserx[^'"]*['"]/gi) ?? [];
      expect(
        matches,
        `Found forbidden "browserx" literal(s) in ${filePath}: ${matches.join(', ')}`,
      ).toHaveLength(0);
    });
  }

  // Extension code should not use 'applepi' or 'pi' for extension-specific identifiers
  // (only checking extension-layer files that should use 'browserx')
  it('ChromeCredentialStore does not use "applepi" or "pi" for its credential prefix', () => {
    const src = readSource('src/extension/storage/ChromeCredentialStore.ts');
    const cleaned = stripImportsAndComments(src);
    // Should not have applepi-credential: or pi-credential: prefix
    expect(cleaned).not.toMatch(/['"]applepi-credential:/);
    expect(cleaned).not.toMatch(/['"]pi-credential:/);
  });

  // Desktop user-facing title must not be bare "Pi" (should be "WorkX")
  it('desktop index.html title is not bare "Pi"', () => {
    const src = readSource('src/desktop/index.html');
    // Should not have <title>Pi</title> — must be "WorkX"
    expect(src).not.toContain('<title>Pi</title>');
  });
});
