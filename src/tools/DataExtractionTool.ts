import { BaseTool, type ToolDefinition } from './BaseTool';

/** Extraction mode */
export type ExportFormat = 'json' | 'csv' | 'xml' | 'markdown';

/** Data pattern definition */
export interface DataPattern {
  name: string;
  regex: RegExp;
  type: string;
  description: string;
}

/** Structured data result */
export interface StructuredData {
  fields?: Record<string, any>;
  arrays?: Record<string, any[]>;
  nested?: Record<string, any>;
  tables?: any;
  [key: string]: any;
}

/** Extracted data */
export interface ExtractedData {
  raw: any;
  structured: StructuredData;
  metadata: Record<string, any>;
}

/** Data extraction parameters */
export interface DataExtractionParams {
  mode: 'semantic' | 'structured' | 'pattern' | 'table' | 'auto';
  patterns?: string[];
  selectors?: Record<string, string>;
  schema?: any;
  format?: ExportFormat;
  tableSelector?: string;
  context?: string;
}

/** Data extraction result */
export interface DataExtractionResult {
  success: boolean;
  data?: ExtractedData;
  dataId?: string;
  exported?: string;
  formatted?: string;
  statistics?: Record<string, number>;
  warnings?: string[];
  error?: string;
}

export class DataExtractionTool extends BaseTool {
  protected toolDefinition: ToolDefinition;
  private patterns: Map<string, DataPattern>;
  private extractedData: Map<string, ExtractedData>;

