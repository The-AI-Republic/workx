import { z } from 'zod';

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
}

// ── SkillMeta (Level 1 — Lightweight) ───────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
  invocationMode: InvocationMode;
  trusted: boolean;
  source: 'user' | 'imported';
}

// ── Parsed SKILL.md ─────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  compatibility?: string;
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

export const skillFrontmatterSchema = z.object({
  name: skillNameSchema,
  description: z.string().min(1).max(1024),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
  compatibility: z.string().max(500).optional(),
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
});
