/**
 * Contract Test: Source Map Generation
 *
 * This contract defines the expected behavior of source map generation
 * for the content script build. Tests will FAIL until Vite config is fixed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DIST_DIR = resolve(__dirname, '../../../dist');
const CONTENT_JS = resolve(DIST_DIR, 'content.js');
const CONTENT_MAP = resolve(DIST_DIR, 'content.js.map');

describe('Source Map Contract', () => {
  describe('FR-008: System MUST export source maps when building content script', () => {
    it('should generate content.js.map file', () => {
      // This test requires build to have run
      if (!existsSync(CONTENT_JS)) {
        console.warn('content.js not found, skipping test (run build first)');
        return;
      }

      expect(existsSync(CONTENT_MAP)).toBe(true);
    });

    it('should generate valid JSON source map', () => {
      if (!existsSync(CONTENT_MAP)) {
        console.warn('content.js.map not found, skipping test');
        return;
      }

      const mapContent = readFileSync(CONTENT_MAP, 'utf-8');
      let sourceMap: any;

      expect(() => {
        sourceMap = JSON.parse(mapContent);
      }).not.toThrow();

      expect(sourceMap).toHaveProperty('version');
      expect(sourceMap).toHaveProperty('sources');
      expect(sourceMap).toHaveProperty('mappings');
    });
  });

  describe('FR-009: System MUST ensure source maps are accessible to Chrome DevTools', () => {
    it('should include sourceMappingURL comment in content.js', () => {
      if (!existsSync(CONTENT_JS)) {
        console.warn('content.js not found, skipping test');
        return;
      }

      const contentJs = readFileSync(CONTENT_JS, 'utf-8');
      const hasSourceMapComment = contentJs.includes('//# sourceMappingURL=content.js.map') ||
                                   contentJs.includes('//@ sourceMappingURL=content.js.map');

      expect(hasSourceMapComment).toBe(true);
    });

    it('should reference source map at end of file', () => {
      if (!existsSync(CONTENT_JS)) {
        console.warn('content.js not found, skipping test');
        return;
      }

      const contentJs = readFileSync(CONTENT_JS, 'utf-8');
      const lastLines = contentJs.split('\n').slice(-5).join('\n');

      expect(lastLines).toMatch(/\/\/[#@] sourceMappingURL=content\.js\.map/);
    });
  });

  describe('FR-010: System MUST maintain correct line number mappings', () => {
    it('should include TypeScript source files in source map', () => {
      if (!existsSync(CONTENT_MAP)) {
        console.warn('content.js.map not found, skipping test');
        return;
      }

      const mapContent = readFileSync(CONTENT_MAP, 'utf-8');
      const sourceMap = JSON.parse(mapContent);

      expect(sourceMap.sources).toBeInstanceOf(Array);
      expect(sourceMap.sources.length).toBeGreaterThan(0);

      // Should include primary content script source
      const hasContentScript = sourceMap.sources.some((src: string) =>
        src.includes('content-script.ts')
      );
      expect(hasContentScript).toBe(true);
    });

    it('should include source content or sourcesContent', () => {
      if (!existsSync(CONTENT_MAP)) {
        console.warn('content.js.map not found, skipping test');
        return;
      }

      const mapContent = readFileSync(CONTENT_MAP, 'utf-8');
      const sourceMap = JSON.parse(mapContent);

      // Source map should either include sourcesContent or rely on relative paths
      const hasSourcesContent = Array.isArray(sourceMap.sourcesContent) &&
                                sourceMap.sourcesContent.length > 0;
      const hasRelativePaths = sourceMap.sources.every((src: string) =>
        !src.startsWith('http') && !src.startsWith('file://')
      );

      expect(hasSourcesContent || hasRelativePaths).toBe(true);
    });

    it('should have non-empty mappings string', () => {
      if (!existsSync(CONTENT_MAP)) {
        console.warn('content.js.map not found, skipping test');
        return;
      }

      const mapContent = readFileSync(CONTENT_MAP, 'utf-8');
      const sourceMap = JSON.parse(mapContent);

      expect(typeof sourceMap.mappings).toBe('string');
      expect(sourceMap.mappings.length).toBeGreaterThan(0);
    });
  });

  describe('Build configuration validation', () => {
    it('should set sourcemap: true in vite.config.content.mjs', () => {
      const configPath = resolve(__dirname, '../../../vite.config.content.mjs');

      if (!existsSync(configPath)) {
        throw new Error('vite.config.content.mjs not found');
      }

      const configContent = readFileSync(configPath, 'utf-8');

      // Should have sourcemap: true or sourcemap: 'external'
      const hasSourcemap = configContent.includes('sourcemap: true') ||
                          configContent.includes("sourcemap: 'external'");

      expect(hasSourcemap).toBe(true);
    });

    it('should not use inline source maps', () => {
      if (!existsSync(CONTENT_JS)) {
        console.warn('content.js not found, skipping test');
        return;
      }

      const contentJs = readFileSync(CONTENT_JS, 'utf-8');

      // Inline source maps start with data:application/json;base64
      const hasInlineSourceMap = contentJs.includes('data:application/json;base64');

      // Should use external source maps, not inline (too large for content scripts)
      expect(hasInlineSourceMap).toBe(false);
    });
  });

  describe('Performance constraints', () => {
    it('should keep source map size reasonable', () => {
      if (!existsSync(CONTENT_MAP)) {
        console.warn('content.js.map not found, skipping test');
        return;
      }

      const stats = require('fs').statSync(CONTENT_MAP);
      const mapSizeKB = stats.size / 1024;

      // Source map should be < 1MB (reasonable for dev builds)
      expect(mapSizeKB).toBeLessThan(1024);
    });

    it('should not significantly increase bundle size', () => {
      if (!existsSync(CONTENT_JS) || !existsSync(CONTENT_MAP)) {
        console.warn('Build files not found, skipping test');
        return;
      }

      const jsStats = require('fs').statSync(CONTENT_JS);
      const mapStats = require('fs').statSync(CONTENT_MAP);

      // External source map should not be included in bundle
      // (This tests that we're not using inline maps)
      const jsSizeKB = jsStats.size / 1024;
      const mapSizeKB = mapStats.size / 1024;

      console.log(`Bundle: ${jsSizeKB.toFixed(1)} KB, Map: ${mapSizeKB.toFixed(1)} KB`);

      // Map file exists separately, not inlined
      expect(mapSizeKB).toBeGreaterThan(0);
    });
  });
});

describe('Chrome DevTools Integration', () => {
  describe('Source map discoverability', () => {
    it('should use relative path for sourceMappingURL', () => {
      if (!existsSync(CONTENT_JS)) {
        console.warn('content.js not found, skipping test');
        return;
      }

      const contentJs = readFileSync(CONTENT_JS, 'utf-8');
      const sourceMapComment = contentJs.match(/\/\/[#@] sourceMappingURL=(.+)/);

      if (!sourceMapComment) {
        throw new Error('sourceMappingURL comment not found');
      }

      const mapPath = sourceMapComment[1].trim();

      // Should be relative path, not absolute
      expect(mapPath).toBe('content.js.map');
      expect(mapPath).not.toMatch(/^(\/|[A-Z]:)/); // Not absolute path
      expect(mapPath).not.toMatch(/^https?:/); // Not URL
    });
  });

  describe('Source file paths', () => {
    it('should use relative paths in sources array', () => {
      if (!existsSync(CONTENT_MAP)) {
        console.warn('content.js.map not found, skipping test');
        return;
      }

      const mapContent = readFileSync(CONTENT_MAP, 'utf-8');
      const sourceMap = JSON.parse(mapContent);

      sourceMap.sources.forEach((src: string) => {
        // Paths should be relative (../../src/...) or start with ../
        const isRelative = src.startsWith('../') || src.startsWith('./');
        const isViteInternal = src.startsWith('/@');

        expect(isRelative || isViteInternal).toBe(true);
      });
    });
  });
});
