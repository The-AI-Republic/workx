/**
 * Service Registration
 *
 * Shared entry point for registering all service handlers.
 * Each platform bootstrap calls registerAllServices() with its available dependencies.
 *
 * @module core/services
 */

import type { ServiceRegistry } from '@/core/channels/ServiceRegistry';
import { createMcpServices, type MCPServiceDeps } from './mcp-services';
import { createSchedulerServices, type SchedulerServiceDeps } from './scheduler-services';
import { createSkillsServices, type SkillsServiceDeps } from './skills-services';
import { createVaultServices, type VaultServiceDeps } from './vault-services';
import { createA2AServices, type A2AServiceDeps } from './a2a-services';
import { createSessionServices, type SessionServiceDeps } from './session-services';
import { createAgentServices, type AgentServiceDeps } from './agent-services';
import { createAuthServices, type AuthServiceDeps } from './auth-services';
import { createStorageServices, type StorageServiceDeps } from './storage-services';
import { createPluginsServices, type PluginsServiceDeps } from './plugins-services';
import { createDiagnosticsServices, type DiagnosticsServiceDeps } from './diagnostics-services';
import { createMemoryServices, type MemoryServiceDeps } from './memory-services';
import { createRuntimeServices, type RuntimeServiceDeps } from './runtime-services';
import { createModelServices, type ModelsServiceDeps } from './models-services';
import { createCredentialServices, type CredentialServiceDeps } from './credentials-services';
import { createDataSourceServices, type DataSourceServiceDeps } from './data-sources-services';

/**
 * Dependencies for registering all services.
 * All fields are optional — only services with provided dependencies are registered.
 */
export interface AllServiceDeps {
  mcp?: MCPServiceDeps;
  scheduler?: SchedulerServiceDeps;
  skills?: SkillsServiceDeps;
  vault?: VaultServiceDeps;
  a2a?: A2AServiceDeps;
  session?: SessionServiceDeps;
  agent?: AgentServiceDeps;
  auth?: AuthServiceDeps;
  storage?: StorageServiceDeps;
  plugins?: PluginsServiceDeps;
  diagnostics?: DiagnosticsServiceDeps;
  memory?: MemoryServiceDeps;
  runtime?: RuntimeServiceDeps;
  models?: ModelsServiceDeps;
  credentials?: CredentialServiceDeps;
  dataSources?: DataSourceServiceDeps;
}

/**
 * Register all service handlers for which dependencies are provided.
 *
 * @returns The number of services registered
 */
export function registerAllServices(registry: ServiceRegistry, deps: AllServiceDeps): number {
  let count = 0;

  const factories: Array<[keyof AllServiceDeps, (d: any) => Record<string, any>]> = [
    ['mcp', createMcpServices],
    ['scheduler', createSchedulerServices],
    ['skills', createSkillsServices],
    ['vault', createVaultServices],
    ['a2a', createA2AServices],
    ['session', createSessionServices],
    ['agent', createAgentServices],
    ['auth', createAuthServices],
    ['storage', createStorageServices],
    ['plugins', createPluginsServices],
    ['diagnostics', createDiagnosticsServices],
    ['memory', createMemoryServices],
    ['runtime', createRuntimeServices],
    ['models', createModelServices],
    ['credentials', createCredentialServices],
    ['dataSources', createDataSourceServices],
  ];

  for (const [key, factory] of factories) {
    const d = deps[key];
    if (d) {
      const handlers = factory(d);
      for (const [path, handler] of Object.entries(handlers)) {
        registry.register(path, handler);
        count++;
      }
    }
  }

  return count;
}

// Re-export individual factories for fine-grained use
export { createMcpServices, type MCPServiceDeps } from './mcp-services';
export { createSchedulerServices, type SchedulerServiceDeps } from './scheduler-services';
export { createSkillsServices, type SkillsServiceDeps } from './skills-services';
export { createVaultServices, type VaultServiceDeps } from './vault-services';
export { createA2AServices, type A2AServiceDeps } from './a2a-services';
export { createSessionServices, type SessionServiceDeps } from './session-services';
export { createAgentServices, type AgentServiceDeps } from './agent-services';
export { createAuthServices, type AuthServiceDeps } from './auth-services';
export { createStorageServices, type StorageServiceDeps } from './storage-services';
export { createPluginsServices, type PluginsServiceDeps } from './plugins-services';
export { createDiagnosticsServices, type DiagnosticsServiceDeps } from './diagnostics-services';
export { createMemoryServices, type MemoryServiceDeps } from './memory-services';
export { createRuntimeServices, type RuntimeServiceDeps } from './runtime-services';
export { createModelServices, type ModelsServiceDeps } from './models-services';
export { createCredentialServices, type CredentialServiceDeps } from './credentials-services';
export { createDataSourceServices, type DataSourceServiceDeps } from './data-sources-services';
