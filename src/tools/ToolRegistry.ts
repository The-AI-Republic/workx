/**
 * Tool Registry for Browser Tools
 *
 * Manages registration, discovery, and execution dispatch for browser tools.
 * Provides a centralized system for tool management with validation and metadata support.
 */

import type { Event } from '../core/protocol/types';
import type {
  ToolDefinition,
  JsonSchema,
  ToolExecutionRequest,
  ToolExecutionResponse,
  ToolError,
  ToolDiscoveryQuery,
  ToolDiscoveryResult,
  ToolValidationResult,
  ValidationError,
  ToolContext,
  ToolHandler,
} from './BaseTool';
import type { ApprovalGate } from '../core/approval/ApprovalGate';
import type { IRiskAssessor } from '../core/approval/types';
import { parseNodeId } from './dom/utils';
import {
  DEFAULT_TOOL_CONCURRENCY_PROFILE,
  type ToolConcurrencyProfile,
  type ToolUIProfile,
  type ToolResultProfile,
  type ToolRuntimeMetadata,
  type ToolProgressCallback,
  type ToolProgressData,
} from './runtimeMetadata';

/**
 * Interface for event collection (used for testing)
 * The actual EventCollector class is in tests/utils/test-helpers.ts
 */
export interface IEventCollector {
  collect(event: Event): void;
}

/**
 * Tool registry entry — includes runtime metadata for concurrency, UI, and result management.
 */
interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  registrationTime: number;
  riskAssessor?: IRiskAssessor;
  runtime: ToolRuntimeMetadata;
}

/**
 * Structured registration options for tools with runtime metadata.
 */
export interface ToolRegistrationOptions {
  riskAssessor?: IRiskAssessor;
  runtime?: Partial<{
    concurrency: Partial<ToolConcurrencyProfile>;
    ui: ToolUIProfile;
    result: ToolResultProfile;
  }>;
}

/**
 * Tool Registry Implementation
 *
 * Provides centralized tool management for the browser tools system.
 * Handles registration, discovery, validation, and execution dispatch.
 */
export class ToolRegistry {
  private tools: Map<string, ToolRegistryEntry> = new Map();
  private eventCollector?: IEventCollector;
  private approvalGate?: ApprovalGate;
  private progressEventCounter = 0;

  constructor(eventCollector?: IEventCollector) {
    this.eventCollector = eventCollector;
    // Note: TabManager (including tab grouping) is now initialized at service worker level
  }

  /**
   * Set the approval gate for risk-based tool call interception
   */
  setApprovalGate(gate: ApprovalGate): void {
    this.approvalGate = gate;
  }

  /**
   * Get the approval gate (if configured)
   */
  getApprovalGate(): ApprovalGate | undefined {
    return this.approvalGate;
  }

