/**
 * UserNotifier - Manages user notifications in the Chrome extension
 * Adapted for browser context
 */

import type { EventMsg } from './protocol/events';
import type { Event } from './protocol/types';
import { t } from '@/webfront/lib/i18n';

/**
 * Notification types
 */
export type NotificationType =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'progress'
  | 'approval';

/**
 * Notification priority levels
 */
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * User notification interface
 */
export interface UserNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
  priority: NotificationPriority;
  persistent: boolean;
  actions?: NotificationAction[];
  metadata?: any;
  progress?: {
    current: number;
    total: number;
  };
}

/**
 * Notification action interface
 */
export interface NotificationAction {
  id: string;
  label: string;
  style?: 'default' | 'primary' | 'danger';
}

/**
 * Notification callback
 */
export type NotificationCallback = (notification: UserNotification) => void;

/**
 * Action handler callback
 */
export type ActionHandler = (notificationId: string, actionId: string) => void;

/**
 * UserNotifier class - manages notifications to the user
 * Designed for browser environment
 */
export class UserNotifier {
  private notifications: Map<string, UserNotification> = new Map();
  private notificationCallbacks: Set<NotificationCallback> = new Set();
  private actionHandlers: Map<string, ActionHandler> = new Map();
  private notificationIdCounter: number = 1;
  private chromeNotificationSupport: boolean = false;
  private maxNotifications: number = 100;
  private notificationHistory: UserNotification[] = [];
  private externalCommand?: string;
  private fallbackToConsole: boolean = true; // Fallback when Chrome notifications unavailable

  constructor(config?: {
    externalCommand?: string;
    fallbackToConsole?: boolean;
  }) {
    this.externalCommand = config?.externalCommand;
    this.fallbackToConsole = config?.fallbackToConsole ?? true;
    this.checkChromeNotificationSupport();
  }

  /**
   * Check if Chrome notifications API is available
   */
  private checkChromeNotificationSupport(): void {
    if (typeof chrome !== 'undefined' && chrome.notifications) {
      this.chromeNotificationSupport = true;
      this.setupChromeNotificationListeners();
    }
  }

