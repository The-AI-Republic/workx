/**
 * Naming Convention Guard-Rail Tests
 *
 * Enforces the three-tier naming convention from spec 022-project-rename-pi:
 *
 *   Tier 1 — Shared / Core    → uses "applepi"
 *   Tier 2 — Extension-specific → retains "browserx"
 *   Tier 3 — Desktop user-facing → uses "Apple Pi"
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

  it('KeytarCredentialStore service prefix is "applepi"', () => {
    const src = readSource('src/desktop/storage/KeytarCredentialStore.ts');
    expect(src).toMatch(/SERVICE_PREFIX\s*=\s*['"]applepi['"]/);
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

  it('GoogleDocPlugin uses "data-applepi-injected" attribute', () => {
    const src = readSource('src/tools/dom/plugins/GoogleDocPlugin.ts');
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
    const src = readSource('src/tools/dom/DomService.ts');
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
// Tier 3: Desktop user-facing → uses "Apple Pi"
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 3: Desktop user-facing uses "Apple Pi"', () => {
  it('desktop index.html title is "Apple Pi"', () => {
    const src = readSource('src/desktop/index.html');
    expect(src).toContain('<title>Apple Pi</title>');
  });

  it('default agent prompt identifies as "Apple Pi"', () => {
    const src = readSource('src/prompts/default_pi_agent_prompt.md');
    expect(src).toContain('Apple Pi');
  });

  it('tauri.conf.json productName is "Apple Pi"', () => {
    const conf = JSON.parse(readSource('tauri/tauri.conf.json'));
    expect(conf.productName).toBe('Apple Pi');
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
    ['src/desktop/storage/KeytarCredentialStore.ts', 'KeytarCredentialStore'],
    ['src/core/registry/AgentSession.ts', 'AgentSession'],
    ['src/desktop/hotkeys.ts', 'hotkeys'],
    ['src/tools/dom/plugins/GoogleDocPlugin.ts', 'GoogleDocPlugin'],
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

  // Extension code should not use 'pi' for extension-specific identifiers
  // (only checking extension-layer files that should use 'browserx')
  it('ChromeCredentialStore does not use "pi" for its credential prefix', () => {
    const src = readSource('src/extension/storage/ChromeCredentialStore.ts');
    const cleaned = stripImportsAndComments(src);
    // Should not have pi-credential: prefix
    expect(cleaned).not.toMatch(/['"]pi-credential:/);
  });

  // Desktop user-facing title must not be bare "Pi" (should be "Apple Pi")
  it('desktop index.html title is not bare "Pi"', () => {
    const src = readSource('src/desktop/index.html');
    // Should not have <title>Pi</title> — must be "Apple Pi"
    expect(src).not.toContain('<title>Pi</title>');
  });
});
