/**
 * Base Tool Class
 *
 * Abstract base class for all browser tools. Provides common functionality
 * including parameter validation, error handling, and execution context.
 */

/**
 * JSON Schema definition for tool parameters
 */
export type JsonSchema =
  | { type: 'boolean'; description?: string }
  | { type: 'string'; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'array'; items: JsonSchema; description?: string }
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean };

/**
 * Response API tool definition
 */
export interface ResponsesApiTool {
  name: string;
  description: string;
  strict: boolean;
  parameters: JsonSchema;
}

/**
 * Freeform tool format
 */
export interface FreeformToolFormat {
  type: string;
  syntax: string;
  definition: string;
}

/**
 * Freeform tool definition
 */
export interface FreeformTool {
  name: string;
  description: string;
  format: FreeformToolFormat;
}

/**
 * Tool definition - union type
 *
 * When serialized as JSON, this produces a valid "Tool" in the OpenAI Responses API.
 */
export type ToolDefinition =
  | { type: 'function'; function: ResponsesApiTool }
  | { type: 'local_shell' }
  | { type: 'web_search' }
  | { type: 'custom'; custom: FreeformTool };

/**
 * Simplified parameter property definition for tool creation
 * This is a convenience type that gets converted to JsonSchema internally
 */
export interface ParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: ParameterProperty;
  properties?: Record<string, ParameterProperty>;
  default?: any;
}

/**
 * Tool execution request
 */
export interface ToolExecutionRequest {
  toolName: string;
  parameters: Record<string, any>;
  sessionId: string;
  turnId: string;
  tabId?: number; // Current session's bound tab ID
  timeout?: number;
}

/**
 * Tool execution response
 */
export interface ToolExecutionResponse {
  success: boolean;
  data?: any;
  error?: ToolError;
  duration: number;
  metadata?: Record<string, any>;
}

/**
 * Tool error details
 */
export interface ToolError {
  code: string;
  message: string;
  details?: any;
}

/**
 * Tool discovery query
 */
export interface ToolDiscoveryQuery {
  category?: string;
  namePattern?: string;
  capabilities?: string[];
  version?: string;
}

/**
 * Tool discovery result
 */
export interface ToolDiscoveryResult {
  tools: ToolDefinition[];
  total: number;
  categories: string[];
}

/**
 * Parameter validation result
 */
export interface ToolValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validation error details
 */
export interface ValidationError {
  parameter: string;
  message: string;
  code: string;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  sessionId: string;
  turnId: string;
  toolName: string;
  metadata?: Record<string, any>;
}

/**
 * Tool handler function signature
 */
export interface ToolHandler {
  (parameters: Record<string, any>, context: ToolContext): Promise<any>;
}

/**
 * Base execution request interface that all tools should extend
 */
export interface BaseToolRequest {
  [key: string]: any;
}

/**
 * Base execution options
 */
export interface BaseToolOptions {
  timeout?: number;
  retries?: number;
  metadata?: Record<string, any>;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Abstract base class for all browser tools
 */
export abstract class BaseTool {
  protected abstract toolDefinition: ToolDefinition;

  /**
   * Get the tool definition
   */
  getDefinition(): ToolDefinition {
    return this.toolDefinition;
  }

  /**
   * Execute the tool with the given request
   */
  async execute(request: BaseToolRequest, options?: BaseToolOptions): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      // Validate parameters
      const validationResult = this.validateParameters(request);
      if (!validationResult.valid) {
        return {
          success: false,
          error: `Parameter validation failed: ${validationResult.errors.map(e => e.message).join(', ')}`,
          metadata: {
            validationErrors: validationResult.errors,
            duration: Date.now() - startTime,
          },
        };
      }

      // Apply defaults
      const processedRequest = this.applyDefaults(request);

      // Execute the tool-specific logic
      const result = await this.executeImpl(processedRequest, options);

      const toolName = this.toolDefinition.type === 'function'
        ? this.toolDefinition.function.name
        : this.toolDefinition.type;

