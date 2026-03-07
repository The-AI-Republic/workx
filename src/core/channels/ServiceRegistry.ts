/**
 * Service Registry
 *
 * Routes ServiceRequest Ops to registered service handlers.
 * Service paths use dotted notation: 'mcp.getServers', 'vault.status', etc.
 *
 * @module core/channels/ServiceRegistry
 */

import type { SubmissionContext } from './types';

/**
 * Handler function for a service request
 */
export type ServiceHandler = (
  params: Record<string, unknown>,
  context: SubmissionContext
) => Promise<unknown>;

/**
 * Service Registry
 *
 * Manages service handlers and routes requests to them.
 *
 * @example
 * ```typescript
 * const registry = new ServiceRegistry();
 * registry.register('mcp.getServers', async () => mcpManager.getServers());
 * const servers = await registry.handle('mcp.getServers', {}, context);
 * ```
 */
export class ServiceRegistry {
  private handlers = new Map<string, ServiceHandler>();

  /**
   * Register a handler for a service path
   */
  register(servicePath: string, handler: ServiceHandler): void {
    this.handlers.set(servicePath, handler);
  }

  /**
   * Unregister a handler for a service path
   */
  unregister(servicePath: string): void {
    this.handlers.delete(servicePath);
  }

  /**
   * Handle a service request
   *
   * @throws Error if service path is not registered
   */
  async handle(
    servicePath: string,
    params: Record<string, unknown>,
    context: SubmissionContext
  ): Promise<unknown> {
    const handler = this.handlers.get(servicePath);
    if (!handler) {
      throw new Error(`Unknown service: ${servicePath}`);
    }
    return handler(params, context);
  }

  /**
   * Check if a service path is registered
   */
  has(servicePath: string): boolean {
    return this.handlers.has(servicePath);
  }

  /**
   * List all registered service paths
   */
  listServices(): string[] {
    return Array.from(this.handlers.keys());
  }
}
