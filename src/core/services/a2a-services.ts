/**
 * A2A (Agent-to-Agent) Service Handlers
 *
 * Platform-agnostic service handlers for A2A agent management.
 * Extracted from extension service-worker setupA2AMessageHandlers().
 *
 * @module core/services/a2a-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface A2AServiceDeps {
  a2aManager: {
    getAgents(): unknown;
    addAgent(config: unknown): unknown;
    updateAgent(id: string, update: unknown): unknown;
    removeAgent(id: string): Promise<void>;
    connect(id: string): Promise<void>;
    disconnect(id: string): Promise<void>;
    getConnection(id: string): unknown;
    getConnections(): unknown;
    getAllSkills(): unknown;
    executeSkill(prefixedName: string, args: Record<string, unknown>): unknown;
    cancelTask(agentName: string, taskId: string): Promise<void>;
  };
}

export function createA2AServices(deps: A2AServiceDeps): Record<string, ServiceHandler> {
  const { a2aManager } = deps;

  return {
    'a2a.getAgents': async () => {
      const data = await a2aManager.getAgents();
      return { success: true, data };
    },

    'a2a.addAgent': async (params) => {
      await a2aManager.addAgent(params);
      return { success: true };
    },

    'a2a.updateAgent': async (params) => {
      const { id, update } = params as { id: string; update: unknown };
      await a2aManager.updateAgent(id, update);
      return { success: true };
    },

    'a2a.removeAgent': async (params) => {
      const { id } = params as { id: string };
      await a2aManager.removeAgent(id);
      return { success: true };
    },

    'a2a.connect': async (params) => {
      const { id } = params as { id: string };
      await a2aManager.connect(id);
      return { success: true };
    },

    'a2a.disconnect': async (params) => {
      const { id } = params as { id: string };
      await a2aManager.disconnect(id);
      return { success: true };
    },

    'a2a.getConnection': async (params) => {
      const { id } = params as { id: string };
      const data = await a2aManager.getConnection(id);
      return { success: true, data };
    },

    'a2a.getConnections': async () => {
      const data = await a2aManager.getConnections();
      return { success: true, data };
    },

    'a2a.getAllSkills': async () => {
      const data = await a2aManager.getAllSkills();
      return { success: true, data };
    },

    'a2a.executeSkill': async (params) => {
      const { prefixedName, args } = params as {
        prefixedName: string;
        args: Record<string, unknown>;
      };
      const data = await a2aManager.executeSkill(prefixedName, args);
      return { success: true, data };
    },

    'a2a.cancelTask': async (params) => {
      const { agentName, taskId } = params as { agentName: string; taskId: string };
      await a2aManager.cancelTask(agentName, taskId);
      return { success: true };
    },
  };
}
