/**
 * Extension Manifest & Managed-Schema Guard-Rail Tests
 *
 * CI runs vitest + tsc but never builds the extension and loads it in Chrome,
 * so a manifest/managed-schema that Chrome rejects at load time still passes
 * every gate. These pure-JSON validators close that gap for the two failure
 * classes that shipped broken from birth (added in #263, unnoticed until a
 * production build was finally loaded):
 *
 *   1. `managed_storage` — not a real MV3 key; the schema must be declared as
 *      `storage.managed_schema`. Chrome logs "Unrecognized manifest key".
 *   2. managed-schema.json using Chrome's policy-schema dialect illegally
 *      (boolean `additionalProperties`, non-allowed types) → the extension
 *      fails to load with "Invalid type for attribute 'additionalProperties'".
 *
 * These assert on source manifests (root + src/extension). The post-build
 * artifact check (dist/, including the no-runtime-import() rule) lives in
 * scripts/validate-extension-build.mjs, run after the extension build in CI.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

// Root manifest.json is the single source manifest (scripts/build.js copies it
// into dist). A src/extension/manifest.json duplicate used to exist with no
// consumer and drifted (missing `key` + nativeMessaging) — deleted rather than
// kept in sync.
const MANIFEST_PATHS = ['manifest.json'];

/** Keys Chrome recognizes for MV3. Not exhaustive, but includes every key our
 *  manifests use plus the ones historically mis-spelled. A key outside this set
 *  is almost always a typo/invalid key that Chrome silently ignores. */
const KNOWN_MV3_KEYS = new Set([
  'manifest_version',
  'name',
  'version',
  'description',
  'default_locale',
  'icons',
  'action',
  'background',
  'permissions',
  'optional_permissions',
  'host_permissions',
  'optional_host_permissions',
  'content_scripts',
  'web_accessible_resources',
  'side_panel',
  'commands',
  'storage',
  'declarative_net_request',
  'content_security_policy',
  'externally_connectable',
  'options_page',
  'options_ui',
  'omnibox',
  'devtools_page',
  'chrome_url_overrides',
  'minimum_chrome_version',
  'update_url',
  'key',
]);

/** The Chrome policy-schema dialect (managed_schema) allows only these types
 *  and forbids boolean `additionalProperties`. */
const ALLOWED_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'integer',
  'number',
  'boolean',
]);

function readJson(relPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf-8'));
}

describe.each(MANIFEST_PATHS)('manifest: %s', (relPath) => {
  const manifest = readJson(relPath);

  it('is manifest v3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('does not use the invalid "managed_storage" key (use storage.managed_schema)', () => {
    expect(manifest).not.toHaveProperty('managed_storage');
  });

  it('declares a managed schema via storage.managed_schema, and the file exists', () => {
    // Only assert the shape when a managed schema is declared at all.
    if (!manifest.storage) return;
    expect(manifest.storage).toHaveProperty('managed_schema');
    const schemaFile = manifest.storage.managed_schema;
    expect(typeof schemaFile).toBe('string');
    // Referenced relative to the manifest's own directory.
    const manifestDir = path.dirname(path.join(ROOT, relPath));
    expect(fs.existsSync(path.join(manifestDir, schemaFile))).toBe(true);
  });

  it('uses no unknown top-level keys', () => {
    const unknown = Object.keys(manifest).filter((k) => !KNOWN_MV3_KEYS.has(k));
    expect(unknown).toEqual([]);
  });

  it('references only web_accessible_resources that exist in source', () => {
    const wars = manifest.web_accessible_resources ?? [];
    const manifestDir = path.dirname(path.join(ROOT, relPath));
    const missing: string[] = [];
    for (const entry of wars) {
      for (const res of entry.resources ?? []) {
        // Skip glob patterns — build-time artifacts (source maps, etc.).
        if (res.includes('*')) continue;
        // Source-truth only: never consult dist/ — a stale build artifact
        // there once masked a manifest entry (content.js.map) that a clean
        // CI checkout correctly rejected. Literal entries must exist in
        // source; build-produced files must be covered by a glob.
        const candidates = [
          path.join(manifestDir, res),
          path.join(ROOT, 'src', res),
        ];
        if (!candidates.some((c) => fs.existsSync(c))) missing.push(res);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('managed-schema.json conforms to Chrome policy-schema dialect', () => {
  // Discover schema files referenced by the manifests.
  const schemaFiles = Array.from(
    new Set(
      MANIFEST_PATHS.map((m) => {
        const manifest = readJson(m);
        const file = manifest?.storage?.managed_schema;
        return file ? path.join(path.dirname(m), file) : null;
      }).filter((f): f is string => Boolean(f)),
    ),
  );

  it('at least one managed schema is referenced (sanity)', () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
  });

  it.each(schemaFiles)('%s uses only allowed schema constructs', (relPath) => {
    const schema = readJson(relPath);

    const violations: string[] = [];
    const walk = (node: unknown, jsonPath: string) => {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;

      // Boolean additionalProperties is rejected by the policy dialect.
      if ('additionalProperties' in obj && typeof obj.additionalProperties === 'boolean') {
        violations.push(`${jsonPath}.additionalProperties is a boolean (unsupported)`);
      }
      if (typeof obj.type === 'string' && !ALLOWED_SCHEMA_TYPES.has(obj.type)) {
        violations.push(`${jsonPath}.type = "${obj.type}" is not an allowed type`);
      }
      if (obj.properties && typeof obj.properties === 'object') {
        for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
          walk(v, `${jsonPath}.properties.${k}`);
        }
      }
      if (obj.items) walk(obj.items, `${jsonPath}.items`);
    };
    walk(schema, '$');

    expect(violations).toEqual([]);
  });
});
