/**
 * FieldNormalizer (P3.3): Normalize field names to snake_case with short aliases
 *
 * Reduces token count by:
 * - Converting camelCase to snake_case
 * - Using short aliases for common fields
 * - Standardizing field naming convention
 *
 * Field mappings:
 * - aria-label → aria_label (or al for ultra-compact)
 * - children → kids
 * - placeholder → hint
 * - inputType → input_type
 * - boundingBox → bbox
 *
 * Note: This optimization is applied during serialization to SerializedDom,
 * not to the VirtualNode tree itself. This class provides field name mapping.
 *
 * Stage 3 Payload Optimization
 */

export class FieldNormalizer {
  private fieldMappings: Map<string, string>;
  private useShortAliases: boolean;

  constructor(useShortAliases: boolean = false) {
    this.useShortAliases = useShortAliases;

    // Field name mappings (long → short)
    this.fieldMappings = new Map([
      ['aria-label', useShortAliases ? 'al' : 'aria_label'],
      ['children', useShortAliases ? 'k' : 'kids'],
      ['placeholder', useShortAliases ? 'h' : 'hint'],
      ['inputType', useShortAliases ? 'it' : 'input_type'],
      ['boundingBox', useShortAliases ? 'bb' : 'bbox'],
      ['node_id', useShortAliases ? 'id' : 'node_id'],
      ['tag', useShortAliases ? 't' : 'tag'],
      ['role', useShortAliases ? 'r' : 'role'],
      ['text', useShortAliases ? 'tx' : 'text'],
      ['value', useShortAliases ? 'v' : 'value'],
      ['href', useShortAliases ? 'hr' : 'href'],
      ['states', useShortAliases ? 's' : 'states']
    ]);
  }

  /**
   * Normalize field name
   * @param fieldName - Original field name
   * @returns Normalized field name
   */
  normalizeField(fieldName: string): string {
    // Check for exact mapping
    if (this.fieldMappings.has(fieldName)) {
      return this.fieldMappings.get(fieldName)!;
    }

    // Convert camelCase to snake_case
    return this.camelToSnake(fieldName);
  }

  /**
   * Convert camelCase to snake_case
   */
  private camelToSnake(str: string): string {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase();
  }

  /**
   * Normalize object keys recursively
   * @param obj - Object to normalize
   * @returns Object with normalized keys
   */
  normalizeObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.normalizeObject(item));
    }

    if (obj !== null && typeof obj === 'object') {
      const normalized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        const normalizedKey = this.normalizeField(key);
        normalized[normalizedKey] = this.normalizeObject(value);
      }
      return normalized;
    }

    return obj;
  }
}