      return {
        success: true,
        data: result,
        metadata: {
          duration: Date.now() - startTime,
          toolName,
          ...options?.metadata,
        },
      };

    } catch (error: any) {
      const toolName = this.toolDefinition.type === 'function'
        ? this.toolDefinition.function.name
        : this.toolDefinition.type;

      return {
        success: false,
        error: this.formatError(error),
        metadata: {
          duration: Date.now() - startTime,
          toolName,
          errorType: error.constructor.name,
          ...options?.metadata,
        },
      };
    }
  }

  /**
   * Tool-specific implementation - must be implemented by subclasses
   */
  protected abstract executeImpl(
    request: BaseToolRequest,
    options?: BaseToolOptions
  ): Promise<any>;

  /**
   * Validate parameters against the tool's schema
   */
  protected validateParameters(parameters: Record<string, any>): { valid: boolean; errors: ValidationError[] } {
    const errors: ValidationError[] = [];

    // Get the parameters schema from the tool definition
    if (this.toolDefinition.type !== 'function') {
      // Non-function tools don't have parameters to validate
      return { valid: true, errors: [] };
    }

    const schema = this.toolDefinition.function.parameters;
    if (schema.type !== 'object') {
      // Only object schemas have properties to validate
      return { valid: true, errors: [] };
    }

    // Check required parameters
    if (schema.required) {
      for (const requiredParam of schema.required) {
        if (!(requiredParam in parameters) || parameters[requiredParam] == null) {
          errors.push({
            parameter: requiredParam,
            message: `Required parameter '${requiredParam}' is missing`,
            code: 'REQUIRED',
          });
        }
      }
    }

    // Validate each parameter
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

      const paramErrors = this.validateJsonSchemaValue(paramName, paramValue, propSchema);
      errors.push(...paramErrors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate a single value against JsonSchema
   */
  protected validateJsonSchemaValue(
    paramName: string,
    value: any,
    schema: JsonSchema
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    // Handle null/undefined values
    if (value == null) {
      errors.push({
        parameter: paramName,
        message: `Parameter '${paramName}' cannot be null or undefined`,
        code: 'NULL_VALUE',
      });
      return errors;
    }

    // Type validation
    const typeError = this.validateJsonSchemaType(paramName, value, schema.type);
    if (typeError) {
      errors.push(typeError);
      return errors; // Don't continue if type is wrong
    }

    // Array item validation
    if (schema.type === 'array' && 'items' in schema && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = this.validateJsonSchemaValue(`${paramName}[${i}]`, value[i], schema.items);
        errors.push(...itemErrors);
      }
    }

    // Object property validation
    if (schema.type === 'object' && 'properties' in schema && typeof value === 'object' && !Array.isArray(value)) {
      for (const [propName, propValue] of Object.entries(value)) {
        const propSchema = schema.properties[propName];
        if (propSchema) {
          const propErrors = this.validateJsonSchemaValue(`${paramName}.${propName}`, propValue, propSchema);
          errors.push(...propErrors);
        }
      }
    }

    return errors;
  }

  /**
   * Validate value type against JsonSchema type
   */
  protected validateJsonSchemaType(paramName: string, value: any, expectedType: string): ValidationError | null {
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    switch (expectedType) {
      case 'string':
        if (typeof value !== 'string') {
          return {
            parameter: paramName,
            message: `Parameter '${paramName}' must be a string, got ${actualType}`,
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'number':
      case 'integer':
        if (typeof value !== 'number' || isNaN(value)) {
          return {
            parameter: paramName,
            message: `Parameter '${paramName}' must be a valid ${expectedType}, got ${actualType}`,
            code: 'TYPE_MISMATCH',
          };
        }
        if (expectedType === 'integer' && !Number.isInteger(value)) {
          return {
            parameter: paramName,
            message: `Parameter '${paramName}' must be an integer, got ${value}`,
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return {
            parameter: paramName,
            message: `Parameter '${paramName}' must be a boolean, got ${actualType}`,
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          return {
            parameter: paramName,
            message: `Parameter '${paramName}' must be an array, got ${actualType}`,
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return {
            parameter: paramName,
            message: `Parameter '${paramName}' must be an object, got ${actualType}`,
            code: 'TYPE_MISMATCH',
          };
        }
        break;

      default:
        return {
          parameter: paramName,
          message: `Unknown parameter type: ${expectedType}`,
          code: 'UNKNOWN_TYPE',
        };
    }

    return null;
  }

  /**
   * Apply default values to parameters
   * Note: JsonSchema doesn't include defaults, so this is a no-op for now
   */
  protected applyDefaults(parameters: Record<string, any>): Record<string, any> {
    // JsonSchema doesn't have a default field like ParameterProperty did
    // Return parameters as-is
    return { ...parameters };
  }

  /**
   * Format error message
   */
  protected formatError(error: Error | string): string {
    if (typeof error === 'string') {
      return error;
    }

    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    return 'Unknown error occurred';
  }

  /**
   * Create a tool error with consistent structure
   */
  protected createError(code: string, message: string, details?: any): ToolError {
    return {
      code,
      message,
      details,
    };
  }

  /**
   * Validate Chrome extension context
   */
  protected validateChromeContext(): void {
    if (typeof chrome === 'undefined') {
      throw new Error('Chrome extension APIs not available');
    }
  }

  /**
   * Validate that a tab ID is valid
   */
  protected async validateTabId(tabId: number): Promise<chrome.tabs.Tab> {
    this.validateChromeContext();

    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        throw new Error(`Tab with ID ${tabId} not found`);
      }
      return tab;
    } catch (error) {
      throw new Error(`Invalid tab ID ${tabId}: ${error}`);
    }
  }

  /**
   * Validate session's bound tab before browser operations
   * Throw TabInvalidError when validation fails
   *
   * @param sessionId - Session ID to validate tab for
   * @returns The valid tab
   * @throws TabInvalidError if tab is invalid
   */
  protected async validateSessionTab(sessionId: string): Promise<chrome.tabs.Tab> {
    // Import TabManager and TabInvalidError dynamically to avoid circular dependencies
    const { TabManager } = await import('../core/TabManager');
    const { TabInvalidError } = await import('../types/errors');

    const bindingManager = TabManager.getInstance();

    // Get the tab bound to this session
    const tabId = bindingManager.getTabForSession(sessionId);

    // Check if session has a tab attached
    if (tabId === -1) {
      throw new Error(`Session ${sessionId} has no tab attached (tabId = -1)`);
    }

    // Validate the tab exists
    const validation = await bindingManager.validateTab(tabId);

    if (validation.status === 'invalid') {
      // Throw TabInvalidError when validation fails
      throw new TabInvalidError(tabId, validation.reason, sessionId);
    }

    if (validation.status !== 'valid') {
      throw new Error(`Tab ${tabId} validation returned unexpected status: ${validation.status}`);
    }

    return validation.tab;
  }

  /**
   * Get active tab
   */
  protected async getActiveTab(): Promise<chrome.tabs.Tab> {
    this.validateChromeContext();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
      throw new Error('No active tab found');
    }

    return tabs[0];
  }

  /**
   * Execute with retry logic
   */
  protected async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === maxRetries) {
          break;
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }

    throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Execute with timeout
   */
  protected async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number = 30000
  ): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Log debug information (can be overridden by subclasses)
   */
  protected log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
    const toolName = this.toolDefinition.type === 'function'
      ? this.toolDefinition.function.name
      : this.toolDefinition.type;

    // Don't log data to avoid circular reference issues with DOM nodes
    if (data) {
      console[level](`[${toolName}] ${message} [data omitted to prevent circular references]`);
    } else {
      console[level](`[${toolName}] ${message}`);
    }
  }

  /**
   * Create execution context for the tool
   */
  protected createContext(sessionId: string, turnId: string): ToolContext {
    const toolName = this.toolDefinition.type === 'function'
      ? this.toolDefinition.function.name
      : this.toolDefinition.type;
    return {
      sessionId,
      turnId,
      toolName,
      metadata: undefined,
    };
  }

  /**
   * Validate required Chrome permissions
   */
  protected async validatePermissions(permissions: string[]): Promise<void> {
    this.validateChromeContext();

    if (chrome.permissions) {
      const hasPermissions = await chrome.permissions.contains({
        permissions,
      });

      if (!hasPermissions) {
        throw new Error(`Missing required permissions: ${permissions.join(', ')}`);
      }
    }
  }

  /**
   * Safe JSON stringify for logging
   */
  protected safeStringify(obj: any, maxDepth: number = 3): string {
    const seen = new WeakSet();

    return JSON.stringify(obj, (key, val) => {
      if (val != null && typeof val === 'object') {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    }, 2);
  }
}

