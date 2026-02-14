/**
 * Contract Test: DOMTool Content Script File Path
 *
 * Verifies CI-2 contract invariant from specs/018-inspect-the-domtool/contracts/file-paths.md
 * Rule: All chrome.scripting.executeScript calls MUST use file paths matching the manifest
 *
 * This test ensures the file path referenced in DOMTool matches the manifest.json
 * content_scripts declaration and prevents regression to the incorrect path.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('DOMTool File Path Contract (CI-2)', () => {
  it('should use file path matching manifest content_scripts', () => {
    // Given: Load manifest.json
    const manifestPath = path.resolve(__dirname, '../../manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Extract declared content script path
    const manifestScriptPath = manifest.content_scripts[0].js[0];
    const expectedPath = '/' + manifestScriptPath;

    // When: Check the constant defined in DOMTool
    const domToolPath = path.resolve(__dirname, '../../src/tools/DOMTool.ts');
    const domToolSource = fs.readFileSync(domToolPath, 'utf-8');

    // Extract CONTENT_SCRIPT_PATH constant value
    const constantMatch = domToolSource.match(/const CONTENT_SCRIPT_PATH = ['"]([^'"]+)['"]/);
    expect(constantMatch, 'CONTENT_SCRIPT_PATH constant not found in DOMTool.ts').toBeTruthy();

    const actualPath = constantMatch![1];

    // Then: They must match
    expect(actualPath).toBe(expectedPath);
    expect(actualPath).toBe('/content.js');
  });

  it('should not use legacy incorrect path', () => {
    // Given: Load DOMTool source
    const domToolPath = path.resolve(__dirname, '../../src/tools/DOMTool.ts');
    const domToolSource = fs.readFileSync(domToolPath, 'utf-8');

    // When: Check for incorrect path references
    const hasOldPath = domToolSource.includes("'/content/content-script.js'") ||
                       domToolSource.includes('"/content/content-script.js"');

    // Then: Old path should not be present
    expect(hasOldPath).toBe(false);
  });

  it('should use CONTENT_SCRIPT_PATH constant (not hardcoded string)', () => {
    // Given: Load DOMTool source
    const domToolPath = path.resolve(__dirname, '../../src/tools/DOMTool.ts');
    const domToolSource = fs.readFileSync(domToolPath, 'utf-8');

    // When: Check executeScript call uses the constant
    // Find the executeScript call and verify it uses CONTENT_SCRIPT_PATH (multiline match)
    const executeScriptMatch = domToolSource.match(/chrome\.scripting\.executeScript\s*\(\s*\{[\s\S]*?files:\s*\[([^\]]+)\]/);
    expect(executeScriptMatch, 'executeScript call not found').toBeTruthy();

    const filesParam = executeScriptMatch![1].trim();

    // Then: Should use constant, not hardcoded string
    expect(filesParam).toBe('CONTENT_SCRIPT_PATH');
    expect(filesParam).not.toBe("'/content.js'");
    expect(filesParam).not.toBe('"/content.js"');
  });

  it('should have CONTENT_SCRIPT_PATH constant defined with correct value', () => {
    // Given: Load DOMTool source
    const domToolPath = path.resolve(__dirname, '../../src/tools/DOMTool.ts');
    const domToolSource = fs.readFileSync(domToolPath, 'utf-8');

    // When: Extract constant value
    const constantMatch = domToolSource.match(/const CONTENT_SCRIPT_PATH = ['"]([^'"]+)['"]/);
    expect(constantMatch, 'CONTENT_SCRIPT_PATH constant not found').toBeTruthy();

    const constantValue = constantMatch![1];

    // Then: Value should match expected path
    expect(constantValue).toBe('/content.js');
  });

  it('should have documentation comment linking to contract', () => {
    // Given: Load DOMTool source
    const domToolPath = path.resolve(__dirname, '../../src/tools/DOMTool.ts');
    const domToolSource = fs.readFileSync(domToolPath, 'utf-8');

    // When: Check for contract reference in comments
    const hasContractReference = domToolSource.includes('specs/018-inspect-the-domtool/contracts/file-paths.md');

    // Then: Contract reference should be present
    expect(hasContractReference).toBe(true);
  });
});

describe('Vite Build Output Contract (CI-1)', () => {
  it('should have Vite config output matching manifest', () => {
    // Given: Load vite.config.mjs
    const viteConfigPath = path.resolve(__dirname, '../../vite.config.mjs');
    const viteConfig = fs.readFileSync(viteConfigPath, 'utf-8');

    // Load manifest.json
    const manifestPath = path.resolve(__dirname, '../../manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifestScriptPath = manifest.content_scripts[0].js[0];

    // When: Extract input key from Vite config
    const inputMatch = viteConfig.match(/content:\s*resolve\([^)]+\)/);
    expect(inputMatch, 'Vite config content input not found').toBeTruthy();

    // Extract entryFileNames pattern
    const entryMatch = viteConfig.match(/entryFileNames:\s*['"]([^'"]+)['"]/);
    expect(entryMatch, 'Vite config entryFileNames not found').toBeTruthy();

    const entryPattern = entryMatch![1];

    // Then: Pattern should produce manifest filename
    // Pattern '[name].js' with input key 'content' → 'content.js'
    expect(entryPattern).toBe('[name].js');
    expect(manifestScriptPath).toBe('content.js');
  });
});
