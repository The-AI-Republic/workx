/**
 * Skills Service Handlers
 *
 * Platform-agnostic service handlers for skill management.
 * Extracted from extension service-worker setupSkillsMessageHandlers().
 *
 * Note: skills.import requires a platform-specific `fetchFn` for URL fetching,
 * since fetch() behaves differently across Chrome extension, Tauri, and Node.
 *
 * @module core/services/skills-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface SkillsServiceDeps {
  skillRegistry: {
    getSkillMetas(): unknown;
    /**
     * Returns the full unfiltered skill catalog. Distinct from
     * `getSkillMetas()` which is domain-filtered when a SkillDomainFilter
     * is attached. The typeahead UI uses this so the user always sees the
     * full set regardless of the active tab.
     */
    getAllSkillMetas?(): unknown;
    invoke(name: string, args: string[]): unknown;
    save(skill: unknown): Promise<void>;
    delete(name: string): Promise<void>;
    updateInvocationMode(name: string, mode: unknown): Promise<void>;
    importFromContent(content: string, sourceUrl: string): Promise<unknown>;
    export(name: string): Promise<string | null>;
    trustSkill(name: string): Promise<void>;
  };
  /** Platform-specific fetch function for importing skills from URLs */
  fetchFn?: (url: string) => Promise<{ ok: boolean; statusText: string; text(): Promise<string> }>;
}

export function createSkillsServices(deps: SkillsServiceDeps): Record<string, ServiceHandler> {
  const { skillRegistry, fetchFn = fetch } = deps;

  return {
    // Typeahead surface — show ALL skills, not just domain-filtered ones,
    // so the user can always invoke any skill via /name regardless of tab.
    'skills.list': async () => {
      return skillRegistry.getAllSkillMetas?.() ?? skillRegistry.getSkillMetas();
    },

    'skills.load': async (params) => {
      const { name, args } = params as { name: string; args?: string };
      return skillRegistry.invoke(name, args ? args.split(/\s+/) : []);
    },

    'skills.save': async (params) => {
      await skillRegistry.save(params);
      return { success: true };
    },

    'skills.delete': async (params) => {
      const { name } = params as { name: string };
      await skillRegistry.delete(name);
      return { success: true };
    },

    'skills.updateMode': async (params) => {
      const { name, mode } = params as { name: string; mode: unknown };
      await skillRegistry.updateInvocationMode(name, mode);
      return { success: true };
    },

    'skills.import': async (params) => {
      const { url } = params as { url: string };

      // Validate URL scheme at the service boundary
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP/HTTPS URLs are supported for skill import');
      }

      const response = await fetchFn(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch skill from ${url}: ${response.statusText}`);
      }
      const content = await response.text();

      const skill = await skillRegistry.importFromContent(content, url);
      return { success: true, skill };
    },

    'skills.export': async (params) => {
      const { name } = params as { name: string };
      const content = await skillRegistry.export(name);
      return { success: true, content };
    },

    'skills.trust': async (params) => {
      const { name } = params as { name: string };
      await skillRegistry.trustSkill(name);
      return { success: true };
    },
  };
}
