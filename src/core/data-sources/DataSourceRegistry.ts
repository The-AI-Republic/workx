import { DataSourceError } from './errors';
import type { DataSource, DataSourceConnector } from './types';

export class DataSourceRegistry {
  private readonly connectors = new Map<string, DataSourceConnector>();
  private readonly sources = new Map<string, DataSource>();

  registerConnector(connector: DataSourceConnector): void {
    if (this.connectors.has(connector.id)) {
      throw new DataSourceError(
        'CONNECTOR_NOT_FOUND',
        `Connector ${connector.id} is already registered.`
      );
    }
    this.connectors.set(connector.id, connector);
  }

  async unregisterConnector(connectorId: string): Promise<void> {
    const connector = this.connectors.get(connectorId);
    if (!connector) return;
    if ([...this.sources.values()].some((source) => source.connectorId === connectorId)) {
      throw new DataSourceError(
        'CONNECTOR_NOT_FOUND',
        'Cannot remove a connector while sources use it.'
      );
    }
    this.connectors.delete(connectorId);
    await connector.dispose();
  }

  upsertSource(source: DataSource): void {
    if (!this.connectors.has(source.connectorId)) {
      throw new DataSourceError(
        'CONNECTOR_NOT_FOUND',
        `Connector ${source.connectorId} is unavailable.`
      );
    }
    this.sources.set(source.id, source);
  }

  async removeSource(sourceId: string): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) return;
    await this.getConnector(sourceId).invalidateSource(sourceId);
    this.sources.delete(sourceId);
  }

  listSources(): DataSource[] {
    return [...this.sources.values()].sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    );
  }

  getSource(sourceId: string): DataSource {
    const source = this.sources.get(sourceId);
    if (!source) throw new DataSourceError('SOURCE_NOT_FOUND', 'Data source not found.');
    return source;
  }

  getConnector(sourceId: string): DataSourceConnector {
    const source = this.getSource(sourceId);
    const connector = this.connectors.get(source.connectorId);
    if (!connector)
      throw new DataSourceError('CONNECTOR_NOT_FOUND', 'Data-source connector is unavailable.');
    return connector;
  }

  getConnectorById(connectorId: string): DataSourceConnector {
    const connector = this.connectors.get(connectorId);
    if (!connector)
      throw new DataSourceError('CONNECTOR_NOT_FOUND', 'Data-source connector is unavailable.');
    return connector;
  }

  listConnectorIds(): string[] {
    return [...this.connectors.keys()].sort();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.connectors.values()].map((connector) => connector.dispose()));
    this.sources.clear();
    this.connectors.clear();
  }
}
