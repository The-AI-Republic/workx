/**
 * PluginManifest — Zod schema for `plugin.json`.
 *
 * Mirrors claudy's `PluginManifestSchema` (claudy/utils/plugins/schemas.ts:884-898)
 * adapted to the BrowserX type model. The schema is composed by spreading
 * partial sub-schema shapes — each slot owns one top-level key and ships its
 * own union of accepted forms (string path | array | inline object).
 *
 * Lenient by default: unknown top-level keys are stripped (zod's default
 * `.strip`) so claudy plugins with `outputStyles`/`lspServers`/`channels`
 * still load — those slots are silently ignored. `.strict()` is only used
 * inside `/plugin validate` for plugin-author feedback.
 *
 * Reference: design.md § Manifest Schema (v1).
 */

import { z } from 'zod';

// ── Helper: memoized thunk for sub-schema construction ─────────────
// Mirrors claudy's `lazySchema` pattern. Each sub-schema is wrapped in
// a thunk so we can spread `.shape` without forcing construction at
// module load time (matters for self-references in nested schemas).

type SchemaFactory<T extends z.ZodTypeAny> = (() => T) & { _cached?: T };

function lazySchema<T extends z.ZodTypeAny>(fn: () => T): SchemaFactory<T> {
  const factory = (() => {
    if (!factory._cached) factory._cached = fn();
    return factory._cached;
  }) as SchemaFactory<T>;
  return factory;
}

// ── Shared sub-schemas ─────────────────────────────────────────────

/** Plugin name: kebab-case, alphanumeric + hyphens, must start with a letter. */
const pluginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    'Plugin name must be kebab-case (lowercase alphanumeric + hyphens, starting with a letter)',
  );

const PluginAuthorSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

const PluginUserConfigOptionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

const CommandMetadataSchema = z
  .object({
    source: z.string().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    argumentHint: z.string().optional(),
    whenToUse: z.string().optional(),
  })
  .refine((c) => Boolean(c.source) !== Boolean(c.content), {
    message: 'commands.<name> requires exactly one of `source` or `content`',
  });

// Permissive HooksConfig — full validation happens inside HookRegistry.registerFromConfig
const HooksConfigSchema = z.record(z.string(), z.array(z.unknown()));

// Permissive MCP server map — full validation happens inside MCPManager.addServer
const McpServerRecordSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

// BrowserX-specific extensions
const BrowserxExtensionSchema = z
  .object({
    domains: z.array(z.string()).optional(),
    platforms: z.array(z.enum(['desktop', 'extension', 'server'])).optional(),
  })
  .strict();

// ── Per-slot schemas (one top-level key each, .partial() spreadable) ─

const PluginManifestMetadataSchema = lazySchema(() =>
  z.object({
    name: pluginNameSchema,
    version: z.string().min(1),
    description: z.string().optional(),
    author: PluginAuthorSchema.optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  }),
);

const PluginManifestSkillsSchema = lazySchema(() =>
  z.object({
    skills: z.union([z.string(), z.array(z.string())]),
  }),
);

const PluginManifestHooksSchema = lazySchema(() =>
  z.object({
    hooks: z.union([
      z.string(),
      HooksConfigSchema,
      z.array(z.union([z.string(), HooksConfigSchema])),
    ]),
  }),
);

const PluginManifestMcpServersSchema = lazySchema(() =>
  z.object({
    mcpServers: z.union([
      z.string(),
      McpServerRecordSchema,
      z.array(z.union([z.string(), McpServerRecordSchema])),
    ]),
  }),
);

const PluginManifestAgentsSchema = lazySchema(() =>
  z.object({
    agents: z.union([z.string(), z.array(z.string())]),
  }),
);

const PluginManifestCommandsSchema = lazySchema(() =>
  z.object({
    commands: z.union([
      z.string(),
      z.array(z.string()),
      z.record(z.string(), CommandMetadataSchema),
    ]),
  }),
);

const PluginManifestSettingsSchema = lazySchema(() =>
  z.object({
    settings: z.record(z.string(), z.unknown()),
  }),
);

const PluginManifestUserConfigSchema = lazySchema(() =>
  z.object({
    userConfig: z.record(z.string().regex(/^[A-Za-z_]\w*$/), PluginUserConfigOptionSchema),
  }),
);

const PluginManifestBrowserxSchema = lazySchema(() =>
  z.object({
    browserx: BrowserxExtensionSchema,
  }),
);

// ── The composed manifest schema (lenient) ─────────────────────────
// Unknown top-level keys are stripped (zod default). Use `.strict()`
// only inside the validate command for plugin-author feedback.

export const PluginManifestSchema = z.object({
  ...PluginManifestMetadataSchema().shape,
  ...PluginManifestSkillsSchema().partial().shape,
  ...PluginManifestHooksSchema().partial().shape,
  ...PluginManifestMcpServersSchema().partial().shape,
  ...PluginManifestAgentsSchema().partial().shape,
  ...PluginManifestCommandsSchema().partial().shape,
  ...PluginManifestSettingsSchema().partial().shape,
  ...PluginManifestUserConfigSchema().partial().shape,
  ...PluginManifestBrowserxSchema().partial().shape,
});

/** Strict variant for `/plugin validate <path>` (Phase 10c plugin-author UX). */
export const PluginManifestStrictSchema = PluginManifestSchema.strict();
