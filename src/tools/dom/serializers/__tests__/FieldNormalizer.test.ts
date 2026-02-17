import { describe, it, expect } from 'vitest';
import { FieldNormalizer } from '../optimizers/FieldNormalizer';

describe('FieldNormalizer', () => {
  // ─── Constructor & initialization ─────────────────────────────

  describe('constructor', () => {
    it('should default useShortAliases to false', () => {
      const normalizer = new FieldNormalizer();
      // Without short aliases, 'children' maps to 'kids'
      expect(normalizer.normalizeField('children')).toBe('kids');
    });

    it('should accept useShortAliases = true', () => {
      const normalizer = new FieldNormalizer(true);
      expect(normalizer.normalizeField('children')).toBe('k');
    });

    it('should accept useShortAliases = false explicitly', () => {
      const normalizer = new FieldNormalizer(false);
      expect(normalizer.normalizeField('children')).toBe('kids');
    });
  });

  // ─── normalizeField with standard aliases ─────────────────────

  describe('normalizeField (standard aliases)', () => {
    let normalizer: FieldNormalizer;

    beforeEach(() => {
      normalizer = new FieldNormalizer(false);
    });

    it('should map aria-label to aria_label', () => {
      expect(normalizer.normalizeField('aria-label')).toBe('aria_label');
    });

    it('should map children to kids', () => {
      expect(normalizer.normalizeField('children')).toBe('kids');
    });

    it('should map placeholder to hint', () => {
      expect(normalizer.normalizeField('placeholder')).toBe('hint');
    });

    it('should map inputType to input_type', () => {
      expect(normalizer.normalizeField('inputType')).toBe('input_type');
    });

    it('should map boundingBox to bbox', () => {
      expect(normalizer.normalizeField('boundingBox')).toBe('bbox');
    });

    it('should map node_id to node_id (unchanged)', () => {
      expect(normalizer.normalizeField('node_id')).toBe('node_id');
    });

    it('should map tag to tag (unchanged)', () => {
      expect(normalizer.normalizeField('tag')).toBe('tag');
    });

    it('should map role to role (unchanged)', () => {
      expect(normalizer.normalizeField('role')).toBe('role');
    });

    it('should map text to text (unchanged)', () => {
      expect(normalizer.normalizeField('text')).toBe('text');
    });

    it('should map value to value (unchanged)', () => {
      expect(normalizer.normalizeField('value')).toBe('value');
    });

    it('should map href to href (unchanged)', () => {
      expect(normalizer.normalizeField('href')).toBe('href');
    });

    it('should map states to states (unchanged)', () => {
      expect(normalizer.normalizeField('states')).toBe('states');
    });
  });

  // ─── normalizeField with short aliases ────────────────────────

  describe('normalizeField (short aliases)', () => {
    let normalizer: FieldNormalizer;

    beforeEach(() => {
      normalizer = new FieldNormalizer(true);
    });

    it('should map aria-label to al', () => {
      expect(normalizer.normalizeField('aria-label')).toBe('al');
    });

    it('should map children to k', () => {
      expect(normalizer.normalizeField('children')).toBe('k');
    });

    it('should map placeholder to h', () => {
      expect(normalizer.normalizeField('placeholder')).toBe('h');
    });

    it('should map inputType to it', () => {
      expect(normalizer.normalizeField('inputType')).toBe('it');
    });

    it('should map boundingBox to bb', () => {
      expect(normalizer.normalizeField('boundingBox')).toBe('bb');
    });

    it('should map node_id to id', () => {
      expect(normalizer.normalizeField('node_id')).toBe('id');
    });

    it('should map tag to t', () => {
      expect(normalizer.normalizeField('tag')).toBe('t');
    });

    it('should map role to r', () => {
      expect(normalizer.normalizeField('role')).toBe('r');
    });

    it('should map text to tx', () => {
      expect(normalizer.normalizeField('text')).toBe('tx');
    });

    it('should map value to v', () => {
      expect(normalizer.normalizeField('value')).toBe('v');
    });

    it('should map href to hr', () => {
      expect(normalizer.normalizeField('href')).toBe('hr');
    });

    it('should map states to s', () => {
      expect(normalizer.normalizeField('states')).toBe('s');
    });
  });

  // ─── camelToSnake fallback ────────────────────────────────────

  describe('camelToSnake fallback (unmapped fields)', () => {
    let normalizer: FieldNormalizer;

    beforeEach(() => {
      normalizer = new FieldNormalizer(false);
    });

    it('should convert simple camelCase to snake_case', () => {
      expect(normalizer.normalizeField('backgroundColor')).toBe('background_color');
    });

    it('should convert multi-hump camelCase', () => {
      expect(normalizer.normalizeField('myLongFieldName')).toBe('my_long_field_name');
    });

    it('should return already-lowercase as-is', () => {
      expect(normalizer.normalizeField('name')).toBe('name');
    });

    it('should handle single uppercase letter', () => {
      expect(normalizer.normalizeField('X')).toBe('_x');
    });

    it('should handle leading uppercase', () => {
      expect(normalizer.normalizeField('NodeId')).toBe('_node_id');
    });

    it('should handle consecutive uppercase letters', () => {
      expect(normalizer.normalizeField('XMLParser')).toBe('_x_m_l_parser');
    });

    it('should handle empty string', () => {
      expect(normalizer.normalizeField('')).toBe('');
    });

    it('should handle all-lowercase string', () => {
      expect(normalizer.normalizeField('width')).toBe('width');
    });
  });

  // ─── normalizeObject ──────────────────────────────────────────

  describe('normalizeObject', () => {
    let normalizer: FieldNormalizer;

    beforeEach(() => {
      normalizer = new FieldNormalizer(false);
    });

    it('should normalize keys in a flat object', () => {
      const result = normalizer.normalizeObject({
        children: [1, 2, 3],
        boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      });

      expect(result).toHaveProperty('kids');
      expect(result).toHaveProperty('bbox');
      expect(result).not.toHaveProperty('children');
      expect(result).not.toHaveProperty('boundingBox');
    });

    it('should normalize nested objects recursively', () => {
      const result = normalizer.normalizeObject({
        children: [
          { inputType: 'text', placeholder: 'Enter name' },
        ],
      });

      expect(result).toHaveProperty('kids');
      expect(result.kids[0]).toHaveProperty('input_type');
      expect(result.kids[0]).toHaveProperty('hint');
    });

    it('should handle arrays by normalizing each element', () => {
      const result = normalizer.normalizeObject([
        { boundingBox: { x: 0, y: 0 } },
        { inputType: 'text' },
      ]);

      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('bbox');
      expect(result[1]).toHaveProperty('input_type');
    });

    it('should return primitives unchanged', () => {
      expect(normalizer.normalizeObject('hello')).toBe('hello');
      expect(normalizer.normalizeObject(42)).toBe(42);
      expect(normalizer.normalizeObject(true)).toBe(true);
      expect(normalizer.normalizeObject(null)).toBeNull();
    });

    it('should handle undefined', () => {
      expect(normalizer.normalizeObject(undefined)).toBeUndefined();
    });

    it('should handle empty object', () => {
      const result = normalizer.normalizeObject({});
      expect(result).toEqual({});
    });

    it('should handle empty array', () => {
      const result = normalizer.normalizeObject([]);
      expect(result).toEqual([]);
    });

    it('should apply camelToSnake for unknown nested keys', () => {
      const result = normalizer.normalizeObject({
        scrollPosition: { scrollTop: 100, scrollLeft: 50 },
      });

      expect(result).toHaveProperty('scroll_position');
      expect(result.scroll_position).toHaveProperty('scroll_top');
      expect(result.scroll_position).toHaveProperty('scroll_left');
    });

    it('should normalize object with short aliases', () => {
      const normalizer2 = new FieldNormalizer(true);
      const result = normalizer2.normalizeObject({
        children: [{ tag: 'div', role: 'button' }],
        text: 'hello',
      });

      expect(result).toHaveProperty('k');
      expect(result.k[0]).toHaveProperty('t');
      expect(result.k[0]).toHaveProperty('r');
      expect(result).toHaveProperty('tx');
    });

    it('should handle deeply nested structures', () => {
      const result = normalizer.normalizeObject({
        children: [
          {
            children: [
              {
                children: [
                  { inputType: 'password' },
                ],
              },
            ],
          },
        ],
      });

      expect(result.kids[0].kids[0].kids[0]).toHaveProperty('input_type');
      expect(result.kids[0].kids[0].kids[0].input_type).toBe('password');
    });
  });
});
