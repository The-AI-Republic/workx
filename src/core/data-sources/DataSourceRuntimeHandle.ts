import { DataSourceError } from './errors';
import type { DataSourceErrorCode, DataSourcesStatus } from './types';
import type { DataSourceRuntime } from './DataSourceRuntime';

export class DataSourceRuntimeHandle {
  private runtime: DataSourceRuntime | null = null;
  private status: DataSourcesStatus = {
    state: 'initializing',
    available: false,
    toolsEnabled: false,
    connectorIds: [],
  };

  setReady(runtime: DataSourceRuntime, toolsEnabled: boolean): void {
    this.runtime = runtime;
    this.status = {
      state: 'ready',
      available: true,
      toolsEnabled,
      connectorIds: runtime.getConnectorIds(),
    };
  }

  setUnavailable(errorCode: DataSourceErrorCode = 'DATA_SOURCES_UNAVAILABLE'): void {
    this.runtime = null;
    this.status = {
      state: 'unavailable',
      available: false,
      toolsEnabled: false,
      connectorIds: [],
      errorCode,
    };
  }

  markStopping(): void {
    this.status = {
      ...this.status,
      state: 'stopping',
      available: false,
      toolsEnabled: false,
    };
  }

  getStatus(): DataSourcesStatus {
    return { ...this.status, connectorIds: [...this.status.connectorIds] };
  }

  getRuntime(): DataSourceRuntime | null {
    return this.runtime;
  }

  requireRuntime(): DataSourceRuntime {
    if (!this.runtime || this.status.state !== 'ready') {
      throw new DataSourceError('DATA_SOURCES_UNAVAILABLE', 'Data sources are unavailable.', true);
    }
    return this.runtime;
  }
}
