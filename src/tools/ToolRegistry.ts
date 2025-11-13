/**
 * Tool Registry for Browser Tools
 *
 * Manages registration, discovery, and execution dispatch for browser tools.
 * Provides a centralized system for tool management with validation and metadata support.
 */

import type { Event } from '../protocol/types';
import { EventCollector } from '../tests/utils/test-helpers';
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

/**
 * Tool registry entry
 */
interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  registrationTime: number;
}

/**
 * Tool Registry Implementation
 *
 * Provides centralized tool management for the browser tools system.
 * Handles registration, discovery, validation, and execution dispatch.
 */
export class ToolRegistry {
  private tools: Map<string, ToolRegistryEntry> = new Map();
  private eventCollector?: EventCollector;

  constructor(eventCollector?: EventCollector) {
    this.eventCollector = eventCollector;
    // Note: TabManager (including tab grouping) is now initialized at service worker level
  }

  /**
   * Register a tool with the registry
   */
  async register(tool: ToolDefinition, handler: ToolHandler): Promise<void> {
    // Validate tool definition
    this.validateToolDefinition(tool);

    // Extract tool name based on definition type
    const toolName = this.getToolName(tool);

    // Check for duplicate registration
    if (this.tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is already registered`);
    }

    // Register the tool
    const entry: ToolRegistryEntry = {
      definition: tool,
      handler,
      registrationTime: Date.now(),
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

      // Emit execution start event
      this.emitEvent({
        id: `evt_exec_start_${request.toolName}`,
        msg: {
          type: 'ToolExecutionStart',
          data: {
            tool_name: request.toolName,
            session_id: request.sessionId,
            turn_id: request.turnId,
            start_time: startTime,
          },
        },
      });

      // Create execution context
      const context: ToolContext = {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolName: request.toolName,
        metadata: undefined, // ToolDefinition doesn't have metadata field
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

      // Emit success event
      this.emitEvent({
        id: `evt_exec_end_${request.toolName}`,
        msg: {
          type: 'ToolExecutionEnd',
          data: {
            tool_name: request.toolName,
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
        metadata: undefined, // ToolDefinition doesn't have metadata field
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
    let totalTools = 0;

    for (const entry of this.tools.values()) {
      totalTools++;
    }

    return {
      totalTools,
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
    if (this.tabGroupManager) {
      await this.tabGroupManager.cleanup();
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