/**
 * Zod-based Config Access Control
 *
 * Replaces the flat settingsAllowlist with schema-driven access metadata.
 * Each config field carries its own Zod schema for validation and optional
 * LLM access metadata (traverse, read, write, label, description, etc.).
 *
 * Security boundary: fields without `meta.llm_access` are blocked by default.
 */

import { z } from 'zod';
import { isKeyLocked } from '../core/config/policy';

// ── Types ──────────────────────────────────────────────────────────────

/** Per-field LLM access metadata */
export interface LlmAccess {
  /** Allow LLM to traverse into sub-objects */
  traverse?: boolean;
  /** Allow LLM to read this field */
  read?: boolean;
  /** Allow LLM to write this field */
  write?: boolean;
  /** Human-readable label */
  label?: string;
  /** Description shown to LLM */
  description?: string;
  /** Grouping category */
  category?: string;
  /** Risk score 0-100 for approval integration */
  risk?: number;
  /** Legacy alias for backward compatibility (e.g., 'general.uiTheme') */
  alias?: string;
}

/** Wrapper carrying optional LLM access metadata */
export interface ConfigMeta {
  llm_access?: LlmAccess;
}

/** A config field definition: Zod schema + optional metadata */
export interface ConfigFieldDef {
  schema: z.ZodTypeAny;
  meta?: ConfigMeta;
}