  constructor() {
    super();
    this.patterns = new Map();
    this.extractedData = new Map();
    this.initializePatterns();

    // Initialize tool definition
    this.toolDefinition = {
      type: 'function' as const,
      function: {
        name: 'data_extraction',
        description: 'Extract structured data from web pages using patterns and semantic analysis',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              description: 'Extraction mode: semantic, structured, pattern, table, or auto',
              enum: ['semantic', 'structured', 'pattern', 'table', 'auto']
            },
            patterns: {
              type: 'array',
              description: 'Patterns to match for extraction',
              items: {
                type: 'string'
              }
            },
            selectors: {
              type: 'object',
              description: 'CSS selectors or XPath for targeted extraction'
            },
            schema: {
              type: 'object',
              description: 'Expected data schema. Must be a valid JSON schema object defining the structure of the data to extract.'
            },
            format: {
              type: 'string',
              description: 'Export format: json, csv, xml, or markdown',
              enum: ['json', 'csv', 'xml', 'markdown']
            },
            tableSelector: {
              type: 'string',
              description: 'CSS selector for table extraction'
            },
            context: {
              type: 'string',
              description: 'Additional context for extraction'
            }
          },
          required: [],
          additionalProperties: false
        }
      },
      metadata: {
        capabilities: ['data_extraction', 'pattern_matching', 'semantic_analysis', 'table_extraction'],
        permissions: ['activeTab', 'scripting'],
        platforms: ['extension'] as const,
      },
      category: 'data',
      version: '1.0.0',
    };
  }

  private initializePatterns(): void {
    // Common data patterns
    this.patterns.set('email', {
      name: 'email',
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      type: 'string',
      description: 'Email addresses'
    });

    this.patterns.set('phone', {
      name: 'phone',
      regex: /[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,9}/g,
      type: 'string',
      description: 'Phone numbers'
    });

    this.patterns.set('url', {
      name: 'url',
      regex: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g,
      type: 'string',
      description: 'URLs'
    });

    this.patterns.set('price', {
      name: 'price',
      regex: /[$£€¥]\s*\d+(?:\.\d{2})?|\d+(?:\.\d{2})?\s*(?:USD|EUR|GBP|JPY)/g,
      type: 'number',
      description: 'Prices and monetary values'
    });

    this.patterns.set('date', {
      name: 'date',
      regex: /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{2,4}/gi,
      type: 'string',
      description: 'Dates in various formats'
    });

    this.patterns.set('address', {
      name: 'address',
      regex: /\d{1,5}\s\w+(?:\s\w+)*,\s*\w+(?:\s\w+)*,?\s*(?:[A-Z]{2}\s*)?\d{5}(?:-\d{4})?/g,
      type: 'string',
      description: 'Street addresses'
    });
  }

  async executeImpl(params: DataExtractionParams): Promise<DataExtractionResult> {
    try {
      const { mode, patterns, selectors, format, schema } = params;
      let extractedData: ExtractedData;

      switch (mode) {
        case 'pattern':
          extractedData = await this.extractByPatterns(patterns || []);
          break;
        case 'structured':
          extractedData = await this.extractStructured(selectors || {}, schema);
          break;
        case 'semantic':
          extractedData = await this.extractSemantic(params.context);
          break;
        case 'table':
          extractedData = await this.extractTables(params.tableSelector);
          break;
        default:
          extractedData = await this.extractAuto();
      }

      // Store extracted data
      const dataId = this.generateDataId();
      this.extractedData.set(dataId, extractedData);

      // Export to requested format
      const exported = format ? await this.exportData(extractedData, format) : undefined;

      return {
        success: true,
        data: extractedData,
        dataId,
        exported,
        statistics: this.calculateStatistics(extractedData),
        warnings: this.validateData(extractedData)
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Data extraction failed'
      };
    }
  }

  private async extractByPatterns(patternNames: string[]): Promise<ExtractedData> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error('No active tab');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (patterns: Array<{ name: string; regex: string }>) => {
        const text = document.body.innerText;
        const extracted: Record<string, any[]> = {};

        patterns.forEach(pattern => {
          const regex = new RegExp(pattern.regex, 'gi');
          const matches = text.match(regex) || [];
          extracted[pattern.name] = [...new Set(matches)]; // Remove duplicates
        });

        return extracted;
      },
      args: [patternNames.map(name => {
        const pattern = this.patterns.get(name);
        return pattern ? { name: pattern.name, regex: pattern.regex.source } : null;
      }).filter((p): p is { name: string; regex: string } => p !== null)]
    });

    return {
      raw: results[0]?.result || {},
      structured: this.structureData(results[0]?.result || {}),
      metadata: {
        source: tab.url || '',
        timestamp: new Date().toISOString(),
        patterns: patternNames
      }
    };
  }

  private async extractStructured(selectors: Record<string, string>, schema?: any): Promise<ExtractedData> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error('No active tab');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selectors: Record<string, string>) => {
        const data: Record<string, any> = {};

        Object.entries(selectors).forEach(([key, selector]) => {
          const elements = document.querySelectorAll(selector);
          if (elements.length === 1) {
            data[key] = elements[0].textContent?.trim();
          } else if (elements.length > 1) {
            data[key] = Array.from(elements).map(el => el.textContent?.trim());
          }
        });

        return data;
      },
      args: [selectors]
    });

    const structured: StructuredData = schema ? this.applySchema(results[0]?.result, schema) : (results[0]?.result || {});

    return {
      raw: results[0]?.result || {},
      structured,
      metadata: {
        source: tab.url || '',
        timestamp: new Date().toISOString(),
        selectors: Object.keys(selectors)
      }
    };
  }

  private async extractSemantic(context?: string): Promise<ExtractedData> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error('No active tab');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Extract semantic data based on HTML5 semantic elements and microdata
        const data: Record<string, any> = {};

        // Extract from semantic HTML elements
        const article = document.querySelector('article');
        if (article) {
          data.mainContent = article.innerText;
          data.title = article.querySelector('h1')?.textContent ||
            document.querySelector('h1')?.textContent;
        }

        // Extract microdata (Schema.org)
        const microdata = document.querySelectorAll('[itemscope]');
        if (microdata.length > 0) {
          data.microdata = Array.from(microdata).map(item => {
            const type = item.getAttribute('itemtype');
            const props: Record<string, any> = {};
            item.querySelectorAll('[itemprop]').forEach(prop => {
              const name = prop.getAttribute('itemprop');
              if (name) {
                props[name] = prop.textContent?.trim() || prop.getAttribute('content');
              }
            });
            return { type, properties: props };
          });
        }

        // Extract JSON-LD structured data
        const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
        if (jsonLd.length > 0) {
          data.jsonLd = Array.from(jsonLd).map(script => {
            try {
              return JSON.parse(script.textContent || '{}');
            } catch {
              return null;
            }
          }).filter(Boolean);
        }

        // Extract Open Graph metadata
        const ogTags = document.querySelectorAll('meta[property^="og:"]');
        if (ogTags.length > 0) {
          data.openGraph = {};
          ogTags.forEach(tag => {
            const property = tag.getAttribute('property')?.replace('og:', '');
            const content = tag.getAttribute('content');
            if (property && content) {
              data.openGraph[property] = content;
            }
          });
        }

        return data;
      }
    });

    return {
      raw: results[0]?.result || {},
      structured: this.processSemanticData(results[0]?.result, context),
      metadata: {
        source: tab.url || '',
        timestamp: new Date().toISOString(),
        type: 'semantic'
      }
    };
  }

  private async extractTables(selector?: string): Promise<ExtractedData> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error('No active tab');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (tableSelector?: string) => {
        const tables = document.querySelectorAll(tableSelector || 'table');
        const data: any[] = [];

        tables.forEach((table, index) => {
          const headers: string[] = [];
          const rows: any[] = [];

          // Extract headers
          table.querySelectorAll('thead th, thead td').forEach(cell => {
            headers.push(cell.textContent?.trim() || '');
          });

          // If no thead, try first row
          if (headers.length === 0) {
            table.querySelectorAll('tr:first-child th, tr:first-child td').forEach(cell => {
              headers.push(cell.textContent?.trim() || '');
            });
          }

          // Extract rows
          const rowElements = table.querySelectorAll('tbody tr, tr');
          rowElements.forEach((row, rowIndex) => {
            // Skip header row if detected
            if (rowIndex === 0 && headers.length > 0 && !table.querySelector('thead')) {
              return;
            }

            const rowData: Record<string, any> = {};
            row.querySelectorAll('td, th').forEach((cell, cellIndex) => {
              const key = headers[cellIndex] || `col_${cellIndex}`;
              rowData[key] = cell.textContent?.trim() || '';
            });

            if (Object.keys(rowData).length > 0) {
              rows.push(rowData);
            }
          });

          if (rows.length > 0) {
            data.push({
              index,
              headers,
              rows,
              rowCount: rows.length,
              columnCount: headers.length
            });
          }
        });

        return data;
      },
      args: [selector]
    });

    return {
      raw: results[0]?.result || [],
      structured: this.structureTables(results[0]?.result || []),
      metadata: {
        source: tab.url || '',
        timestamp: new Date().toISOString(),
        tableCount: results[0]?.result?.length || 0
      }
    };
  }

  private async extractAuto(): Promise<ExtractedData> {
    // Automatic extraction combining multiple methods
    const patterns = await this.extractByPatterns(['email', 'phone', 'url', 'date']);
    const semantic = await this.extractSemantic();
    const tables = await this.extractTables();

    return {
      raw: {
        patterns: patterns.raw,
        semantic: semantic.raw,
        tables: tables.raw
      },
      structured: {
        ...patterns.structured,
        ...semantic.structured,
        tables: tables.structured
      },
      metadata: {
        source: patterns.metadata.source,
        timestamp: new Date().toISOString(),
        methods: ['pattern', 'semantic', 'table']
      }
    };
  }

  private structureData(raw: any): StructuredData {
    const structured: StructuredData = {
      fields: {},
      arrays: {},
      nested: {}
    };

    Object.entries(raw).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 1) {
          structured.fields![key] = value[0];
        } else {
          structured.arrays![key] = value;
        }
      } else if (typeof value === 'object' && value !== null) {
        structured.nested![key] = value;
      } else {
        structured.fields![key] = value;
      }
    });

    return structured;
  }

  private structureTables(tables: any[]): StructuredData {
    return {
      fields: {
        tableCount: tables.length,
        totalRows: tables.reduce((sum, t) => sum + t.rowCount, 0)
      },
      arrays: {
        tables: tables.map(t => ({
          headers: t.headers,
          rowCount: t.rowCount,
          sample: t.rows.slice(0, 3) // Sample first 3 rows
        }))
      },
      nested: {
        fullData: tables
      }
    };
  }

  private processSemanticData(raw: any, context?: string): StructuredData {
    const structured: StructuredData = {
      fields: {},
      arrays: {},
      nested: {}
    };

    // Process microdata
    if (raw.microdata) {
      structured.arrays!.microdata = raw.microdata;
    }

    // Process JSON-LD
    if (raw.jsonLd) {
      structured.nested!.jsonLd = raw.jsonLd;
    }

    // Process Open Graph
    if (raw.openGraph) {
      structured.fields = { ...structured.fields, ...raw.openGraph };
    }

    // Apply context filtering if provided
    if (context) {
      // Filter based on context keywords
      const contextKeywords = context.toLowerCase().split(' ');
      Object.entries(structured.fields || {}).forEach(([key, value]) => {
        const valueStr = String(value).toLowerCase();
        if (!contextKeywords.some((keyword: string) => valueStr.includes(keyword))) {
          delete structured.fields![key];
        }
      });
    }

    return structured;
  }

  private applySchema(data: any, schema: any): StructuredData {
    // Apply a JSON schema or transformation rules
    const structured: StructuredData = {
      fields: {},
      arrays: {},
      nested: {}
    };

    // Simple schema application (can be extended)
    if (schema.fields) {
      Object.entries(schema.fields).forEach(([key, config]: [string, any]) => {
        if (data[key] !== undefined) {
          structured.fields![key] = this.transformValue(data[key], config.type);
        }
      });
    }

    return structured;
  }

  private transformValue(value: any, type: string): any {
    switch (type) {
      case 'number':
        return parseFloat(value) || 0;
      case 'boolean':
        return Boolean(value);
      case 'date':
        return new Date(value).toISOString();
      default:
        return String(value);
    }
  }

  private async exportData(data: ExtractedData, format: ExportFormat): Promise<string> {
    switch (format) {
      case 'json':
        return JSON.stringify(data.structured || data.raw, null, 2);

      case 'csv':
        return this.exportToCSV(data);

      case 'xml':
        return this.exportToXML(data);

      case 'markdown':
        return this.exportToMarkdown(data);

      default:
        return JSON.stringify(data.raw);
    }
  }

  private exportToCSV(data: ExtractedData): string {
    const structured = data.structured as StructuredData;
    const rows: string[] = [];

    // Export fields as key-value pairs
    if (structured.fields) {
      rows.push('Field,Value');
      Object.entries(structured.fields).forEach(([key, value]) => {
        rows.push(`"${key}","${value}"`);
      });
    }

    // Export arrays
    if (structured.arrays) {
      Object.entries(structured.arrays).forEach(([key, array]) => {
        if (array.length > 0 && typeof array[0] === 'object') {
          // Export as table
          const headers = Object.keys(array[0]);
          rows.push('');
          rows.push(headers.join(','));
          array.forEach((item: any) => {
            rows.push(headers.map(h => `"${item[h] || ''}"`).join(','));
          });
        }
      });
    }

    return rows.join('\n');
  }

  private exportToXML(data: ExtractedData): string {
    const structured = data.structured as StructuredData;
    const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<data>'];

    const escapeXML = (str: string): string => {
      return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };

    // Export fields
    if (structured.fields) {
      lines.push('  <fields>');
      Object.entries(structured.fields).forEach(([key, value]) => {
        lines.push(`    <${key}>${escapeXML(String(value))}</${key}>`);
      });
      lines.push('  </fields>');
    }

    // Export arrays
    if (structured.arrays) {
      lines.push('  <arrays>');
      Object.entries(structured.arrays).forEach(([key, array]) => {
        lines.push(`    <${key}>`);
        array.forEach((item: any) => {
          if (typeof item === 'object') {
            lines.push('      <item>');
            Object.entries(item).forEach(([k, v]) => {
              lines.push(`        <${k}>${escapeXML(String(v))}</${k}>`);
            });
            lines.push('      </item>');
          } else {
            lines.push(`      <item>${escapeXML(String(item))}</item>`);
          }
        });
        lines.push(`    </${key}>`);
      });
      lines.push('  </arrays>');
    }

    lines.push('</data>');
    return lines.join('\n');
  }

  private exportToMarkdown(data: ExtractedData): string {
    const structured = data.structured as StructuredData;
    const lines: string[] = ['# Extracted Data', ''];

    // Export metadata
    if (data.metadata) {
      lines.push('## Metadata');
      lines.push(`- **Source**: ${data.metadata.source}`);
      lines.push(`- **Timestamp**: ${data.metadata.timestamp}`);
      lines.push('');
    }

    // Export fields
    if (structured.fields && Object.keys(structured.fields).length > 0) {
      lines.push('## Fields');
      Object.entries(structured.fields).forEach(([key, value]) => {
        lines.push(`- **${key}**: ${value}`);
      });
      lines.push('');
    }

    // Export arrays
    if (structured.arrays) {
      Object.entries(structured.arrays).forEach(([key, array]) => {
        lines.push(`## ${key}`);
        if (array.length > 0 && typeof array[0] === 'object') {
          // Create table
          const headers = Object.keys(array[0]);
          lines.push('| ' + headers.join(' | ') + ' |');
          lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
          array.forEach((item: any) => {
            lines.push('| ' + headers.map(h => item[h] || '').join(' | ') + ' |');
          });
        } else {
          // Simple list
          array.forEach((item: any) => {
            lines.push(`- ${item}`);
          });
        }
        lines.push('');
      });
    }

    return lines.join('\n');
  }

  private calculateStatistics(data: ExtractedData): Record<string, number> {
    const stats: Record<string, number> = {};
    const structured = data.structured as StructuredData;

    if (structured.fields) {
      stats.fieldCount = Object.keys(structured.fields).length;
    }

    if (structured.arrays) {
      stats.arrayCount = Object.keys(structured.arrays).length;
      stats.totalItems = Object.values(structured.arrays).reduce(
        (sum, arr) => sum + arr.length, 0
      );
    }

    return stats;
  }

  private validateData(data: ExtractedData): string[] {
    const warnings: string[] = [];
    const structured = data.structured as StructuredData;

    // Check for empty extractions
    if (!structured.fields && !structured.arrays && !structured.nested) {
      warnings.push('No data extracted');
    }

    // Check for potential duplicates in arrays
    if (structured.arrays) {
      Object.entries(structured.arrays).forEach(([key, array]) => {
        const uniqueCount = new Set(array.map(item => JSON.stringify(item))).size;
        if (uniqueCount < array.length) {
          warnings.push(`Potential duplicates in ${key} array`);
        }
      });
    }

    return warnings;
  }

  private generateDataId(): string {
    return `data_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async cleanup(): Promise<void> {
    this.patterns.clear();
    this.extractedData.clear();
  }
}