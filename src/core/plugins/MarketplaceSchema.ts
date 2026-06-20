/**
 * MarketplaceSchema — Zod for `marketplace.json` (a git-backed catalogue
 * listing installable plugins). Mirrors claudy's PluginMarketplaceSchema,
 * trimmed to the WorkX type model.
 *
 * Reference: design.md § Marketplace (Phase 10b).
 */

import { z } from 'zod';

/** 40-char lowercase hex git SHA. */
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'sha must be 40-char lowercase hex');

/** Plugin source descriptor (matches PluginSource in types.ts at runtime). */
export const PluginSourceSchema = z.union([
  z.object({ type: z.literal('github'), repo: z.string(), ref: z.string().optional(), sha: gitShaSchema.optional() }),
  z.object({ type: z.literal('git'), url: z.string(), ref: z.string().optional(), sha: gitShaSchema.optional() }),
  z.object({ type: z.literal('url'), url: z.string(), ref: z.string().optional(), sha: gitShaSchema.optional() }),
  z.object({ type: z.literal('npm'), package: z.string(), version: z.string().optional(), registry: z.string().optional() }),
  z.object({ type: z.literal('path'), path: z.string() }),
]);

const PluginAuthorSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

export const MarketplaceEntrySchema = z.object({
  name: z.string().min(1),
  source: PluginSourceSchema,
  version: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Transitive deps (bare or `name@marketplace`). */
  dependencies: z.array(z.string()).optional(),
  /** Defaults true — the entry must have its own plugin.json on disk. */
  strict: z.boolean().optional(),
});
export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>;

export const MarketplaceSchema = z.object({
  name: z.string().min(1),
  owner: PluginAuthorSchema,
  description: z.string().optional(),
  plugins: z.array(MarketplaceEntrySchema),
  /** When true, plugins removed from the catalogue are auto-uninstalled. */
  forceRemoveDeletedPlugins: z.boolean().optional(),
  metadata: z
    .object({
      pluginRoot: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});
export type Marketplace = z.infer<typeof MarketplaceSchema>;
