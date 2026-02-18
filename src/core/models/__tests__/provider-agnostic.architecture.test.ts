/**
 * Architecture Guard-Rail Tests: ResponseItem Provider-Agnostic Boundary
 *
 * These tests enforce the architectural boundary that keeps ResponseItem
 * and shared components provider-agnostic. They read source files and
 * assert that provider-specific concerns are contained within client classes.
 *
 * If any test fails, it means a provider-specific concern has leaked outside
 * its designated boundary (src/core/models/client/).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(__dirname, '../../../');

/** Provider SDK package names that must NOT appear outside client classes */
const BANNED_PROVIDER_SDK_PATTERNS = [
  'openai',
  '@google/genai',
  '@anthropic-ai/sdk',
  'groq-sdk',
  'fireworks',
  'together-ai',
];

/** Provider name substrings that should not appear in ResponseItem field names */
const PROVIDER_NAME_SUBSTRINGS = [
  'openai',
  'gemini',
  'groq',
  'anthropic',
  'fireworks',
  'together',
  'google',
  'xai',
];

/** The ONLY directory where provider SDK imports are allowed */
const ALLOWED_PROVIDER_DIR = path.join(SRC_ROOT, 'core/models/client');

/** Known shared component files that must remain provider-agnostic */
const SHARED_COMPONENTS = [
  'core/events/EventMapping.ts',
  'core/models/PromptHelpers.ts',
  'core/compact/CompactService.ts',
  'core/TurnManager.ts',
  'core/session/state/SessionState.ts',
  'core/session/state/SnapshotCompressor.ts',
  'core/TaskRunner.ts',
  'core/AgentTask.ts',
  'core/title/TitleGenerator.ts',
];

/** Known acceptable fields that contain provider-like substrings but are actually generic */
const ALLOWED_FIELD_EXCEPTIONS = ['thoughtSignature'];

