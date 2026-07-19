/**
 * Unit tests for configSchema — Zod-based config access control
 */

import { describe, it, expect } from 'vitest';
import {
  resolve,
  resolveByAlias,
  listAccessibleFields,
  listByCategory,
  SECTIONS,
  configField,
  toolToggle,
  type ResolvedField,
  type DeniedField,
} from '../configSchema';
import { z } from 'zod';

// ── Helpers ──────────────────────────────────────────────────────────────

function isResolved(r: any): r is ResolvedField {
  return r && 'llm_access' in r;
}

function isDenied(r: any): r is DeniedField {
  return r && 'denied' in r;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('configSchema', () => {
  // ── resolve() ────────────────────────────────────────────────────────

  describe('resolve()', () => {
    it('resolves accessible section fields', () => {
      const result = resolve('preferences.uiTheme', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.llm_access.label).toBe('UI Theme');
        expect(result.path).toBe('preferences.uiTheme');
      }
    });

    it('resolves accessible root fields', () => {
      const result = resolve('selectedModelKey', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.llm_access.label).toBe('Model Selection');
        expect(result.path).toBe('selectedModelKey');
      }
    });

    it('resolves tool toggles', () => {
      const result = resolve('tools.dom_tool', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.llm_access.label).toBe('DOM Tool');
        expect(result.llm_access.category).toBe('tools');
      }
    });

    it('resolves approval fields', () => {
      const result = resolve('approval.mode', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.llm_access.label).toBe('Approval Mode');
        expect(result.llm_access.risk).toBe(50);
      }
    });

    it('resolves for write action', () => {
      const result = resolve('tools.dom_tool', 'write');
      expect(isResolved(result)).toBe(true);
    });
  });

  // ── resolve() with aliases ──────────────────────────────────────────

  describe('resolve() with aliases', () => {
    it('resolves general.uiTheme alias to preferences.uiTheme', () => {
      const result = resolve('general.uiTheme', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.path).toBe('preferences.uiTheme');
        expect(result.llm_access.label).toBe('UI Theme');
      }
    });

    it('resolves general.theme alias', () => {
      const result = resolve('general.theme', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.path).toBe('preferences.theme');
      }
    });

    it('resolves general.language alias', () => {
      const result = resolve('general.language', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.path).toBe('preferences.language');
      }
    });

    it('resolves model.selection alias to selectedModelKey', () => {
      const result = resolve('model.selection', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.path).toBe('selectedModelKey');
      }
    });

    it('resolves aliases for write action', () => {
      const result = resolve('general.uiTheme', 'write');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.path).toBe('preferences.uiTheme');
      }
    });

    it('resolves model.selection alias for write action', () => {
      const result = resolve('model.selection', 'write');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.path).toBe('selectedModelKey');
      }
    });
  });

  // ── resolve() blocked paths ─────────────────────────────────────────

  describe('resolve() blocked paths', () => {
    it('denies providers.openai.apiKey', () => {
      const result = resolve('providers.openai.apiKey', 'read');
      expect(isDenied(result)).toBe(true);
    });

    it('denies preferences.autoSync (no LLM access)', () => {
      const result = resolve('preferences.autoSync', 'read');
      expect(isDenied(result)).toBe(true);
    });

    it('denies completely unknown paths', () => {
      const result = resolve('nonexistent.field', 'read');
      expect(isDenied(result)).toBe(true);
    });

    it('denies empty path', () => {
      const result = resolve('', 'read');
      expect(isDenied(result)).toBe(true);
    });

    it('denies approval.version (plain field)', () => {
      const result = resolve('approval.version', 'read');
      expect(isDenied(result)).toBe(true);
    });

    it('denied result includes a reason string', () => {
      const result = resolve('preferences.autoSync', 'read');
      expect(isDenied(result)).toBe(true);
      if (isDenied(result)) {
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it('denied result for unknown path includes reason', () => {
      const result = resolve('providers.openai.apiKey', 'read');
      expect(isDenied(result)).toBe(true);
      if (isDenied(result)) {
        expect(result.reason).toContain('not accessible');
      }
    });

    it('denied result for plain field explains no LLM access', () => {
      const result = resolve('approval.userRules', 'read');
      expect(isDenied(result)).toBe(true);
      if (isDenied(result)) {
        expect(result.reason).toContain('no LLM access');
      }
    });
  });

  // ── resolveByAlias() ────────────────────────────────────────────────

  describe('resolveByAlias()', () => {
    it('resolves general.uiTheme alias', () => {
      const result = resolveByAlias('general.uiTheme', 'read');
      expect(result).not.toBeNull();
      expect(isResolved(result!)).toBe(true);
      if (isResolved(result!)) {
        expect(result!.path).toBe('preferences.uiTheme');
      }
    });

    it('resolves alias for write action', () => {
      const result = resolveByAlias('model.selection', 'write');
      expect(result).not.toBeNull();
      expect(isResolved(result!)).toBe(true);
      if (isResolved(result!)) {
        expect(result!.path).toBe('selectedModelKey');
      }
    });

    it('returns null for non-existent alias', () => {
      const result = resolveByAlias('nonexistent.alias', 'read');
      expect(result).toBeNull();
    });
  });

  // ── listAccessibleFields() ──────────────────────────────────────────

  describe('listAccessibleFields()', () => {
    it('returns all fields with LLM access', () => {
      const fields = listAccessibleFields();
      expect(fields.length).toBeGreaterThanOrEqual(20);
    });

    it('includes expected paths', () => {
      const fields = listAccessibleFields();
      const paths = fields.map((f) => f.path);
      expect(paths).toContain('selectedModelKey');
      expect(paths).toContain('preferences.uiTheme');
      expect(paths).toContain('preferences.theme');
      expect(paths).toContain('preferences.language');
      expect(paths).toContain('tools.dom_tool');
      expect(paths).toContain('tools.enable_all_tools');
      expect(paths).toContain('tools.dataSources');
      expect(paths).toContain('approval.mode');
      expect(paths).toContain('approval.trustedDomains');
      expect(paths).toContain('approval.blockedDomains');
    });

    it('includes all 17 tool toggle paths', () => {
      const fields = listAccessibleFields();
      const paths = fields.map((f) => f.path);
      const expectedToolPaths = [
        'tools.enable_all_tools',
        'tools.storage_tool',
        'tools.tab_tool',
        'tools.web_scraping_tool',
        'tools.dom_tool',
        'tools.form_automation_tool',
        'tools.navigation_tool',
        'tools.network_intercept_tool',
        'tools.data_extraction_tool',
        'tools.page_action_tool',
        'tools.page_vision_tool',
        'tools.setting_tool',
        'tools.execCommand',
        'tools.webSearch',
        'tools.dataSources',
        'tools.fileOperations',
        'tools.mcpTools',
      ];
      for (const tp of expectedToolPaths) {
        expect(paths).toContain(tp);
      }
    });

    it('excludes plain fields without LLM access', () => {
      const fields = listAccessibleFields();
      const paths = fields.map((f) => f.path);
      expect(paths).not.toContain('preferences.autoSync');
      expect(paths).not.toContain('preferences.telemetryEnabled');
      expect(paths).not.toContain('approval.version');
    });

    it('all returned fields have llm_access', () => {
      const fields = listAccessibleFields();
      for (const field of fields) {
        expect(field.llm_access).toBeDefined();
      }
    });
  });

  // ── listByCategory() ───────────────────────────────────────────────

  describe('listByCategory()', () => {
    it('filters by tools category', () => {
      const fields = listByCategory('tools');
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.every((f) => f.llm_access.category === 'tools')).toBe(true);
    });

    it('filters by approval category', () => {
      const fields = listByCategory('approval');
      expect(fields.length).toBe(3); // mode, trustedDomains, blockedDomains
      expect(fields.every((f) => f.llm_access.category === 'approval')).toBe(true);
    });

    it('filters by general category', () => {
      const fields = listByCategory('general');
      expect(fields.length).toBe(4); // uiTheme, theme, language, defaultMode
      expect(fields.every((f) => f.llm_access.category === 'general')).toBe(true);
    });

    it('filters by model category', () => {
      const fields = listByCategory('model');
      expect(fields.length).toBe(1); // selectedModelKey
    });

    it('returns empty for unknown category', () => {
      const fields = listByCategory('nonexistent');
      expect(fields.length).toBe(0);
    });
  });

  // ── Zod validation ─────────────────────────────────────────────────

  describe('Zod validation', () => {
    it('uiTheme schema accepts valid values', () => {
      const result = resolve('preferences.uiTheme', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('terminal').success).toBe(true);
        expect(result.schema.safeParse('modern-auto').success).toBe(true);
        expect(result.schema.safeParse('modern-light').success).toBe(true);
        expect(result.schema.safeParse('modern-dark').success).toBe(true);
      }
    });

    it('uiTheme schema rejects invalid values', () => {
      const result = resolve('preferences.uiTheme', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('chatgpt').success).toBe(false);
        expect(result.schema.safeParse('invalid').success).toBe(false);
      }
    });

    it('approval.mode schema accepts valid enum values', () => {
      const result = resolve('approval.mode', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('balanced').success).toBe(true);
        expect(result.schema.safeParse('high_speed').success).toBe(true);
        expect(result.schema.safeParse('yolo').success).toBe(true);
      }
    });

    it('approval.mode schema rejects invalid values', () => {
      const result = resolve('approval.mode', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('invalid_mode').success).toBe(false);
      }
    });

    it('boolean tool toggle schema accepts true/false', () => {
      const result = resolve('tools.dom_tool', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse(true).success).toBe(true);
        expect(result.schema.safeParse(false).success).toBe(true);
      }
    });

    it('boolean tool toggle schema rejects non-boolean', () => {
      const result = resolve('tools.dom_tool', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('yes').success).toBe(false);
        expect(result.schema.safeParse(123).success).toBe(false);
      }
    });

    it('trustedDomains schema accepts string arrays', () => {
      const result = resolve('approval.trustedDomains', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse(['example.com', 'test.org']).success).toBe(true);
        expect(result.schema.safeParse([]).success).toBe(true);
      }
    });

    it('trustedDomains schema rejects non-arrays', () => {
      const result = resolve('approval.trustedDomains', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('not-an-array').success).toBe(false);
        expect(result.schema.safeParse([123]).success).toBe(false);
      }
    });

    it('theme schema accepts valid values', () => {
      const result = resolve('preferences.theme', 'read');
      expect(isResolved(result)).toBe(true);
      if (isResolved(result)) {
        expect(result.schema.safeParse('light').success).toBe(true);
        expect(result.schema.safeParse('dark').success).toBe(true);
        expect(result.schema.safeParse('system').success).toBe(true);
        expect(result.schema.safeParse('invalid').success).toBe(false);
      }
    });
  });

  // ── Defaults match defaults.ts ─────────────────────────────────────

  describe('schema defaults match defaults.ts', () => {
    it('uiTheme defaults to modern-auto', () => {
      const field = SECTIONS.preferences.fields.uiTheme;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toBe('modern-auto');
    });

    it('theme defaults to system', () => {
      const field = SECTIONS.preferences.fields.theme;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toBe('system');
    });

    it('language defaults to en', () => {
      const field = SECTIONS.preferences.fields.language;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toBe('en');
    });

    it('enable_all_tools defaults to false', () => {
      const field = SECTIONS.tools.fields.enable_all_tools;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toBe(false);
    });

    it('tool toggles with default true', () => {
      const trueDefaults = [
        'storage_tool',
        'tab_tool',
        'dom_tool',
        'navigation_tool',
        'page_action_tool',
        'page_vision_tool',
        'setting_tool',
        'webSearch',
        'dataSources',
      ];
      for (const name of trueDefaults) {
        const field = SECTIONS.tools.fields[name];
        expect(field.schema.parse(undefined)).toBe(true);
      }
    });

    it('tool toggles with default false', () => {
      const falseDefaults = [
        'enable_all_tools',
        'web_scraping_tool',
        'form_automation_tool',
        'network_intercept_tool',
        'data_extraction_tool',
        'execCommand',
        'fileOperations',
        'mcpTools',
      ];
      for (const name of falseDefaults) {
        const field = SECTIONS.tools.fields[name];
        expect(field.schema.parse(undefined)).toBe(false);
      }
    });

    it('approval.mode defaults to balanced', () => {
      const field = SECTIONS.approval.fields.mode;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toBe('balanced');
    });

    it('trustedDomains defaults to empty array', () => {
      const field = SECTIONS.approval.fields.trustedDomains;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toEqual([]);
    });

    it('blockedDomains defaults to empty array', () => {
      const field = SECTIONS.approval.fields.blockedDomains;
      const parsed = field.schema.parse(undefined);
      expect(parsed).toEqual([]);
    });
  });

  // ── Helper functions ───────────────────────────────────────────────

  describe('configField() helper', () => {
    it('creates a field def with schema only', () => {
      const field = configField(z.string());
      expect(field.schema).toBeDefined();
      expect(field.meta).toBeUndefined();
    });

    it('creates a field def with schema and meta', () => {
      const field = configField(z.string(), {
        llm_access: { read: true, label: 'Test' },
      });
      expect(field.schema).toBeDefined();
      expect(field.meta?.llm_access?.label).toBe('Test');
      expect(field.meta?.llm_access?.read).toBe(true);
    });
  });

  describe('toolToggle() helper', () => {
    it('creates a boolean field with LLM access and default true', () => {
      const field = toolToggle('My Tool', 'Description of tool');
      expect(field.schema.parse(undefined)).toBe(true);
      expect(field.meta?.llm_access?.label).toBe('My Tool');
      expect(field.meta?.llm_access?.description).toBe('Description of tool');
      expect(field.meta?.llm_access?.category).toBe('tools');
      expect(field.meta?.llm_access?.read).toBe(true);
      expect(field.meta?.llm_access?.write).toBe(true);
    });

    it('creates a boolean field with custom default false', () => {
      const field = toolToggle('Risky Tool', 'A risky tool', false);
      expect(field.schema.parse(undefined)).toBe(false);
    });

    it('schema rejects non-boolean values', () => {
      const field = toolToggle('Test', 'test');
      expect(field.schema.safeParse('yes').success).toBe(false);
      expect(field.schema.safeParse(42).success).toBe(false);
    });
  });

  // ── SECTIONS structural integrity ─────────────────────────────────

  describe('SECTIONS integrity', () => {
    it('all sections have required properties', () => {
      for (const [key, section] of Object.entries(SECTIONS)) {
        expect(typeof section.traverse).toBe('boolean');
        expect(typeof section.label).toBe('string');
        expect(section.label.length).toBeGreaterThan(0);
        expect(typeof section.description).toBe('string');
        expect(typeof section.category).toBe('string');
        expect(typeof section.fields).toBe('object');
        expect(Object.keys(section.fields).length).toBeGreaterThan(0);
      }
    });

    it('field names are unique within each section', () => {
      for (const [sectionKey, section] of Object.entries(SECTIONS)) {
        const fieldNames = Object.keys(section.fields);
        const unique = new Set(fieldNames);
        expect(unique.size).toBe(fieldNames.length);
      }
    });

    it('all field defs have a schema', () => {
      for (const section of Object.values(SECTIONS)) {
        for (const [name, field] of Object.entries(section.fields)) {
          expect(field.schema).toBeDefined();
        }
      }
    });

    it('accessible fields all have read and write permissions', () => {
      const fields = listAccessibleFields();
      for (const field of fields) {
        expect(field.llm_access.read).toBe(true);
        expect(field.llm_access.write).toBe(true);
      }
    });

    it('aliases are unique across all fields', () => {
      const aliases: string[] = [];
      for (const section of Object.values(SECTIONS)) {
        for (const field of Object.values(section.fields)) {
          if (field.meta?.llm_access?.alias) {
            aliases.push(field.meta.llm_access.alias);
          }
        }
      }
      const unique = new Set(aliases);
      expect(unique.size).toBe(aliases.length);
    });

    it('contains expected section keys', () => {
      const keys = Object.keys(SECTIONS);
      expect(keys).toContain('');
      expect(keys).toContain('preferences');
      expect(keys).toContain('tools');
      expect(keys).toContain('approval');
    });
  });
});
