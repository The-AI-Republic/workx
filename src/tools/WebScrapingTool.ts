/**
 * WebScrapingTool - Advanced web scraping with pattern-based extraction
 *
 * Provides structured data extraction from web pages using CSS/XPath selectors,
 * handles pagination, table extraction, and pattern-based scraping.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from './BaseTool';

/**
 * Scraping pattern configuration
 */
export interface ScrapingPattern {
  name: string;
  description?: string;
  selector: string;
  type: 'css' | 'xpath' | 'text' | 'regex';
  multiple: boolean;
  required: boolean;
  extraction: ExtractionRule[];
  fallback?: string;
  transform?: (data: any) => any;
}

/**
 * Extraction rule for pattern-based scraping
 */
export interface ExtractionRule {
  field: string;
  source: 'text' | 'attribute' | 'html' | 'computed';
  attribute?: string;
  format?: 'string' | 'number' | 'date' | 'json';
  default?: any;
  transform?: (value: any) => any;
}

/**
 * Pagination configuration
 */
export interface PaginationConfig {
  type: 'click' | 'scroll' | 'load-more' | 'url-pattern';
  nextSelector?: string;
  urlPattern?: string;
  maxPages: number;
  delay: number;
  waitFor?: string;
}

/**
 * Scraping configuration
 */
export interface ScrapingConfig extends BaseToolRequest {
  url?: string;
  patterns: ScrapingPattern[];
  waitFor?: WaitCondition;
  timeout?: number;
  screenshot?: boolean;
  pagination?: PaginationConfig;
}

/**
 * Wait condition for page readiness
 */
export interface WaitCondition {
  type: 'selector' | 'xpath' | 'function' | 'time';
  value: string | number;
  timeout?: number;
}

/**
 * Scraping result
 */
export interface ScrapingResult {
  data: Record<string, any>;
  metadata: {
    url: string;
    timestamp: number;
    duration: number;
    errors: string[];
    pagesScraped?: number;
  };
  screenshot?: string;
}

/**
 * Table data structure
 */
export interface TableData {
  headers: string[];
  rows: string[][];
  metadata: {
    rowCount: number;
    columnCount: number;
    hasHeaders: boolean;
  };
}

/**
 * Pattern library with common extraction patterns
 */
export class PatternLibrary {
  static readonly PATTERNS = {
    ARTICLE: {
      name: 'article',
      selector: 'article, main, [role="main"], .content',
      type: 'css' as const,
      multiple: false,
      required: false,
      extraction: [
        { field: 'title', source: 'text' as const, selector: 'h1, h2, .title' },
        { field: 'content', source: 'text' as const, selector: 'p' },
        { field: 'author', source: 'text' as const, selector: '[rel="author"], .author' },
        { field: 'date', source: 'attribute' as const, selector: 'time', attribute: 'datetime' }
      ]
    },
    PRODUCT: {
      name: 'product',
      selector: '[itemtype*="Product"], .product, .item',
      type: 'css' as const,
      multiple: true,
      required: false,
      extraction: [
        { field: 'name', source: 'text' as const, selector: '[itemprop="name"], .product-name' },
        { field: 'price', source: 'text' as const, selector: '[itemprop="price"], .price' },
        { field: 'description', source: 'text' as const, selector: '[itemprop="description"], .description' },
        { field: 'image', source: 'attribute' as const, selector: 'img', attribute: 'src' },
        { field: 'rating', source: 'text' as const, selector: '[itemprop="rating"], .rating' }
      ]
    },
    LINKS: {
      name: 'links',
      selector: 'a[href]',
      type: 'css' as const,
      multiple: true,
      required: false,
      extraction: [
        { field: 'text', source: 'text' as const },
        { field: 'href', source: 'attribute' as const, attribute: 'href' },
        { field: 'title', source: 'attribute' as const, attribute: 'title' }
      ]
    },
    IMAGES: {
      name: 'images',
      selector: 'img[src]',
      type: 'css' as const,
      multiple: true,
      required: false,
      extraction: [
        { field: 'src', source: 'attribute' as const, attribute: 'src' },
        { field: 'alt', source: 'attribute' as const, attribute: 'alt' },
        { field: 'title', source: 'attribute' as const, attribute: 'title' }
      ]
    }
  };
}