  /**
   * Setup Chrome notification event listeners
   */
  private setupChromeNotificationListeners(): void {
    if (!this.chromeNotificationSupport) return;

    // Listen for notification clicks
    chrome.notifications.onClicked.addListener((notificationId) => {
      this.handleNotificationClick(notificationId);
    });

    // Listen for notification action button clicks
    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      this.handleNotificationAction(notificationId, buttonIndex);
    });

    // Listen for notification close
    chrome.notifications.onClosed.addListener((notificationId) => {
      this.handleNotificationClosed(notificationId);
    });
  }

  /**
   * Create and display a notification
   */
  async notify(
    type: NotificationType,
    title: string,
    message: string,
    options?: {
      priority?: NotificationPriority;
      persistent?: boolean;
      actions?: NotificationAction[];
      metadata?: any;
      progress?: { current: number; total: number };
    }
  ): Promise<string> {
    const notificationId = `notif_${this.notificationIdCounter++}`;

    const notification: UserNotification = {
      id: notificationId,
      type,
      title,
      message,
      timestamp: Date.now(),
      priority: options?.priority || 'normal',
      persistent: options?.persistent || false,
      actions: options?.actions,
      metadata: options?.metadata,
      progress: options?.progress,
    };

    // Store notification
    this.notifications.set(notificationId, notification);
    this.addToHistory(notification);

    // Try to show Chrome notification if available
    try {
      if (this.chromeNotificationSupport) {
        await this.showChromeNotification(notification);
      } else if (this.fallbackToConsole) {
        this.showFallbackNotification(notification);
      }
    } catch (error) {
      console.warn('Primary notification method failed, using fallback:', error);
      if (this.fallbackToConsole) {
        this.showFallbackNotification(notification);
      }
    }

    // Notify callbacks
    this.notifyCallbacks(notification);

    // Auto-dismiss non-persistent notifications
    if (!notification.persistent) {
      setTimeout(() => {
        this.dismissNotification(notificationId);
      }, this.getAutoDismissDelay(type, options?.priority));
    }

    return notificationId;
  }

  /**
   * Show fallback notification when Chrome notifications are unavailable
   */
  private showFallbackNotification(notification: UserNotification): void {
    const typeIcon = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      progress: '📊',
      approval: '❓',
    }[notification.type] || '📢';

    const priorityIndicator = notification.priority === 'urgent' ? '🚨' :
                              notification.priority === 'high' ? '❗' : '';

    const progressInfo = notification.progress
      ? ` [${notification.progress.current}/${notification.progress.total}]`
      : '';

    // Log to console with structured format
    console.log(
      `${typeIcon} [${notification.type.toUpperCase()}]${priorityIndicator} ${notification.title}: ${notification.message}${progressInfo}`
    );

    // Also emit to content script or popup if available
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'FALLBACK_NOTIFICATION',
        payload: notification,
      }).catch(() => {
        // Ignore errors if no listeners
      });
    }

    // Store in sessionStorage for popup/content script access
    if (typeof sessionStorage !== 'undefined') {
      try {
        const notifications = JSON.parse(sessionStorage.getItem('pendingNotifications') || '[]');
        notifications.push(notification);
        sessionStorage.setItem('pendingNotifications', JSON.stringify(notifications));
      } catch (error) {
        // Ignore storage errors
      }
    }
  }

  /**
   * Show a Chrome notification
   */
  private async showChromeNotification(notification: UserNotification): Promise<void> {
    if (!this.chromeNotificationSupport) return;

    const iconUrl = this.getIconForType(notification.type);
    const priority = this.convertPriorityToChrome(notification.priority);

    const chromeOptions: any = {
      type: notification.progress ? 'progress' : 'basic',
      iconUrl,
      title: notification.title,
      message: notification.message,
      priority,
      requireInteraction: notification.persistent,
      silent: notification.priority === 'low',
    };

    // Add progress if available
    if (notification.progress) {
      chromeOptions.progress = Math.round(
        (notification.progress.current / notification.progress.total) * 100
      );
    }

    // Add action buttons
    if (notification.actions && notification.actions.length > 0) {
      chromeOptions.buttons = notification.actions.slice(0, 2).map(action => ({
        title: action.label,
      }));
    }

    try {
      await new Promise<void>((resolve, reject) => {
        chrome.notifications.create(notification.id, chromeOptions as chrome.notifications.NotificationCreateOptions, (id) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      console.error('Failed to create Chrome notification:', error);
    }
  }

  /**
   * Get icon URL for notification type
   */
  private getIconForType(type: NotificationType): string {
    const iconMap: Record<NotificationType, string> = {
      info: '/icons/icon48.svg',
      success: '/icons/icon48.svg',
      warning: '/icons/icon48.svg',
      error: '/icons/icon48.svg',
      progress: '/icons/icon48.svg',
      approval: '/icons/icon48.svg',
    };

    return iconMap[type] || '/icons/icon48.svg';
  }

  /**
   * Convert priority to Chrome notification priority
   */
  private convertPriorityToChrome(priority: NotificationPriority): number {
    const priorityMap: Record<NotificationPriority, number> = {
      low: -2,
      normal: 0,
      high: 1,
      urgent: 2,
    };

    return priorityMap[priority];
  }

  /**
   * Get auto-dismiss delay based on type and priority
   */
  private getAutoDismissDelay(
    type: NotificationType,
    priority?: NotificationPriority
  ): number {
    if (priority === 'urgent') return 10000; // 10 seconds
    if (priority === 'high') return 7000; // 7 seconds

    switch (type) {
      case 'error':
        return 8000; // 8 seconds
      case 'warning':
        return 6000; // 6 seconds
      case 'success':
        return 4000; // 4 seconds
      case 'info':
      case 'progress':
      default:
        return 5000; // 5 seconds
    }
  }

  /**
   * Dismiss a notification
   */
  async dismissNotification(notificationId: string): Promise<void> {
    const notification = this.notifications.get(notificationId);
    if (!notification) return;

    // Remove from active notifications
    this.notifications.delete(notificationId);

    // Clear Chrome notification if exists
    if (this.chromeNotificationSupport) {
      chrome.notifications.clear(notificationId);
    }
  }

  /**
   * Update notification progress
   */
  async updateProgress(
    notificationId: string,
    current: number,
    total: number
  ): Promise<void> {
    const notification = this.notifications.get(notificationId);
    if (!notification) return;

    notification.progress = { current, total };

    // Update Chrome notification
    if (this.chromeNotificationSupport) {
      chrome.notifications.update(notificationId, {
        progress: Math.round((current / total) * 100),
      });
    }

    // Notify callbacks
    this.notifyCallbacks(notification);
  }

  /**
   * Show approval request notification
   */
  async showApprovalRequest(
    title: string,
    message: string,
    approvalId: string
  ): Promise<string> {
    return this.notify('approval', title, message, {
      priority: 'high',
      persistent: true,
      actions: [
        { id: 'approve', label: t('Approve'), style: 'primary' },
        { id: 'reject', label: t('Reject'), style: 'danger' },
      ],
      metadata: { approvalId },
    });
  }

  /**
   * Show error notification
   */
  async notifyError(title: string, message: string): Promise<string> {
    return this.notify('error', title, message, {
      priority: 'high',
    });
  }

  /**
   * Show success notification
   */
  async notifySuccess(title: string, message: string): Promise<string> {
    return this.notify('success', title, message);
  }

  /**
   * Show info notification
   */
  async notifyInfo(title: string, message: string): Promise<string> {
    return this.notify('info', title, message);
  }

  /**
   * Show warning notification
   */
  async notifyWarning(title: string, message: string): Promise<string> {
    return this.notify('warning', title, message, {
      priority: 'high',
    });
  }

  /**
   * Show progress notification
   */
  async notifyProgress(
    title: string,
    message: string,
    current: number,
    total: number
  ): Promise<string> {
    return this.notify('progress', title, message, {
      progress: { current, total },
      persistent: true,
    });
  }

  /**
   * Register notification callback
   */
  onNotification(callback: NotificationCallback): void {
    this.notificationCallbacks.add(callback);
  }

  /**
   * Unregister notification callback
   */
  offNotification(callback: NotificationCallback): void {
    this.notificationCallbacks.delete(callback);
  }

  /**
   * Register action handler
   */
  onAction(notificationId: string, handler: ActionHandler): void {
    this.actionHandlers.set(notificationId, handler);
  }

  /**
   * Handle notification click
   */
  private handleNotificationClick(notificationId: string): void {
    const notification = this.notifications.get(notificationId);
    if (!notification) return;

    // If no actions, dismiss the notification
    if (!notification.actions || notification.actions.length === 0) {
      this.dismissNotification(notificationId);
    }
  }

  /**
   * Handle notification action
   */
  private handleNotificationAction(notificationId: string, buttonIndex: number): void {
    const notification = this.notifications.get(notificationId);
    if (!notification || !notification.actions) return;

    const action = notification.actions[buttonIndex];
    if (!action) return;

    // Call action handler if registered
    const handler = this.actionHandlers.get(notificationId);
    if (handler) {
      handler(notificationId, action.id);
    }

    // Dismiss notification after action
    this.dismissNotification(notificationId);
  }

  /**
   * Handle notification closed
   */
  private handleNotificationClosed(notificationId: string): void {
    this.notifications.delete(notificationId);
  }

  /**
   * Notify all callbacks
   */
  private notifyCallbacks(notification: UserNotification): void {
    this.notificationCallbacks.forEach(callback => {
      try {
        callback(notification);
      } catch (error) {
        console.error('Notification callback error:', error);
      }
    });
  }

  /**
   * Add notification to history
   */
  private addToHistory(notification: UserNotification): void {
    this.notificationHistory.push(notification);

    // Limit history size
    if (this.notificationHistory.length > this.maxNotifications) {
      this.notificationHistory.shift();
    }
  }

  /**
   * Get notification history
   */
  getHistory(): UserNotification[] {
    return [...this.notificationHistory];
  }

  /**
   * Clear notification history
   */
  clearHistory(): void {
    this.notificationHistory = [];
  }

  /**
   * Get active notifications
   */
  getActiveNotifications(): UserNotification[] {
    return Array.from(this.notifications.values());
  }

  /**
   * Clear all notifications
   */
  async clearAll(): Promise<void> {
    const notificationIds = Array.from(this.notifications.keys());

    for (const id of notificationIds) {
      await this.dismissNotification(id);
    }
  }

  /**
   * Notify agent turn completion
   */
  async notifyAgentTurnComplete(
    turnId: string,
    inputMessages: string[],
    lastAssistantMessage?: string
  ): Promise<void> {
    const title = t('Agent Turn Complete');
    const message = lastAssistantMessage
      ? t(`Completed: ${lastAssistantMessage.substring(0, 100)}${lastAssistantMessage.length > 100 ? '...' : ''}`)
      : t('Agent turn completed successfully');

    // Create notification with metadata
    await this.notify('success', title, message, {
      priority: 'normal',
      metadata: {
        type: 'agent-turn-complete',
        'turn-id': turnId,
        'input-messages': inputMessages,
        'last-assistant-message': lastAssistantMessage,
      }
    });

    // If external command is configured, send notification to external process
    if (this.externalCommand) {
      await this.notifyExternal({
        type: 'agent-turn-complete',
        'turn-id': turnId,
        'input-messages': inputMessages,
        'last-assistant-message': lastAssistantMessage,
      });
    }
  }

  /**
   * Send notification to external command
   */
  private async notifyExternal(notification: any): Promise<void> {
    if (!this.externalCommand) return;

    try {
      const json = JSON.stringify(notification);

      // In Chrome extension context, we can't directly spawn processes
      // Instead, send via native messaging or other extension APIs
      if (chrome.runtime && chrome.runtime.sendNativeMessage) {
        chrome.runtime.sendNativeMessage(
          this.externalCommand,
          { notification: json },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn(`Failed to send notification to external command: ${chrome.runtime.lastError.message}`);
            }
          }
        );
      } else {
        // Fallback: Log to console with special prefix for external monitoring
        console.log(`[EXTERNAL_NOTIFICATION] ${json}`);
      }
    } catch (error) {
      console.error('Failed to serialize notification payload:', error);
    }
  }

  /**
   * Process event and show notification if needed
   */
  async processEvent(event: Event): Promise<void> {
    // Defensive check for event structure
    if (!event || !event.msg) {
      console.error('UserNotifier: Invalid event structure:', event);
      return;
    }

    const eventMsg = event.msg;

    switch (eventMsg.type) {
      case 'Error':
        if (eventMsg.data?.message) {
          await this.notifyError(t('Error'), eventMsg.data.message);
        }
        break;

      case 'ExecApprovalRequest':
        if (eventMsg.data) {
          await this.showApprovalRequest(
            t('Command Approval Required'),
            t(`Approve execution: ${eventMsg.data.command}`),
            eventMsg.data.id
          );
        }
        break;

      case 'ApplyPatchApprovalRequest':
        if (eventMsg.data) {
          await this.showApprovalRequest(
            t('File Change Approval Required'),
            t(`Approve changes to: ${eventMsg.data.path}`),
            eventMsg.data.id
          );
        }
        break;

      case 'TaskFailed':
        if (eventMsg.data?.reason) {
          await this.notifyError(t('Task Failed'), eventMsg.data.reason);
        }
        break;

      default:
        // Handle other event types as needed
        break;
    }
  }

  /**
   * Get notification by ID
   */
  getNotification(notificationId: string): UserNotification | undefined {
    return this.notifications.get(notificationId);
  }

  /**
   * Check if notification exists
   */
  hasNotification(notificationId: string): boolean {
    return this.notifications.has(notificationId);
  }
}