/** Expected client files in the client/ directory */
const EXPECTED_CLIENT_FILES = [
  'OpenAIResponsesClient.ts',
  'OpenAIChatCompletionClient.ts',
  'GoogleCompletionClient.ts',
  'GroqClient.ts',
  'FireworksClient.ts',
  'FireworksChatCompletionClient.ts',
  'TogetherChatCompletionClient.ts',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSourceFile(relativePath: string): string {
  const fullPath = path.join(SRC_ROOT, relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}

function extractImportStatements(content: string): string[] {
  const importRegex = /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm;
  const imports: string[] = [];
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

function hasProviderSDKImport(content: string): string[] {
  const imports = extractImportStatements(content);
  return imports.filter((imp) =>
    BANNED_PROVIDER_SDK_PATTERNS.some((banned) => imp.startsWith(banned) || imp === banned)
  );
}

function hasProviderNameConditionals(content: string): string[] {
  const matches: string[] = [];
  for (const provider of ['openai', 'groq', 'google', 'xai', 'fireworks', 'together', 'anthropic']) {
    // Check for string equality comparisons with provider names
    const patterns = [
      new RegExp(`===\\s*['"]${provider}['"]`, 'gi'),
      new RegExp(`['"]${provider}['"]\\s*===`, 'gi'),
      new RegExp(`!==\\s*['"]${provider}['"]`, 'gi'),
      new RegExp(`['"]${provider}['"]\\s*!==`, 'gi'),
    ];
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        matches.push(provider);
        break;
      }
    }
  }
  return [...new Set(matches)];
}

/**
 * Recursively discover all .ts source files under a directory,
 * excluding __tests__/, node_modules/, __test-utils__/
 */
function discoverSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === '__test-utils__' ||
        entry.name === 'node_modules' ||
        entry.name === 'tests'
      ) {
        continue;
      }
      results.push(...discoverSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ===========================================================================
// US1: ResponseItem Import Boundary
// ===========================================================================

describe('ResponseItem Import Boundary', () => {
  it('ResponseItem type definition has zero provider SDK imports', () => {
    const content = readSourceFile('core/protocol/types.ts');
    const providerImports = hasProviderSDKImport(content);
    expect(
      providerImports,
      `Found provider SDK imports in types.ts: ${providerImports.join(', ')}`
    ).toHaveLength(0);
  });
});

// ===========================================================================
// US1: Field Neutrality
// ===========================================================================

describe('Field Neutrality', () => {
  it('ResponseItem field names are provider-neutral', () => {
    const content = readSourceFile('core/protocol/types.ts');

    // Extract the ResponseItem type block (from export type ResponseItem to the end)
    const responseItemMatch = content.match(/export type ResponseItem\s*=[\s\S]*?(?=\nexport\s|\n\/\*\*|\Z)/);
    expect(responseItemMatch).not.toBeNull();

    const responseItemBlock = responseItemMatch![0];

    // Extract all property names (word before : in the type definition)
    const propertyNames: string[] = [];
    const propRegex = /\b(\w+)\s*[?]?\s*:/g;
    let match;
    while ((match = propRegex.exec(responseItemBlock)) !== null) {
      // Exclude type discriminators and common keywords
      if (!['type', 'string', 'number', 'boolean', 'any', 'undefined', 'null'].includes(match[1])) {
        propertyNames.push(match[1]);
      }
    }

    const violations: string[] = [];
    for (const prop of propertyNames) {
      if (ALLOWED_FIELD_EXCEPTIONS.includes(prop)) continue;
      const propLower = prop.toLowerCase();
      for (const provider of PROVIDER_NAME_SUBSTRINGS) {
        if (propLower.includes(provider)) {
          violations.push(`Field "${prop}" contains provider name "${provider}"`);
        }
      }
    }

    expect(
      violations,
      `Provider-specific field names found in ResponseItem:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });

  it('ResponseItem metadata fields are opaque types', () => {
    const content = readSourceFile('core/protocol/types.ts');

    // Check that known metadata fields use primitive types
    const opaqueFields = ['thoughtSignature', 'reasoning_content', 'encrypted_content'];

    for (const field of opaqueFields) {
      const fieldRegex = new RegExp(`${field}\\??\\s*:\\s*(\\w+)`);
      const match = content.match(fieldRegex);
      if (match) {
        const fieldType = match[1];
        expect(
          ['string', 'number', 'boolean'].includes(fieldType),
          `Metadata field "${field}" has type "${fieldType}" which is not a primitive. ` +
            `Opaque metadata fields should use primitive types (string) to remain provider-agnostic.`
        ).toBe(true);
      }
    }
  });
});

// ===========================================================================
// US2: Client Containment
// ===========================================================================

describe('Client Containment', () => {
  it('Provider SDK imports exist only in client/ directory', () => {
    const allSourceFiles = discoverSourceFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const filePath of allSourceFiles) {
      // Skip files in the allowed provider directory
      if (filePath.startsWith(ALLOWED_PROVIDER_DIR + path.sep)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const providerImports = hasProviderSDKImport(content);

      if (providerImports.length > 0) {
        const relativePath = path.relative(SRC_ROOT, filePath);
        violations.push(
          `${relativePath} imports provider SDK: ${providerImports.join(', ')}`
        );
      }
    }

    expect(
      violations,
      `Provider SDK imports found outside client/ directory:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });

  it('All client subclasses are within client/ directory', () => {
    const clientDir = path.join(SRC_ROOT, 'core/models/client');
    const actualFiles = fs
      .readdirSync(clientDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

    // Verify expected client files exist
    for (const expected of EXPECTED_CLIENT_FILES) {
      expect(
        actualFiles.includes(expected),
        `Expected client file "${expected}" not found in client/ directory`
      ).toBe(true);
    }

    // Check for unexpected files (new clients that need to be added to the expected list)
    const unexpected = actualFiles.filter((f) => !EXPECTED_CLIENT_FILES.includes(f));
    expect(
      unexpected,
      `Unexpected files in client/ directory (update EXPECTED_CLIENT_FILES if these are new clients): ${unexpected.join(', ')}`
    ).toHaveLength(0);
  });
});

// ===========================================================================
// US2: Shared Component Isolation
// ===========================================================================

describe('Shared Component Isolation', () => {
  it('Shared components have zero provider-specific branching', () => {
    const violations: string[] = [];

    for (const relPath of SHARED_COMPONENTS) {
      const fullPath = path.join(SRC_ROOT, relPath);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const providerConditionals = hasProviderNameConditionals(content);

      if (providerConditionals.length > 0) {
        violations.push(
          `${relPath} contains provider-specific conditionals: ${providerConditionals.join(', ')}`
        );
      }
    }

    expect(
      violations,
      `Provider-specific branching found in shared components:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });

  it('Shared components have zero provider SDK imports', () => {
    const violations: string[] = [];

    for (const relPath of SHARED_COMPONENTS) {
      const fullPath = path.join(SRC_ROOT, relPath);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const providerImports = hasProviderSDKImport(content);

      if (providerImports.length > 0) {
        violations.push(
          `${relPath} imports provider SDK: ${providerImports.join(', ')}`
        );
      }
    }

    expect(
      violations,
      `Provider SDK imports found in shared components:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });

  // US3: EventMapping specific check
  it('EventMapping has zero provider-specific code paths', () => {
    const content = readSourceFile('core/events/EventMapping.ts');

    // Check: no provider SDK imports
    const providerImports = hasProviderSDKImport(content);
    expect(
      providerImports,
      `EventMapping.ts imports provider SDK: ${providerImports.join(', ')}`
    ).toHaveLength(0);

    // Check: no provider name conditionals
    const providerConditionals = hasProviderNameConditionals(content);
    expect(
      providerConditionals,
      `EventMapping.ts contains provider-specific conditionals: ${providerConditionals.join(', ')}`
    ).toHaveLength(0);
  });

  // US3: ResponseEvent type check
  it('ResponseEvent type definition is provider-agnostic', () => {
    const content = readSourceFile('core/models/types/ResponseEvent.ts');

    // Check: no provider SDK imports
    const providerImports = hasProviderSDKImport(content);
    expect(
      providerImports,
      `ResponseEvent.ts imports provider SDK: ${providerImports.join(', ')}`
    ).toHaveLength(0);
  });
});
