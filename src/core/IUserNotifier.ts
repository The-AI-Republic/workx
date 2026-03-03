import type { Event } from './protocol/types';
import type { UserNotification, NotificationCallback } from './UserNotifier';

/**
 * Platform-agnostic notifier interface.
 * PiAgent programs against this contract; each platform supplies its own
 * implementation (Chrome notifications, console logging, no-op, etc.).
 */
export interface IUserNotifier {
  notifyInfo(title: string, message: string): Promise<string>;
  notifyWarning(title: string, message: string): Promise<string>;
  notifyProgress(title: string, message: string, current: number, total: number): Promise<string>;
  updateProgress(notificationId: string, current: number, total: number): Promise<void>;
  processEvent(event: Event): Promise<void>;
  clearAll(): Promise<void>;
  onNotification(callback: NotificationCallback): void;
}

/**
 * No-op notifier for headless / server environments.
 */
export class NoOpNotifier implements IUserNotifier {
  async notifyInfo(): Promise<string> { return ''; }
  async notifyWarning(): Promise<string> { return ''; }
  async notifyProgress(): Promise<string> { return ''; }
  async updateProgress(): Promise<void> {}
  async processEvent(): Promise<void> {}
  async clearAll(): Promise<void> {}
  onNotification(): void {}
}