/** A config section (e.g., 'preferences', 'tools', 'approval') */
export interface Section {
  /** Allow LLM to traverse into this section */
  traverse: boolean;
  /** Human-readable label */
  label: string;
  /** Description of this section */
  description: string;
  /** Grouping category */
  category: string;
  /** Fields within this section */
  fields: Record<string, ConfigFieldDef>;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Pair a Zod schema with optional metadata */
export function configField(schema: z.ZodTypeAny, meta?: ConfigMeta): ConfigFieldDef {
  return { schema, meta };
}

/** Shortcut for boolean tool toggle fields */
export function toolToggle(label: string, description: string, defaultValue = true): ConfigFieldDef {
  return configField(z.boolean().default(defaultValue), {
    llm_access: {
      read: true,
      write: true,
      label,
      description,
      category: 'tools',
    },
  });
}

// ── SECTIONS map ───────────────────────────────────────────────────────

export const SECTIONS: Record<string, Section> = {
  // Root-level fields (section key is empty string)
  '': {
    traverse: true,
    label: 'Root',
    description: 'Top-level configuration fields',
    category: 'model',
    fields: {
      selectedModelKey: configField(z.string(), {
        llm_access: {
          read: true,
          write: true,
          label: 'Model Selection',
          description: 'Currently active AI model in provider:modelKey format (e.g., openai:gpt-4o)',
          category: 'model',
          alias: 'model.selection',
        },
      }),
    },
  },

  preferences: {
    traverse: true,
    label: 'Preferences',
    description: 'User preferences and UI settings',
    category: 'general',
    fields: {
      uiTheme: configField(
        z.enum(['terminal', 'modern-auto', 'modern-light', 'modern-dark']).default('modern-auto'),
        {
          llm_access: {
            read: true,
            write: true,
            label: 'UI Theme',
            description:
              'Visual theme for the interface: terminal (retro), modern-auto (follows system), modern-light, or modern-dark',
            category: 'general',
            alias: 'general.uiTheme',
          },
        }
      ),
      theme: configField(z.enum(['light', 'dark', 'system']).default('system'), {
        llm_access: {
          read: true,
          write: true,
          label: 'Color Theme',
          description: 'System color scheme: light, dark, or follow system setting',
          category: 'general',
          alias: 'general.theme',
        },
      }),
      language: configField(z.string().default('en'), {
        llm_access: {
          read: true,
          write: true,
          label: 'Language',
          description: 'Preferred interface language (e.g., en, es, zh)',
          category: 'general',
          alias: 'general.language',
        },
      }),
      // Default persona mode for NEW conversations (WorkX only). The active
      // per-session mode is changed at runtime via SetSessionMode, not here.
      // When adding a mode, extend this enum and AgentMode in PromptComposer.
      defaultMode: configField(z.enum(['general', 'code']).default('general'), {
        llm_access: {
          read: true,
          write: true,
          label: 'Default Mode',
          description:
            'Default agent persona for new conversations: general (desktop automation) or code (software engineering)',
          category: 'general',
          alias: 'general.defaultMode',
        },
      }),
      // Plain fields — no LLM access
      // workspaceRoot is deliberately NOT llm_access: the agent must not be
      // able to relocate its own filesystem jail. User-set via folder picker.
      workspaceRoot: configField(z.string().optional()),
      autoSync: configField(z.boolean().default(true)),
      telemetryEnabled: configField(z.boolean().default(false)),
      useOwnApiKey: configField(z.boolean().optional()),
      showTokenUsage: configField(z.boolean().optional()),
      maxConcurrentSessions: configField(z.number().optional()),
      autoStartEnabled: configField(z.boolean().default(false)),
      shortcuts: configField(z.record(z.string()).default({})),
      experimental: configField(z.record(z.boolean()).default({})),
    },
  },

  tools: {
    traverse: true,
    label: 'Tools',
    description: 'Tool enable/disable toggles',
    category: 'tools',
    fields: {
      enable_all_tools: toolToggle(
        'Enable All Tools',
        'Master toggle to enable all browser tools at once',
        false
      ),
      storage_tool: toolToggle('Storage Tool', 'Enable the browser storage inspection tool'),
      tab_tool: toolToggle('Tab Tool', 'Enable the browser tab management tool'),
      web_scraping_tool: toolToggle('Web Scraping Tool', 'Enable the web page scraping tool', false),
      dom_tool: toolToggle('DOM Tool', 'Enable the DOM manipulation and interaction tool'),
      form_automation_tool: toolToggle(
        'Form Automation Tool',
        'Enable the form filling and automation tool',
        false
      ),
      navigation_tool: toolToggle('Navigation Tool', 'Enable the page navigation tool'),
      network_intercept_tool: toolToggle(
        'Network Intercept Tool',
        'Enable the network request interception tool',
        false
      ),
      data_extraction_tool: toolToggle(
        'Data Extraction Tool',
        'Enable the structured data extraction tool',
        false
      ),
      page_action_tool: toolToggle('Page Action Tool', 'Enable the page action automation tool'),
      page_vision_tool: toolToggle(
        'Page Vision Tool',
        'Enable the visual page analysis tool (requires model with image support)'
      ),
      setting_tool: toolToggle('Setting Tool', 'Enable the LLM settings access tool'),
      execCommand: toolToggle('Command Execution', 'Enable shell command execution', false),
      webSearch: toolToggle('Web Search', 'Enable web search capabilities'),
      fileOperations: toolToggle('File Operations', 'Enable file read/write operations', false),
      mcpTools: toolToggle('MCP Tools', 'Enable Model Context Protocol tools', false),
      dynamicToolLoading: configField(z.union([z.boolean(), z.literal('auto')]).default('auto')),
      dynamicToolLoadingThresholdPercent: configField(z.number().min(0).max(100).default(2)),
      alwaysLoadTools: configField(z.array(z.string()).default([])),
      deferTools: configField(z.array(z.string()).default([])),
      hiddenTools: configField(z.array(z.string()).default([])),
    },
  },

  approval: {
    traverse: true,
    label: 'Approval',
    description: 'Approval system configuration',
    category: 'approval',
    fields: {
      mode: configField(z.enum(['balanced', 'high_speed', 'yolo']).default('balanced'), {
        llm_access: {
          read: true,
          write: true,
          label: 'Approval Mode',
          description:
            'Controls how tool calls are approved: balanced (ask for medium+ risk), high_speed (ask for high+ risk), or yolo (auto-approve all)',
          category: 'approval',
          risk: 50,
        },
      }),
      trustedDomains: configField(z.array(z.string()).default([]), {
        llm_access: {
          read: true,
          write: true,
          label: 'Trusted Domains',
          description: 'Domains that are trusted for automatic approval of tool calls',
          category: 'approval',
        },
      }),
      blockedDomains: configField(z.array(z.string()).default([]), {
        llm_access: {
          read: true,
          write: true,
          label: 'Blocked Domains',
          description: 'Domains that are blocked from tool call execution',
          category: 'approval',
        },
      }),
      // Plain fields — no LLM access
      version: configField(z.string().default('1.0.0')),
      userRules: configField(z.array(z.any()).default([])),
    },
  },
};

// ── Resolution types ───────────────────────────────────────────────────

export interface ResolvedField {
  llm_access: LlmAccess;
  schema: z.ZodTypeAny;
  /** The canonical path (section.field or just field for root) */
  path: string;
}

export interface DeniedField {
  denied: true;
  reason: string;
}

export type ResolveResult = ResolvedField | DeniedField;

// ── Functions ──────────────────────────────────────────────────────────

/**
 * Resolve a dot-notation path to its field definition and check access.
 *
 * Paths:
 * - Root fields: just the field name (e.g., 'selectedModelKey')
 * - Section fields: 'section.field' (e.g., 'preferences.uiTheme', 'tools.dom_tool')
 *
 * Also checks aliases: if direct lookup fails, tries alias resolution.
 */
export function resolve(path: string, action: 'read' | 'write'): ResolveResult {
  // Try direct resolution first, then alias resolution.
  const result =
    resolveDirectPath(path, action) ??
    resolveByAlias(path, action) ?? {
      denied: true as const,
      reason: `Path "${path}" is not accessible`,
    };

  // Track 20: the LLM setting_tool is the third config write surface. Deny
  // writes to organization-managed (locked) paths using the resolver's
  // canonical path (covers alias resolution too).
  if (
    action === 'write' &&
    !('denied' in result) &&
    isKeyLocked('agent', result.path)
  ) {
    return {
      denied: true,
      reason: `Field "${result.path}" is managed by your organization and cannot be changed.`,
    };
  }

  return result;
}

function resolveDirectPath(path: string, action: 'read' | 'write'): ResolveResult | null {
  const dotIndex = path.indexOf('.');
  let sectionKey: string;
  let fieldName: string;

  if (dotIndex === -1) {
    // Could be a root-level field
    sectionKey = '';
    fieldName = path;
  } else {
    sectionKey = path.slice(0, dotIndex);
    fieldName = path.slice(dotIndex + 1);
  }

  const section = SECTIONS[sectionKey];
  if (!section) return null;

  const fieldDef = section.fields[fieldName];
  if (!fieldDef) return null;

  const access = fieldDef.meta?.llm_access;
  if (!access) {
    return { denied: true, reason: `Field "${path}" has no LLM access` };
  }

  if (action === 'read' && !access.read) {
    return { denied: true, reason: `Field "${path}" is not readable` };
  }

  if (action === 'write' && !access.write) {
    return { denied: true, reason: `Field "${path}" is not writable` };
  }

  const canonicalPath = sectionKey ? `${sectionKey}.${fieldName}` : fieldName;
  return { llm_access: access, schema: fieldDef.schema, path: canonicalPath };
}

/**
 * Resolve by scanning all fields for a matching alias.
 */
export function resolveByAlias(alias: string, action: 'read' | 'write'): ResolveResult | null {
  for (const [sectionKey, section] of Object.entries(SECTIONS)) {
    for (const [fieldName, fieldDef] of Object.entries(section.fields)) {
      const access = fieldDef.meta?.llm_access;
      if (access?.alias === alias) {
        if (action === 'read' && !access.read) {
          return { denied: true, reason: `Field "${alias}" (alias) is not readable` };
        }
        if (action === 'write' && !access.write) {
          return { denied: true, reason: `Field "${alias}" (alias) is not writable` };
        }
        const canonicalPath = sectionKey ? `${sectionKey}.${fieldName}` : fieldName;
        return { llm_access: access, schema: fieldDef.schema, path: canonicalPath };
      }
    }
  }
  return null;
}

/**
 * List all fields that have LLM access metadata.
 * Returns an array of { path, llm_access, schema }.
 */
export function listAccessibleFields(): ResolvedField[] {
  const result: ResolvedField[] = [];

  for (const [sectionKey, section] of Object.entries(SECTIONS)) {
    for (const [fieldName, fieldDef] of Object.entries(section.fields)) {
      const access = fieldDef.meta?.llm_access;
      if (access) {
        const path = sectionKey ? `${sectionKey}.${fieldName}` : fieldName;
        result.push({ path, llm_access: access, schema: fieldDef.schema });
      }
    }
  }

  return result;
}

/**
 * List accessible fields filtered by category.
 */
export function listByCategory(category: string): ResolvedField[] {
  return listAccessibleFields().filter((f) => f.llm_access.category === category);
}