/**
 * WebScrapingTool implementation
 */
export class WebScrapingTool extends BaseTool {
  protected toolDefinition: ToolDefinition;
  private patternLibrary: Map<string, ScrapingPattern> = new Map();

  constructor() {
    super();

    this.toolDefinition = createToolDefinition(
      'web_scraping',
      'Extract structured data from web pages using patterns',
      {
        url: {
          type: 'string',
          description: 'URL to scrape (optional if tab is already bound to session)',
        },
        patterns: {
          type: 'array',
          description: 'Scraping patterns to apply',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              selector: { type: 'string' },
              type: { type: 'string', enum: ['css', 'xpath', 'text', 'regex'] },
              multiple: { type: 'boolean' },
              extraction: { type: 'array' }
            }
          },
        },
        waitFor: {
          type: 'object',
          description: 'Wait condition before scraping',
          properties: {
            type: { type: 'string', enum: ['selector', 'xpath', 'time'] },
            value: { type: 'string' },
            timeout: { type: 'number', default: 5000 }
          }
        },
        timeout: {
          type: 'number',
          description: 'Overall timeout in milliseconds',
          default: 30000,
        },
        screenshot: {
          type: 'boolean',
          description: 'Capture screenshot after scraping',
          default: false,
        },
        pagination: {
          type: 'object',
          description: 'Pagination configuration',
          properties: {
            type: { type: 'string', enum: ['click', 'scroll', 'url-pattern'] },
            nextSelector: { type: 'string' },
            maxPages: { type: 'number', default: 10 },
            delay: { type: 'number', default: 1000 }
          }
        }
      },
      {
        required: ['patterns'],
        category: 'browser',
        metadata: {
          permissions: ['tabs', 'scripting', 'activeTab'],
          platforms: ['extension'],
        },
      }
    );

    // Initialize pattern library
    this.loadPatternLibrary();
  }

  /**
   * Load common patterns into the library
   */
  private loadPatternLibrary(): void {
    Object.entries(PatternLibrary.PATTERNS).forEach(([key, pattern]) => {
      this.patternLibrary.set(key.toLowerCase(), pattern as ScrapingPattern);
    });
  }

  /**
   * Execute web scraping
   */
  protected async executeImpl(
    request: ScrapingConfig,
    options?: BaseToolOptions
  ): Promise<ScrapingResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    try {
      // Get tabId from metadata (passed internally, not from LLM)
      const tabId = options?.metadata?.tabId;

      // Get the target tab
      const tab = await this.getTab(tabId, request.url);

      // Wait for readiness if specified
      if (request.waitFor) {
        await this.waitForCondition(tab.id!, request.waitFor);
      }

      // Handle pagination if configured
      if (request.pagination) {
        return await this.scrapePaginated(tab.id!, request);
      }

      // Execute single page scraping
      const data = await this.executeScraping(tab.id!, request.patterns);

      // Capture screenshot if requested
      let screenshot: string | undefined;
      if (request.screenshot) {
        screenshot = await this.captureScreenshot(tab.id!);
      }

      return {
        data,
        metadata: {
          url: tab.url || '',
          timestamp: Date.now(),
          duration: Date.now() - startTime,
          errors,
        },
        screenshot,
      };

    } catch (error) {
      throw new Error(`Scraping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get or navigate to tab
   */
  private async getTab(tabId?: number, url?: string): Promise<chrome.tabs.Tab> {
    if (tabId !== undefined && tabId !== null && tabId !== -1) {
      return await this.validateTabId(tabId);
    }

    if (url) {
      // Create new tab with URL
      const tab = await chrome.tabs.create({ url, active: false });

      // Note: Tab will be added to group automatically when bound to session via TabManager

      return tab;
    }

    throw new Error('Target tab ID not provided in execution context and no URL specified');
  }

  /**
   * Wait for a condition to be met
   */
  private async waitForCondition(tabId: number, condition: WaitCondition): Promise<void> {
    const timeout = condition.timeout || 5000;

    switch (condition.type) {
      case 'selector':
        await this.waitForSelector(tabId, condition.value as string, timeout);
        break;
      case 'xpath':
        await this.waitForXPath(tabId, condition.value as string, timeout);
        break;
      case 'time':
        await new Promise(resolve => setTimeout(resolve, condition.value as number));
        break;
      default:
        throw new Error(`Unknown wait condition type: ${condition.type}`);
    }
  }

  /**
   * Wait for CSS selector
   */
  private async waitForSelector(tabId: number, selector: string, timeout: number): Promise<void> {
    const endTime = Date.now() + timeout;

    while (Date.now() < endTime) {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => !!document.querySelector(sel),
        args: [selector],
      });

      if (result[0]?.result) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  /**
   * Wait for XPath
   */
  private async waitForXPath(tabId: number, xpath: string, timeout: number): Promise<void> {
    const endTime = Date.now() + timeout;

    while (Date.now() < endTime) {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (xp) => {
          const result = document.evaluate(xp, document, null, XPathResult.ANY_TYPE, null);
          return !!result.iterateNext();
        },
        args: [xpath],
      });

      if (result[0]?.result) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for XPath: ${xpath}`);
  }

  /**
   * Execute scraping with patterns
   */
  private async executeScraping(tabId: number, patterns: ScrapingPattern[]): Promise<Record<string, any>> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: this.extractWithPatterns,
      args: [patterns],
    });

    return result[0]?.result || {};
  }

  /**
   * Function executed in page context to extract data
   */
  private extractWithPatterns(patterns: ScrapingPattern[]): Record<string, any> {
    const results: Record<string, any> = {};

    for (const pattern of patterns) {
      try {
        const elements = pattern.type === 'css'
          ? document.querySelectorAll(pattern.selector)
          : pattern.type === 'xpath'
          ? getElementsFromXPath(pattern.selector)
          : [];

        if (elements.length === 0 && pattern.required) {
          throw new Error(`Required pattern "${pattern.name}" matched no elements`);
        }

        const extracted = Array.from(elements).map(element => {
          return extractFromElement(element, pattern.extraction);
        });

        results[pattern.name] = pattern.multiple ? extracted : extracted[0];

        // Apply transform if provided
        if (pattern.transform && typeof pattern.transform === 'function') {
          results[pattern.name] = pattern.transform(results[pattern.name]);
        }

      } catch (error) {
        if (pattern.required) {
          throw error;
        }
        results[pattern.name] = pattern.fallback || null;
      }
    }

    return results;

    // Helper functions
    function getElementsFromXPath(xpath: string): Element[] {
      const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
      const elements: Element[] = [];
      let node;
      while ((node = result.iterateNext())) {
        if (node instanceof Element) {
          elements.push(node);
        }
      }
      return elements;
    }

    function extractFromElement(element: Element, rules: ExtractionRule[]): Record<string, any> {
      const data: Record<string, any> = {};

      for (const rule of rules) {
        let value: any;

        switch (rule.source) {
          case 'text':
            value = element.textContent?.trim();
            break;
          case 'html':
            value = element.innerHTML;
            break;
          case 'attribute':
            value = rule.attribute ? element.getAttribute(rule.attribute) : null;
            break;
          case 'computed':
            const computed = window.getComputedStyle(element);
            value = rule.attribute ? computed.getPropertyValue(rule.attribute) : null;
            break;
        }

        // Format conversion
        if (value && rule.format) {
          switch (rule.format) {
            case 'number':
              value = parseFloat(value) || 0;
              break;
            case 'date':
              value = new Date(value).toISOString();
              break;
            case 'json':
              try {
                value = JSON.parse(value);
              } catch {
                value = rule.default;
              }
              break;
          }
        }

        data[rule.field] = value || rule.default;
      }

      return data;
    }
  }

  /**
   * Scrape with pagination
   */
  private async scrapePaginated(
    tabId: number,
    config: ScrapingConfig
  ): Promise<ScrapingResult> {
    const allData: any[] = [];
    const errors: string[] = [];
    let pagesScraped = 0;
    const maxPages = config.pagination?.maxPages || 10;
    const delay = config.pagination?.delay || 1000;

    try {
      while (pagesScraped < maxPages) {
        // Scrape current page
        const pageData = await this.executeScraping(tabId, config.patterns);
        allData.push(pageData);
        pagesScraped++;

        // Check for next page
        if (config.pagination?.type === 'click' && config.pagination.nextSelector) {
          const hasNext = await this.clickNextPage(tabId, config.pagination.nextSelector);
          if (!hasNext) break;
        } else if (config.pagination?.type === 'scroll') {
          const hasMore = await this.scrollToLoadMore(tabId);
          if (!hasMore) break;
        }

        // Delay before next page
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      return {
        data: { pages: allData, totalPages: pagesScraped },
        metadata: {
          url: '',
          timestamp: Date.now(),
          duration: 0,
          errors,
          pagesScraped,
        },
      };

    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return {
        data: { pages: allData, totalPages: pagesScraped },
        metadata: {
          url: '',
          timestamp: Date.now(),
          duration: 0,
          errors,
          pagesScraped,
        },
      };
    }
  }

  /**
   * Click next page button
   */
  private async clickNextPage(tabId: number, selector: string): Promise<boolean> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const button = document.querySelector(sel) as HTMLElement;
        if (button && !button.hasAttribute('disabled')) {
          button.click();
          return true;
        }
        return false;
      },
      args: [selector],
    });

    return result[0]?.result || false;
  }

  /**
   * Scroll to load more content
   */
  private async scrollToLoadMore(tabId: number): Promise<boolean> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const beforeHeight = document.body.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        return new Promise<boolean>(resolve => {
          setTimeout(() => {
            resolve(document.body.scrollHeight > beforeHeight);
          }, 1000);
        });
      },
    });

    return result[0]?.result || false;
  }

  /**
   * Capture screenshot of the page
   */
  private async captureScreenshot(tabId: number): Promise<string> {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab();
      return dataUrl;
    } catch (error) {
      this.log('warn', 'Failed to capture screenshot', error);
      return '';
    }
  }

  /**
   * Scrape table data
   */
  async scrapeTable(selector: string, tabId?: number): Promise<TableData> {
    const tab = await this.getTab(tabId);

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: (sel) => {
        const table = document.querySelector(sel) as HTMLTableElement;
        if (!table) {
          throw new Error(`Table not found: ${sel}`);
        }

        const headers: string[] = [];
        const rows: string[][] = [];

        // Extract headers
        const headerCells = table.querySelectorAll('thead th, thead td');
        headerCells.forEach(cell => {
          headers.push(cell.textContent?.trim() || '');
        });

        // If no thead, try first row
        if (headers.length === 0) {
          const firstRow = table.querySelector('tr');
          if (firstRow) {
            firstRow.querySelectorAll('th, td').forEach(cell => {
              headers.push(cell.textContent?.trim() || '');
            });
          }
        }

        // Extract rows
        const bodyRows = table.querySelectorAll('tbody tr, tr');
        bodyRows.forEach((row, index) => {
          // Skip header row if detected
          if (index === 0 && headers.length > 0 && !table.querySelector('thead')) {
            return;
          }

          const rowData: string[] = [];
          row.querySelectorAll('td, th').forEach(cell => {
            rowData.push(cell.textContent?.trim() || '');
          });

          if (rowData.length > 0) {
            rows.push(rowData);
          }
        });

        return {
          headers,
          rows,
          metadata: {
            rowCount: rows.length,
            columnCount: headers.length || (rows[0]?.length || 0),
            hasHeaders: headers.length > 0,
          },
        };
      },
      args: [selector],
    });

    return result[0]?.result || { headers: [], rows: [], metadata: { rowCount: 0, columnCount: 0, hasHeaders: false } };
  }

  /**
   * Add custom pattern to library
   */
  addPattern(pattern: ScrapingPattern): void {
    this.patternLibrary.set(pattern.name, pattern);
  }

  /**
   * Get pattern from library
   */
  getPattern(name: string): ScrapingPattern | undefined {
    return this.patternLibrary.get(name.toLowerCase());
  }

  /**
   * List available patterns
   */
  listPatterns(): string[] {
    return Array.from(this.patternLibrary.keys());
  }
}