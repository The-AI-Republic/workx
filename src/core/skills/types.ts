import { z } from 'zod';
import type { HooksConfig } from '@/core/hooks/types';

// ── Invocation Mode ──────────────────────────────────────────────

export type InvocationMode = 'manual' | 'auto' | 'hybrid';

// ── Command Registry DI Interface ────────────────────────────────
// Core modules must not import from extension layer directly.
// SkillRegistry accepts this interface via constructor injection.

export interface ICommandRegistry {
  register(registration: {
    name: string;
    description: string;
    argumentHint?: string;
    action: (args?: string) => void | Promise<void>;
  }): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
}

// ── Track 03 Extended Field Types ────────────────────────────────

export type SkillContext = 'inline' | 'fork';
export type SkillEffort = 'low' | 'medium' | 'high' | 'max' | number;
/** Model alias accepted in frontmatter — full ids also accepted as `string`. */
export type SkillModel = 'haiku' | 'sonnet' | 'opus' | 'inherit' | string;

// ── Skill (Full Record) ─────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  body: string;
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
  sourceUrl?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  compatibility?: string;
  createdAt: string;
  updatedAt: string;
  // ── Track 03: extended Claudy-parity + BrowserX-specific fields ──
  whenToUse?: string;
  argumentHint?: string;
  model?: SkillModel;
  effort?: SkillEffort;
  context?: SkillContext;
  agent?: string;
  hooks?: HooksConfig;
  /** Always normalized to string[]; YAML may supply string or string[]. */
  domains?: string[];
  /** Default true. */
  userInvocable?: boolean;
  /** Default false. */
  disableModelInvocation?: boolean;
  version?: string;
  // ── Track 10: plugin ownership ──
  /**
   * Plugin owner. Present when this skill was registered through a plugin
   * (manifest.skills slot); absent for user-created or URL-imported skills.
   * Used by `SkillRegistry.removeByPluginId` for scoped removal on plugin
   * disable. ID format: `<pluginName>@<marketplace>`.
   */
  pluginId?: string;
}

// ── SkillMeta (Level 1 — Lightweight) ───────────────────────────
// Includes the subset of extended fields needed for filtering/dispatch
// without loading the body. Phase 3 (domain filter) and Phase 4 (executor)
// read these pre-load.

export interface SkillMeta {
  name: string;
  description: string;
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
  // ── Track 03 projections ──
  whenToUse?: string;
  argumentHint?: string;
  context?: SkillContext;
  agent?: string;
  domains?: string[];
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  // ── Track 10 projection ──
  pluginId?: string;
}

// ── Parsed SKILL.md ─────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  compatibility?: string;
  // ── Track 03 extended fields (kebab-case as authored in YAML) ──
  'when-to-use'?: string;
  'argument-hint'?: string;
  model?: SkillModel;
  effort?: SkillEffort;
  context?: SkillContext;
  agent?: string;
  hooks?: HooksConfig;
  domains?: string | string[];
  'user-invocable'?: boolean | 'true' | 'false';
  'disable-model-invocation'?: boolean | 'true' | 'false';
  version?: string;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

// ── Skill with References (Level 3) ─────────────────────────────

export interface SkillWithReferences extends Skill {
  references: Record<string, string>;
}

// ── Zod Schemas ─────────────────────────────────────────────────

export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    'Name must be lowercase alphanumeric with hyphens, starting with a letter'
  );

export const invocationModeSchema = z
  .enum(['manual', 'auto', 'hybrid'])
  .default('manual');

const effortSchema = z.union([
  z.enum(['low', 'medium', 'high', 'max']),
  z.number().int().min(0),
]);

const booleanLikeSchema = z.union([z.boolean(), z.literal('true'), z.literal('false')]);

const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

// `HooksConfig` is keyed by HookEvent string; we accept any object shape here
// (validated at hook-registration time by HookRegistry.registerFromConfig).
const hooksConfigSchema = z.record(z.string(), z.array(z.unknown())).optional();

export const skillFrontmatterSchema = z
  .object({
    name: skillNameSchema,
    description: z.string().min(1).max(1024),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().optional(),
    compatibility: z.string().max(500).optional(),
    // ── Track 03 ──
    'when-to-use': z.string().max(2048).optional(),
    'argument-hint': z.string().max(256).optional(),
    model: z.string().optional(),
    effort: effortSchema.optional(),
    context: z.enum(['inline', 'fork']).optional(),
    agent: z.string().optional(),
    hooks: hooksConfigSchema,
    domains: stringOrStringArraySchema.optional(),
    'user-invocable': booleanLikeSchema.optional(),
    'disable-model-invocation': booleanLikeSchema.optional(),
    version: z.string().max(64).optional(),
  })
  .refine((s) => s.context !== 'fork' || !!s.agent, {
    message: "context='fork' requires `agent`",
    path: ['agent'],
  });

export const skillSchema = z.object({
  name: skillNameSchema,
  description: z.string().min(1).max(1024),
  body: z.string().min(1).max(51200),
  invocationMode: invocationModeSchema,
  trusted: z.boolean().default(true),
  source: z.enum(['user', 'imported']),
  sourceUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  compatibility: z.string().max(500).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // ── Track 03 normalized fields ──
  whenToUse: z.string().max(2048).optional(),
  argumentHint: z.string().max(256).optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
  context: z.enum(['inline', 'fork']).optional(),
  agent: z.string().optional(),
  hooks: hooksConfigSchema,
  domains: z.array(z.string()).optional(),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  version: z.string().max(64).optional(),
  // ── Track 10 ──
  pluginId: z.string().optional(),
});