/**
 * Utility function to create a function tool definition
 */
export function createFunctionTool(
  name: string,
  description: string,
  parameters: JsonSchema,
  options: {
    strict?: boolean;
  } = {}
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      strict: options.strict ?? false,
      parameters,
    },
  };
}

/**
 * Utility function to create object schema
 */
export function createObjectSchema(
  properties: Record<string, JsonSchema>,
  options: {
    required?: string[];
    additionalProperties?: boolean;
  } = {}
): JsonSchema {
  return {
    type: 'object',
    properties,
    required: options.required,
    additionalProperties: options.additionalProperties,
  };
}

/**
 * Convenience function to create a tool definition using simplified parameter syntax
 * Converts ParameterProperty format to JsonSchema internally
 *
 * @param name - Tool name
 * @param description - Tool description
 * @param properties - Tool parameters in simplified format
 * @param options - Additional options (required fields, etc.)
 * @returns ToolDefinition in OpenAI Responses API format
 */
export function createToolDefinition(
  name: string,
  description: string,
  properties: Record<string, ParameterProperty>,
  options: {
    required?: string[];
    category?: string;
    version?: string;
    metadata?: Record<string, any>;
  } = {}
): ToolDefinition {
  // Convert ParameterProperty to JsonSchema
  const convertToJsonSchema = (prop: ParameterProperty): JsonSchema => {
    if (prop.type === 'array' && prop.items) {
      return {
        type: 'array',
        items: convertToJsonSchema(prop.items),
        description: prop.description,
      };
    }
    if (prop.type === 'object' && prop.properties) {
      const convertedProps: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(prop.properties)) {
        convertedProps[key] = convertToJsonSchema(value);
      }
      return {
        type: 'object',
        properties: convertedProps,
        description: prop.description,
      };
    }
    return {
      type: prop.type as 'string' | 'number' | 'boolean',
      description: prop.description,
    };
  };

  const convertedProperties: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    convertedProperties[key] = convertToJsonSchema(value);
  }

  return createFunctionTool(name, description, createObjectSchema(convertedProperties, {
    required: options.required,
    additionalProperties: false,
  }));
}