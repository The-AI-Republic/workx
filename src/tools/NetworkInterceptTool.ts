/**
 * NetworkInterceptTool - Network request interception and modification
 *
 * Provides network monitoring, request/response modification, caching,
 * and API mocking capabilities using Chrome's declarativeNetRequest API.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from './BaseTool';

/**
 * Network pattern configuration
 */
export interface NetworkPattern {
  type: 'url' | 'method' | 'header' | 'mime-type';
  pattern: string | RegExp;
  include: boolean; // true = include, false = exclude
}

/**
 * Request modification configuration
 */
export interface RequestModification {
  type: 'header' | 'body' | 'url' | 'method';
  action: 'add' | 'modify' | 'remove' | 'block';
  key?: string;
  value?: any;
  condition?: (details: any) => boolean;
}

/**
 * Response modification configuration
 */
export interface ResponseModification {
  type: 'header' | 'body' | 'status';
  action: 'add' | 'modify' | 'remove';
  key?: string;
  value?: any;
}

/**
 * Monitoring configuration
 */
export interface MonitoringConfig {
  logRequests: boolean;
  logResponses: boolean;
  captureTimings: boolean;
  captureHeaders: boolean;
  captureBody: boolean;
  maxBodySize: number;
  saveToStorage: boolean;
}

/**
 * Caching configuration
 */
export interface CachingConfig {
  enabled: boolean;
  ttl: number; // Time to live in milliseconds
  maxSize: number; // Max cache size in bytes
  patterns: string[]; // URL patterns to cache
}

/**
 * Network intercept configuration
 */
export interface NetworkInterceptConfig extends BaseToolRequest {
  enabled: boolean;
  patterns: NetworkPattern[];
  requestModifications?: RequestModification[];
  responseModifications?: ResponseModification[];
  monitoring: MonitoringConfig;
  caching?: CachingConfig;
}

/**
 * Network request log entry
 */
export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timestamp: number;
  tabId?: number;
  frameId?: number;
  type: string;
  initiator?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  timings?: NetworkTimings;
  error?: string;
}

/**
 * Network timings
 */
export interface NetworkTimings {
  startTime: number;
  endTime?: number;
  duration?: number;
  dnsTime?: number;
  connectTime?: number;
  requestTime?: number;
  responseTime?: number;
}

/**
 * Network metrics
 */
export interface NetworkMetrics {
  totalRequests: number;
  blockedRequests: number;
  modifiedRequests: number;
  cachedRequests: number;
  failedRequests: number;
  totalBytes: number;
  averageResponseTime: number;
  requestsByType: Record<string, number>;
  requestsByStatus: Record<string, number>;
}

/**
 * NetworkInterceptTool implementation
 */
export class NetworkInterceptTool extends BaseTool {
  protected toolDefinition: ToolDefinition;
  private rules: chrome.declarativeNetRequest.Rule[] = [];
  private requestLog: Map<string, NetworkRequest> = new Map();
  private cache: Map<string, any> = new Map();
  private isIntercepting: boolean = false;
  private metrics: NetworkMetrics;
  private listeners: Map<string, any> = new Map();