  /**
   * Register a tool with the registry.
   *
   * Accepts either a bare IRiskAssessor (backward-compatible) or a structured
   * ToolRegistrationOptions object with runtime metadata.
   */
  async register(
    tool: ToolDefinition,
    handler: ToolHandler,
    optionsOrAssessor?: IRiskAssessor | ToolRegistrationOptions,
  ): Promise<void> {
    // Validate tool definition
    this.validateToolDefinition(tool);

    // Extract tool name based on definition type
    const toolName = this.getToolName(tool);

    // Check for duplicate registration
    if (this.tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is already registered`);
    }

    // Normalize the third argument: bare IRiskAssessor vs ToolRegistrationOptions
    const opts: ToolRegistrationOptions = optionsOrAssessor && 'assessRisk' in optionsOrAssessor
      ? { riskAssessor: optionsOrAssessor as IRiskAssessor }
      : (optionsOrAssessor as ToolRegistrationOptions ?? {});

    // Build runtime metadata with fail-closed defaults
    const runtime: ToolRuntimeMetadata = {
      concurrency: {
        ...DEFAULT_TOOL_CONCURRENCY_PROFILE,
        ...(opts.runtime?.concurrency ?? {}),
      },
      ui: opts.runtime?.ui,
      result: opts.runtime?.result,
    };

    // Register the tool
    const entry: ToolRegistryEntry = {
      definition: tool,
      handler,
      registrationTime: Date.now(),
      riskAssessor: opts.riskAssessor,
      runtime,
    };

    this.tools.set(toolName, entry);

    // Emit registration event
    this.emitEvent({
      id: `evt_register_${toolName}`,
      msg: {
        type: 'ToolRegistered',
        data: {
          tool_name: toolName,
          category: undefined, // ToolDefinition doesn't have category
          version: undefined, // ToolDefinition doesn't have version
          registration_time: entry.registrationTime,
        },
      },
    });
  }

  /**
   * Unregister a tool from the registry
   */
  async unregister(toolName: string): Promise<void> {
    if (!this.tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    this.tools.delete(toolName);

    // Emit unregistration event
    this.emitEvent({
      id: `evt_unregister_${toolName}`,
      msg: {
        type: 'ToolUnregistered',
        data: {
          tool_name: toolName,
          unregistration_time: Date.now(),
        },
      },
    });
  }

  /**
   * Discover tools based on query criteria
   */
  async discover(query?: ToolDiscoveryQuery): Promise<ToolDiscoveryResult> {
    let tools = Array.from(this.tools.values()).map(entry => entry.definition);

    // Note: ToolDefinition doesn't have category, version, or metadata fields
    // These filters won't work with the current ToolDefinition type

    if (query?.namePattern) {
      const regex = new RegExp(query.namePattern, 'i');
      tools = tools.filter(tool => regex.test(this.getToolName(tool)));
    }

    // category, capabilities, and version filters are not supported
    // with the current ToolDefinition structure

    return {
      tools,
      total: tools.length,
      categories: [], // No category support in ToolDefinition
    };
  }

  /**
   * Validate tool parameters against schema
   */
  validate(toolName: string, parameters: Record<string, any>): ToolValidationResult {
    const entry = this.tools.get(toolName);
    if (!entry) {
      return {
        valid: false,
        errors: [{
          parameter: '_tool',
          message: `Tool '${toolName}' not found`,
          code: 'NOT_FOUND',
        }],
      };
    }

    // Skip strict validation if tool has strict: false
    if (entry.definition.type === 'function' && entry.definition.function.strict === false) {
      return { valid: true, errors: [] };
    }

    const errors: ValidationError[] = [];
    const schema = this.getToolParameters(entry.definition);

    // Only validate if we have an object schema with properties
    if (schema.type !== 'object' || !schema.properties) {
      return { valid: true, errors: [] };
    }

    // Check required parameters
    if (schema.required) {
      for (const requiredParam of schema.required) {
        if (!(requiredParam in parameters) || parameters[requiredParam] == null) {
          errors.push({
            parameter: requiredParam,
            message: 'Required parameter missing',
            code: 'REQUIRED',
          });
        }
      }
    }

    // Validate parameter types and constraints
    for (const [paramName, paramValue] of Object.entries(parameters)) {
      const propSchema = schema.properties[paramName];
      if (!propSchema) {
        if (!schema.additionalProperties) {
          errors.push({
            parameter: paramName,
            message: `Unknown parameter '${paramName}'`,
            code: 'UNKNOWN_PARAMETER',
          });
        }
        continue;
      }

      // Type validation
      const typeError = this.validateParameterType(paramName, paramValue, propSchema);
      if (typeError) {
        errors.push(typeError);
      }

      // Note: JsonSchema doesn't support enum validation directly
      // Enum constraints should be handled at the tool level
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Execute a tool with the given request
   */
  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResponse> {
    const startTime = Date.now();

    try {
      const entry = this.tools.get(request.toolName);
      if (!entry) {
        return {
          success: false,
          error: {
            code: 'TOOL_NOT_FOUND',
            message: `Tool '${request.toolName}' not found`,
          },
          duration: Date.now() - startTime,
        };
      }

      // Validate parameters
      const validationResult = this.validate(request.toolName, request.parameters);
      if (!validationResult.valid) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Parameter validation failed',
            details: validationResult.errors,
          },
          duration: Date.now() - startTime,
        };
      }

      // Approval gate check (if configured)
      if (this.approvalGate) {
        const context = request.metadata ? {
          currentUrl: request.metadata.currentUrl as string | undefined,
          currentDomain: request.metadata.currentDomain as string | undefined,
          cwd: request.metadata.cwd as string | undefined,
          sessionId: request.sessionId,
          turnId: request.turnId,
        } : {
          sessionId: request.sessionId,
          turnId: request.turnId,
        };

        // Enrich browser_dom parameters with element metadata for risk assessment
        let approvalParameters = request.parameters;
        if (request.toolName === 'browser_dom' && request.parameters.node_id && request.tabId) {
          const action = request.parameters.action;
          if (action === 'click' || action === 'type' || action === 'keypress') {
            approvalParameters = await this.enrichDomParameters(request.parameters, request.tabId);
          }
        }

        const result = await this.approvalGate.check(
          request.toolName,
          approvalParameters,
          entry.riskAssessor,
          context
        );

        const decision = typeof result === 'string' ? result : result.decision;
        const reason = typeof result === 'object' && result !== null ? result.reason : undefined;

        if (decision === 'deny') {
          return {
            success: false,
            error: {
              code: 'APPROVAL_DENIED',
              message: `Tool '${request.toolName}' was denied by the approval system`,
              details: reason ? { reason } : undefined,
            },
            duration: Date.now() - startTime,
          };
        }
        // 'auto_approve' and 'ask_user' (resolved to approve) continue execution
      }

      // Emit execution start event (with call_id when available)
      this.emitEvent({
        id: `evt_exec_start_${request.toolName}_${request.callId ?? ''}`,
        msg: {
          type: 'ToolExecutionStart',
          data: {
            tool_name: request.toolName,
            call_id: request.callId,
            session_id: request.sessionId,
            turn_id: request.turnId,
            start_time: startTime,
          },
        },
      });

      // Wrap progress callback to also emit ToolExecutionProgress events
      const emitProgress: ToolProgressCallback | undefined = request.onProgress
        ? (progress) => {
            request.onProgress?.(progress);
            this.emitEvent({
              id: `evt_exec_progress_${request.toolName}_${++this.progressEventCounter}`,
              msg: {
                type: 'ToolExecutionProgress',
                data: {
                  tool_name: request.toolName,
                  call_id: request.callId,
                  session_id: request.sessionId,
                  turn_id: request.turnId,
                  progress_data: progress.data,
                  timestamp: Date.now(),
                },
              },
            });
          }
        : undefined;

      // Create execution context
      const context: ToolContext = {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolName: request.toolName,
        callId: request.callId,
        metadata: {
          tabId: request.tabId, // Pass tabId from request to tool via metadata
        },
        onProgress: emitProgress,
      };

      // Execute with timeout (default 120 seconds if not specified)
      const timeout = request.timeout || 120000;
      let result: any;

      try {
        result = await Promise.race([
          entry.handler(request.parameters, context),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Tool execution timeout')), timeout)
          ),
        ]);
      } catch (error: any) {
        const isTimeout = error.message.includes('timeout');

        // Emit error/timeout event
        this.emitEvent({
          id: `evt_exec_${isTimeout ? 'timeout' : 'error'}_${request.toolName}`,
          msg: {
            type: isTimeout ? 'ToolExecutionTimeout' : 'ToolExecutionError',
            data: {
              tool_name: request.toolName,
              session_id: request.sessionId,
              error: error.message,
              duration: Date.now() - startTime,
              ...(isTimeout && { timeout_ms: timeout }),
            },
          },
        });

        return {
          success: false,
          error: {
            code: isTimeout ? 'TIMEOUT' : 'EXECUTION_ERROR',
            message: error.message,
            details: error,
          },
          duration: Date.now() - startTime,
        };
      }

      // Result truncation: apply maxResultSizeChars if configured
      const maxChars = entry.runtime.result?.maxResultSizeChars;
      if (maxChars && typeof result === 'string' && result.length > maxChars) {
        const originalLength = result.length;
        result = result.slice(0, maxChars) +
          `\n\n[Result truncated from ${originalLength} to ${maxChars} chars]`;
      }

      // Emit success event
      this.emitEvent({
        id: `evt_exec_end_${request.toolName}_${request.callId ?? ''}`,
        msg: {
          type: 'ToolExecutionEnd',
          data: {
            tool_name: request.toolName,
            call_id: request.callId,
            session_id: request.sessionId,
            success: true,
            duration: Date.now() - startTime,
          },
        },
      });

      return {
        success: true,
        data: result,
        duration: Date.now() - startTime,
      };

    } catch (error: any) {
      // Emit execution error event
      this.emitEvent({
        id: `evt_exec_error_${request.toolName}`,
        msg: {
          type: 'ToolExecutionError',
          data: {
            tool_name: request.toolName,
            session_id: request.sessionId,
            error: error.message,
            duration: Date.now() - startTime,
          },
        },
      });

      return {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error.message,
          details: error,
        },
        duration: Date.now() - startTime,
      };
    }
  }

  // ===========================================================================
  // Runtime metadata query helpers (fail-closed, catch exceptions)
  // ===========================================================================

  /**
   * Check if a tool call is concurrency-safe given its input.
   * Returns false (fail-closed) if tool not found or check throws.
   */
  isConcurrencySafe(toolName: string, input: Record<string, unknown>): boolean {
    const entry = this.tools.get(toolName);
    if (!entry) return false;
    try {
      return entry.runtime.concurrency.isConcurrencySafe(input);
    } catch {
      return false;
    }
  }

  /**
   * Check if a tool call is read-only given its input.
   */
  isReadOnly(toolName: string, input: Record<string, unknown>): boolean {
    const entry = this.tools.get(toolName);
    if (!entry) return false;
    try {
      return entry.runtime.concurrency.isReadOnly(input);
    } catch {
      return false;
    }
  }

  /**
   * Check if a tool call is destructive given its input.
   */
  isDestructive(toolName: string, input: Record<string, unknown>): boolean {
    const entry = this.tools.get(toolName);
    if (!entry) return false;
    try {
      return entry.runtime.concurrency.isDestructive(input);
    } catch {
      return false;
    }
  }

  /**
   * Get human-readable activity description for a tool call.
   */
  getActivityDescription(toolName: string, input: Record<string, unknown>): string | null {
    const entry = this.tools.get(toolName);
    if (!entry?.runtime.ui?.getActivityDescription) return null;
    try {
      return entry.runtime.ui.getActivityDescription(input);
    } catch {
      return null;
    }
  }

  /**
   * Get result profile for a tool.
   */
  getResultProfile(toolName: string): ToolResultProfile | undefined {
    return this.tools.get(toolName)?.runtime.result;
  }

  /**
   * Get tool definition by name
   */
  getTool(name: string): ToolDefinition | null {
    const entry = this.tools.get(name);
    return entry ? entry.definition : null;
  }

  /**
   * List all registered tools
   */
  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(entry => entry.definition);
  }

  /**
   * Get registry statistics
   */
  getStats() {
    return {
      totalTools: this.tools.size,
      categories: [], // ToolDefinition doesn't have category field
      registeredTools: Array.from(this.tools.keys()),
    };
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Cleanup resources when shutting down
   */
  async cleanup(): Promise<void> {
    // No resources to clean up at the registry level
  }


  /**
   * Enrich browser_dom parameters with element metadata from DOM snapshot
   * for more accurate risk assessment. Read-only — does not modify execution params.
   */
  private async enrichDomParameters(
    parameters: Record<string, any>,
    tabId: number
  ): Promise<Record<string, any>> {
    try {
      // Dynamic import to avoid circular dependency at module load time
      const { DomService } = await import('./dom/DomService');
      const domService = await DomService.forTab(tabId);
      const snapshot = domService.getCurrentSnapshot();
      if (!snapshot) return parameters;

      const { frameId, backendNodeId } = parseNodeId(parameters.node_id);
      const node = snapshot.resolveNodeByBackendIdAndFrame(backendNodeId, frameId);
      if (!node) return parameters;

      const enriched: Record<string, any> = { ...parameters };

      if (node.accessibility?.name) {
        enriched.aria_label = node.accessibility.name;
      }
      if (node.accessibility?.role) {
        enriched.role = node.accessibility.role;
      }

      // Extract text from first text child
      if (node.children) {
        for (const child of node.children) {
          if (child.nodeType === 3 && child.nodeValue) {
            enriched.text = child.nodeValue.trim();
            break;
          }
        }
      }

      // Extract 'name' attribute from attributes array
      if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i += 2) {
          if (node.attributes[i] === 'name' && node.attributes[i + 1]) {
            enriched.name = node.attributes[i + 1];
            break;
          }
        }
      }

      return enriched;
    } catch {
      // Non-critical: return original parameters if enrichment fails
      return parameters;
    }
  }

  /**
   * Extract tool name from ToolDefinition based on type
   */
  private getToolName(tool: ToolDefinition): string {
    if (tool.type === 'function') {
      return tool.function.name;
    } else if (tool.type === 'custom') {
      return tool.custom.name;
    } else if (tool.type === 'local_shell') {
      return 'local_shell';
    } else if (tool.type === 'web_search') {
      return 'web_search';
    }
    throw new Error(`Unknown tool type: ${(tool as any).type}`);
  }

  /**
   * Extract tool description from ToolDefinition based on type
   */
  private getToolDescription(tool: ToolDefinition): string {
    if (tool.type === 'function') {
      return tool.function.description;
    } else if (tool.type === 'custom') {
      return tool.custom.description;
    } else if (tool.type === 'local_shell') {
      return 'Execute local shell commands';
    } else if (tool.type === 'web_search') {
      return 'Search the web';
    }
    throw new Error(`Unknown tool type: ${(tool as any).type}`);
  }

  /**
   * Extract tool parameters from ToolDefinition based on type
   */
  private getToolParameters(tool: ToolDefinition): any {
    if (tool.type === 'function') {
      return tool.function.parameters;
    }
    // Other types don't have parameters in the same way
    return {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    };
  }

  /**
   * Validate tool definition structure
   */
  private validateToolDefinition(tool: ToolDefinition): void {
    if (!tool || !tool.type) {
      throw new Error('Tool definition missing type field');
    }

    const name = this.getToolName(tool);
    const description = this.getToolDescription(tool);

    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new Error('Tool definition missing required field: name');
    }

    if (!description || typeof description !== 'string' || description.trim() === '') {
      throw new Error('Tool definition missing required field: description');
    }

    // Only validate parameters for function tools
    if (tool.type === 'function') {
      const parameters = tool.function.parameters;

      if (!parameters || typeof parameters !== 'object') {
        throw new Error('Tool definition missing required field: parameters');
      }

      if (parameters.type !== 'object') {
        throw new Error('Tool parameters must be of type "object"');
      }

      if (!parameters.properties || typeof parameters.properties !== 'object') {
        throw new Error('Tool parameters must define properties');
      }
    }
  }

  /**
   * Validate individual parameter type using JsonSchema
   */
  private validateParameterType(
    paramName: string,
    value: any,
    schema: JsonSchema
  ): ValidationError | null {
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    // Handle null/undefined values
    if (value == null) {
      return {
        parameter: paramName,
        message: 'Parameter value is null or undefined',
        code: 'NULL_VALUE',
      };
    }

    // Type checking
    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') {
          return {
            parameter: paramName,
            message: 'Expected string type',
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'number':
      case 'integer':
        if (typeof value !== 'number' || isNaN(value)) {
          return {
            parameter: paramName,
            message: `Expected ${schema.type} type`,
            code: 'TYPE_MISMATCH',
          };
        }
        if (schema.type === 'integer' && !Number.isInteger(value)) {
          return {
            parameter: paramName,
            message: 'Expected integer value',
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return {
            parameter: paramName,
            message: 'Expected boolean type',
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          return {
            parameter: paramName,
            message: 'Expected array type',
            code: 'TYPE_MISMATCH',
          };
        }
        // Validate array items if schema is provided
        if ('items' in schema && schema.items) {
          for (let i = 0; i < value.length; i++) {
            const itemError = this.validateParameterType(`${paramName}[${i}]`, value[i], schema.items);
            if (itemError) {
              return itemError;
            }
          }
        }
        break;

      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return {
            parameter: paramName,
            message: 'Expected object type',
            code: 'TYPE_MISMATCH',
          };
        }
        // Validate nested properties if schema defines them
        if ('properties' in schema && schema.properties) {
          for (const [propKey, propSchema] of Object.entries(schema.properties)) {
            if (propKey in value) {
              const propError = this.validateParameterType(`${paramName}.${propKey}`, value[propKey], propSchema);
              if (propError) {
                return propError;
              }
            }
          }
        }
        break;

      default:
        return {
          parameter: paramName,
          message: `Unknown type: ${(schema as any).type}`,
          code: 'UNKNOWN_TYPE',
        };
    }

    return null;
  }

  /**
   * Emit event through event collector
   */
  private emitEvent(event: Event): void {
    if (this.eventCollector) {
      this.eventCollector.collect(event);
    }
  }
}

/**
 * Singleton registry instance
 */
export const toolRegistry = new ToolRegistry();
