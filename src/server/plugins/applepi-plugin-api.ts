/**
 * ApplePi Plugin API
 *
 * ApplePi's implementation of the OpenClawPluginApi interface.
 * Provides the API surface that plugins interact with during registration.
 *
 * @module server/plugins/applepi-plugin-api
 */

import type {
  OpenClawPluginApi,
  ChannelPluginRegistration,
} from './types';
import { emitLog } from '../handlers/logs';

export class ApplePiPluginApi implements OpenClawPluginApi {
  private registrations: ChannelPluginRegistration[] = [];

  registerChannel(registration: ChannelPluginRegistration): void {
    this.registrations.push(registration);
    console.log(`[ApplePiPluginApi] Channel registered: ${registration.plugin.id}`);
  }

  getHostPlatform(): string {
    return 'applepi-server';
  }

  getHostVersion(): string {
    return '1.0.0';
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    emitLog(level, `[Plugin] ${message}`, data);
  }

  /**
   * Get all registered channel plugins.
   */
  getRegistrations(): ChannelPluginRegistration[] {
    return [...this.registrations];
  }
}