  constructor() {
    super();

    this.toolDefinition = createToolDefinition(
      'network_intercept',
      'Intercept and modify network requests and responses',
      {
        enabled: {
          type: 'boolean',
          description: 'Enable/disable interception',
          default: true,
        },
        patterns: {
          type: 'array',
          description: 'Network patterns to match',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['url', 'method', 'header', 'mime-type'] },
              pattern: { type: 'string' },
              include: { type: 'boolean', default: true }
            }
          },
        },
        requestModifications: {
          type: 'array',
          description: 'Request modifications to apply',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['header', 'body', 'url', 'method'] },
              action: { type: 'string', enum: ['add', 'modify', 'remove', 'block'] },
              key: { type: 'string' },
              value: { type: 'string' }
            }
          }
        },
        monitoring: {
          type: 'object',
          description: 'Monitoring configuration',
          properties: {
            logRequests: { type: 'boolean', default: true },
            logResponses: { type: 'boolean', default: false },
            captureHeaders: { type: 'boolean', default: true },
            maxBodySize: { type: 'number', default: 1024 * 1024 } // 1MB
          }
        }
      },
      {
        required: ['patterns', 'monitoring'],
        category: 'browser',
        metadata: {
          permissions: ['declarativeNetRequest', 'webRequest', 'webNavigation'],
          platforms: ['extension'],
        },
      }
    );

    this.metrics = this.initializeMetrics();
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): NetworkMetrics {
    return {
      totalRequests: 0,
      blockedRequests: 0,
      modifiedRequests: 0,
      cachedRequests: 0,
      failedRequests: 0,
      totalBytes: 0,
      averageResponseTime: 0,
      requestsByType: {},
      requestsByStatus: {},
    };
  }

  /**
   * Execute network interception
   */
  protected async executeImpl(
    request: NetworkInterceptConfig,
    options?: BaseToolOptions
  ): Promise<any> {
    // Get tabId from metadata (passed internally, not from LLM)
    const tabId = options?.metadata?.tabId;

    if (request.enabled) {
      return await this.startInterception(request, tabId);
    } else {
      return await this.stopInterception();
    }
  }

  /**
   * Start network interception
   */
  async startInterception(config: NetworkInterceptConfig, tabId?: number): Promise<void> {
    if (this.isIntercepting) {
      await this.stopInterception();
    }

    try {
      // Create declarative net request rules
      this.rules = await this.createRules(config, tabId);

      // Add rules
      if (this.rules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: this.rules,
          removeRuleIds: this.rules.map(r => r.id),
        });
      }

      // Set up monitoring if enabled
      if (config.monitoring.logRequests) {
        this.setupMonitoring(config, tabId);
      }

      this.isIntercepting = true;

      this.log('info', 'Network interception started', {
        rules: this.rules.length,
        patterns: config.patterns.length,
      });

    } catch (error) {
      throw new Error(`Failed to start interception: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop network interception
   */
  async stopInterception(): Promise<void> {
    if (!this.isIntercepting) return;

    try {
      // Remove declarative rules
      if (this.rules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: this.rules.map(r => r.id),
        });
      }

      // Remove listeners
      this.removeMonitoringListeners();

      this.rules = [];
      this.isIntercepting = false;

      this.log('info', 'Network interception stopped');

    } catch (error) {
      throw new Error(`Failed to stop interception: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create declarative net request rules
   */
  private async createRules(config: NetworkInterceptConfig, tabId?: number): Promise<chrome.declarativeNetRequest.Rule[]> {
    const rules: chrome.declarativeNetRequest.Rule[] = [];
    let ruleId = 1;

    // Create rules for request modifications
    if (config.requestModifications) {
      for (const mod of config.requestModifications) {
        if (mod.action === 'block') {
          // Create blocking rule
          rules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.BLOCK,
            },
            condition: this.createRuleCondition(config.patterns, tabId),
          });
        } else if (mod.type === 'header' && mod.action === 'add') {
          // Add header rule
          rules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                {
                  header: mod.key!,
                  operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: mod.value,
                },
              ],
            },
            condition: this.createRuleCondition(config.patterns, tabId),
          });
        } else if (mod.type === 'header' && mod.action === 'remove') {
          // Remove header rule
          rules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                {
                  header: mod.key!,
                  operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
                },
              ],
            },
            condition: this.createRuleCondition(config.patterns, tabId),
          });
        } else if (mod.type === 'url' && mod.action === 'modify') {
          // URL redirect rule
          rules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
              redirect: {
                url: mod.value,
              },
            },
            condition: this.createRuleCondition(config.patterns, tabId),
          });
        }
      }
    }

    // Create rules for response modifications
    if (config.responseModifications) {
      for (const mod of config.responseModifications) {
        if (mod.type === 'header') {
          rules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              responseHeaders: [
                {
                  header: mod.key!,
                  operation: mod.action === 'remove'
                    ? chrome.declarativeNetRequest.HeaderOperation.REMOVE
                    : chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: mod.action !== 'remove' ? mod.value : undefined,
                },
              ],
            },
            condition: this.createRuleCondition(config.patterns, tabId),
          });
        }
      }
    }

    return rules;
  }

  /**
   * Create rule condition from patterns
   */
  private createRuleCondition(
    patterns: NetworkPattern[],
    tabId?: number
  ): chrome.declarativeNetRequest.RuleCondition {
    const urlFilters: string[] = [];
    const excludedUrlFilters: string[] = [];

    for (const pattern of patterns) {
      if (pattern.type === 'url') {
        const urlPattern = typeof pattern.pattern === 'string'
          ? pattern.pattern
          : pattern.pattern.source;

        if (pattern.include) {
          urlFilters.push(urlPattern);
        } else {
          excludedUrlFilters.push(urlPattern);
        }
      }
    }

    const condition: chrome.declarativeNetRequest.RuleCondition = {
      resourceTypes: [
        chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
        chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        chrome.declarativeNetRequest.ResourceType.SCRIPT,
        chrome.declarativeNetRequest.ResourceType.STYLESHEET,
        chrome.declarativeNetRequest.ResourceType.IMAGE,
      ],
    };

    // Add URL filters
    if (urlFilters.length > 0) {
      condition.urlFilter = urlFilters[0]; // DNR API only supports one filter per rule
    }

    // Add tab condition if specified
    if (tabId !== undefined) {
      condition.tabIds = [tabId];
    }

    return condition;
  }

  /**
   * Set up monitoring listeners
   */
  private setupMonitoring(config: NetworkInterceptConfig, tabId?: number): void {
    // Remove existing listeners
    this.removeMonitoringListeners();

    // Monitor requests
    if (chrome.webRequest) {
      const filter: chrome.webRequest.RequestFilter = {
        urls: ['<all_urls>'],
      };

      if (tabId !== undefined && tabId !== null && tabId !== -1) {
        filter.tabId = tabId;
      }

      // Before request
      const onBeforeRequest = (details: chrome.webRequest.OnBeforeRequestDetails): undefined => {
        this.logRequest(details, config);
        return undefined;
      };
      chrome.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        filter,
        ['requestBody']
      );
      this.listeners.set('onBeforeRequest', onBeforeRequest);

      // Headers received
      if (config.monitoring.logResponses) {
        const onHeadersReceived = (details: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
          this.logResponse(details, config);
          return undefined;
        };
        chrome.webRequest.onHeadersReceived.addListener(
          onHeadersReceived,
          filter,
          ['responseHeaders']
        );
        this.listeners.set('onHeadersReceived', onHeadersReceived);
      }

      // Request completed
      const onCompleted = (details: chrome.webRequest.OnCompletedDetails) => {
        this.updateMetrics(details);
      };
      chrome.webRequest.onCompleted.addListener(onCompleted, filter);
      this.listeners.set('onCompleted', onCompleted);

      // Request error
      const onErrorOccurred = (details: chrome.webRequest.OnErrorOccurredDetails) => {
        this.logError(details);
      };
      chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);
      this.listeners.set('onErrorOccurred', onErrorOccurred);
    }
  }

  /**
   * Remove monitoring listeners
   */
  private removeMonitoringListeners(): void {
    if (chrome.webRequest) {
      for (const [event, listener] of this.listeners) {
        switch (event) {
          case 'onBeforeRequest':
            chrome.webRequest.onBeforeRequest.removeListener(listener);
            break;
          case 'onHeadersReceived':
            chrome.webRequest.onHeadersReceived.removeListener(listener);
            break;
          case 'onCompleted':
            chrome.webRequest.onCompleted.removeListener(listener);
            break;
          case 'onErrorOccurred':
            chrome.webRequest.onErrorOccurred.removeListener(listener);
            break;
        }
      }
    }
    this.listeners.clear();
  }

  /**
   * Log request details
   */
  private logRequest(details: chrome.webRequest.OnBeforeRequestDetails, config: NetworkInterceptConfig): void {
    const request: NetworkRequest = {
      id: details.requestId,
      url: details.url,
      method: details.method,
      headers: {},
      timestamp: details.timeStamp,
      tabId: details.tabId,
      frameId: details.frameId,
      type: details.type,
      initiator: details.initiator,
    };

    // Capture body if enabled
    if (config.monitoring.captureBody && details.requestBody) {
      request.body = this.extractRequestBody(details.requestBody);
    }

    this.requestLog.set(details.requestId, request);
    this.metrics.totalRequests++;

    // Update metrics by type
    this.metrics.requestsByType[details.type] = (this.metrics.requestsByType[details.type] || 0) + 1;
  }

  /**
   * Log response details
   */
  private logResponse(details: chrome.webRequest.OnHeadersReceivedDetails, config: NetworkInterceptConfig): void {
    const request = this.requestLog.get(details.requestId);
    if (request) {
      request.status = details.statusCode;

      if (config.monitoring.captureHeaders && details.responseHeaders) {
        request.responseHeaders = this.headersArrayToObject(details.responseHeaders);
      }

      // Update metrics by status
      const statusGroup = Math.floor(details.statusCode / 100) * 100;
      this.metrics.requestsByStatus[`${statusGroup}`] =
        (this.metrics.requestsByStatus[`${statusGroup}`] || 0) + 1;
    }
  }

  /**
   * Update metrics on request completion
   */
  private updateMetrics(details: chrome.webRequest.OnCompletedDetails): void {
    const request = this.requestLog.get(details.requestId);
    if (request && request.timestamp) {
      const duration = details.timeStamp - request.timestamp;

      // Update average response time
      const totalRequests = this.metrics.totalRequests || 1;
      this.metrics.averageResponseTime =
        (this.metrics.averageResponseTime * (totalRequests - 1) + duration) / totalRequests;

      // Add timings
      if (request.timings) {
        request.timings.endTime = details.timeStamp;
        request.timings.duration = duration;
      } else {
        request.timings = {
          startTime: request.timestamp,
          endTime: details.timeStamp,
          duration: duration,
        };
      }
    }

    if (details.fromCache) {
      this.metrics.cachedRequests++;
    }
  }

  /**
   * Log request error
   */
  private logError(details: chrome.webRequest.OnErrorOccurredDetails): void {
    const request = this.requestLog.get(details.requestId);
    if (request) {
      request.error = details.error;
    }
    this.metrics.failedRequests++;
  }

  /**
   * Extract request body
   */
  private extractRequestBody(requestBody: any): string {
    if (requestBody.formData) {
      return JSON.stringify(requestBody.formData);
    }
    if (requestBody.raw && requestBody.raw.length > 0) {
      // Convert ArrayBuffer to string
      const decoder = new TextDecoder();
      return requestBody.raw.map((item: any) => {
        if (item.bytes) {
          return decoder.decode(new Uint8Array(item.bytes));
        }
        return '';
      }).join('');
    }
    return '';
  }

  /**
   * Convert headers array to object
   */
  private headersArrayToObject(headers: chrome.webRequest.HttpHeader[]): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach(header => {
      if (header.name && header.value) {
        result[header.name] = header.value;
      }
    });
    return result;
  }

  /**
   * Get logged requests
   */
  async getRequests(filter?: {
    url?: string;
    method?: string;
    status?: number;
    type?: string;
  }): Promise<NetworkRequest[]> {
    let requests = Array.from(this.requestLog.values());

    if (filter) {
      if (filter.url) {
        requests = requests.filter(r => r.url.includes(filter.url!));
      }
      if (filter.method) {
        requests = requests.filter(r => r.method === filter.method);
      }
      if (filter.status !== undefined) {
        requests = requests.filter(r => r.status === filter.status);
      }
      if (filter.type) {
        requests = requests.filter(r => r.type === filter.type);
      }
    }

    return requests;
  }

  /**
   * Get network metrics
   */
  async getMetrics(): Promise<NetworkMetrics> {
    return { ...this.metrics };
  }

  /**
   * Clear request log
   */
  clearLog(): void {
    this.requestLog.clear();
  }

  /**
   * Modify request
   */
  async modifyRequest(pattern: string, modification: RequestModification): Promise<void> {
    const rule: chrome.declarativeNetRequest.Rule = {
      id: Date.now(),
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          {
            header: modification.key!,
            operation: modification.action === 'remove'
              ? chrome.declarativeNetRequest.HeaderOperation.REMOVE
              : chrome.declarativeNetRequest.HeaderOperation.SET,
            value: modification.action !== 'remove' ? modification.value : undefined,
          },
        ],
      },
      condition: {
        urlFilter: pattern,
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
      },
    };

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [rule],
    });

    this.rules.push(rule);
  }

  /**
   * Cache response
   */
  async cacheResponse(pattern: string, ttl: number = 300000): Promise<void> {
    // Implementation would involve storing responses in chrome.storage
    // This is a simplified version
    this.cache.set(pattern, { ttl, timestamp: Date.now() });
  }

  /**
   * Clear cache
   */
  async clearCache(pattern?: string): Promise<void> {
    if (pattern) {
      this.cache.delete(pattern);
    } else {
      this.cache.clear();
    }
  }
}