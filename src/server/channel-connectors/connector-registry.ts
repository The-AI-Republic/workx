/**
 * Connector Registry
 *
 * Stores and queries registered channel connectors and their accounts.
 *
 * @module server/channel-connectors/connector-registry
 */

import type {
  ChannelConnector,
  ChannelAccountSnapshot,
  OpenClawConnectorDefinition,
} from './types';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface RegisteredConnector {
  definition: OpenClawConnectorDefinition;
  connector: ChannelConnector;
  accounts: Map<string, ChannelAccountSnapshot>;
}

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

export class ConnectorRegistry {
  private connectors = new Map<string, RegisteredConnector>();

  /**
   * Register a channel connector with its definition.
   */
  register(definition: OpenClawConnectorDefinition, connector: ChannelConnector): void {
    this.connectors.set(connector.id, {
      definition,
      connector,
      accounts: new Map(),
    });
  }

  /**
   * Get a registered connector by ID.
   */
  get(connectorId: string): RegisteredConnector | undefined {
    return this.connectors.get(connectorId);
  }

  /**
   * Get all registered connectors.
   */
  getAll(): RegisteredConnector[] {
    return Array.from(this.connectors.values());
  }

  /**
   * Update account snapshot for a connector.
   */
  updateAccountSnapshot(connectorId: string, snapshot: ChannelAccountSnapshot): void {
    const entry = this.connectors.get(connectorId);
    if (entry) {
      entry.accounts.set(snapshot.accountId, snapshot);
    }
  }

  /**
   * Get all account snapshots across all connectors.
   */
  getAllSnapshots(): ChannelAccountSnapshot[] {
    const snapshots: ChannelAccountSnapshot[] = [];
    for (const entry of this.connectors.values()) {
      for (const snapshot of entry.accounts.values()) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  /**
   * Remove a connector from the registry.
   */
  unregister(connectorId: string): void {
    this.connectors.delete(connectorId);
  }

  /**
   * Get connector count.
   */
  get size(): number {
    return this.connectors.size;
  }
}
