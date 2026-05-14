/**
 * ApplePi Connector API
 *
 * ApplePi's implementation of the OpenClawConnectorApi interface.
 * Provides the API surface that connectors interact with during registration.
 *
 * @module server/channel-connectors/applepi-connector-api
 */

import type {
  OpenClawConnectorApi,
  ChannelConnectorRegistration,
} from './types';
import { emitLog } from '../handlers/logs';

export class ApplePiConnectorApi implements OpenClawConnectorApi {
  private registrations: ChannelConnectorRegistration[] = [];

  registerChannel(registration: ChannelConnectorRegistration): void {
    this.registrations.push(registration);
    console.log(`[ApplePiConnectorApi] Channel registered: ${registration.connector.id}`);
  }

  getHostPlatform(): string {
    return 'applepi-server';
  }

  getHostVersion(): string {
    return '1.0.0';
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    emitLog(level, `[Connector] ${message}`, data);
  }

  /**
   * Get all registered channel connectors.
   */
  getRegistrations(): ChannelConnectorRegistration[] {
    return [...this.registrations];
  }
}
