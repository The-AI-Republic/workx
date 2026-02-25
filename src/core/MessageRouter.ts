/**
 * Message router for Chrome extension communication
 * Handles message passing between background, content scripts, and side panel
 */

import type { Submission, Event } from './protocol/types';
import type { EventMsg } from './protocol/events';
import type { ResponseEvent } from './models/types/ResponseEvent';

/**
 * Message types for Chrome extension communication
 */
export enum MessageType {
  // Core protocol messages
  SUBMISSION = 'SUBMISSION',
  EVENT = 'EVENT',

  // Connection management
  PING = 'PING',
  PONG = 'PONG',
  HEALTH_CHECK = 'HEALTH_CHECK',
  HEALTH_STATUS = 'HEALTH_STATUS',

  // State queries
  GET_STATE = 'GET_STATE',
  STATE_UPDATE = 'STATE_UPDATE',

  // Tab operations
  TAB_COMMAND = 'TAB_COMMAND',

  // Storage operations
  STORAGE_GET = 'STORAGE_GET',
  STORAGE_SET = 'STORAGE_SET',

  // Tool execution messages (kept for future use)
  TOOL_EXECUTE = 'TOOL_EXECUTE',

  // DOM operation messages
  DOM_ACTION = 'DOM_ACTION',
  DOM_RESPONSE = 'DOM_RESPONSE',

  // DOM Capture messages (v2.0)
  DOM_CAPTURE_REQUEST = 'DOM_CAPTURE_REQUEST',
  DOM_CAPTURE_RESPONSE = 'DOM_CAPTURE_RESPONSE',

  // Approval messages (kept for future use)
  APPROVAL_REQUEST = 'APPROVAL_REQUEST',

  // Diff tracking messages (kept for future use)
  DIFF_GENERATED = 'DIFF_GENERATED',

  // ResponseEvent streaming messages (Phase 6)
  RESPONSE_EVENT = 'RESPONSE_EVENT',
  RESPONSE_CREATED = 'RESPONSE_CREATED',
  RESPONSE_OUTPUT_ITEM_DONE = 'RESPONSE_OUTPUT_ITEM_DONE',
  RESPONSE_COMPLETED = 'RESPONSE_COMPLETED',
  RESPONSE_OUTPUT_TEXT_DELTA = 'RESPONSE_OUTPUT_TEXT_DELTA',
  RESPONSE_REASONING_SUMMARY_DELTA = 'RESPONSE_REASONING_SUMMARY_DELTA',
  RESPONSE_REASONING_CONTENT_DELTA = 'RESPONSE_REASONING_CONTENT_DELTA',
  RESPONSE_REASONING_SUMMARY_PART_ADDED = 'RESPONSE_REASONING_SUMMARY_PART_ADDED',
  RESPONSE_WEB_SEARCH_CALL_BEGIN = 'RESPONSE_WEB_SEARCH_CALL_BEGIN',
  RESPONSE_RATE_LIMITS = 'RESPONSE_RATE_LIMITS',

  // Session management
  SESSION_RESET = 'SESSION_RESET',
  SESSION_RESET_COMPLETE = 'SESSION_RESET_COMPLETE',
  RESUME_SESSION = 'RESUME_SESSION',
  RESUME_SESSION_COMPLETE = 'RESUME_SESSION_COMPLETE',

  // Agent control
  INTERRUPT = 'STOP_AGENT_SESSION', // Stop/interrupt the running agent

  // Configuration management
  CONFIG_UPDATE = 'CONFIG_UPDATE',
  AGENT_REINITIALIZED = 'AGENT_REINITIALIZED',

  // Authentication management
  INIT_AUTH = 'INIT_AUTH',

  // MCP Server Integration messages
  MCP_GET_SERVERS = 'MCP_GET_SERVERS',
  MCP_ADD_SERVER = 'MCP_ADD_SERVER',
  MCP_UPDATE_SERVER = 'MCP_UPDATE_SERVER',
  MCP_REMOVE_SERVER = 'MCP_REMOVE_SERVER',
  MCP_CONNECT = 'MCP_CONNECT',
  MCP_DISCONNECT = 'MCP_DISCONNECT',
  MCP_GET_CONNECTION = 'MCP_GET_CONNECTION',
  MCP_GET_CONNECTIONS = 'MCP_GET_CONNECTIONS',
  MCP_GET_ALL_TOOLS = 'MCP_GET_ALL_TOOLS',
  MCP_EXECUTE_TOOL = 'MCP_EXECUTE_TOOL',
  MCP_GET_ALL_RESOURCES = 'MCP_GET_ALL_RESOURCES',
  MCP_READ_RESOURCE = 'MCP_READ_RESOURCE',

  // Task Scheduler messages
  SCHEDULER_CREATE_DRAFT_TASK = 'SCHEDULER_CREATE_DRAFT_TASK',
  SCHEDULER_SCHEDULE_TASK = 'SCHEDULER_SCHEDULE_TASK',
  SCHEDULER_TRIGGER_TASK = 'SCHEDULER_TRIGGER_TASK',
  SCHEDULER_CANCEL_TASK = 'SCHEDULER_CANCEL_TASK',
  SCHEDULER_COMPLETE_TASK = 'SCHEDULER_COMPLETE_TASK',
  SCHEDULER_FAIL_TASK = 'SCHEDULER_FAIL_TASK',
  SCHEDULER_PAUSE_QUEUE = 'SCHEDULER_PAUSE_QUEUE',
  SCHEDULER_RESUME_QUEUE = 'SCHEDULER_RESUME_QUEUE',
  SCHEDULER_GET_DRAFT_TASKS = 'SCHEDULER_GET_DRAFT_TASKS',
  SCHEDULER_GET_SCHEDULED_TASKS = 'SCHEDULER_GET_SCHEDULED_TASKS',
  SCHEDULER_GET_MISSED_TASKS = 'SCHEDULER_GET_MISSED_TASKS',
  SCHEDULER_GET_QUEUE = 'SCHEDULER_GET_QUEUE',
  SCHEDULER_GET_ARCHIVED_TASKS = 'SCHEDULER_GET_ARCHIVED_TASKS',
  SCHEDULER_GET_STATE = 'SCHEDULER_GET_STATE',
  SCHEDULER_GET_TASK_DETAILS = 'SCHEDULER_GET_TASK_DETAILS',
  SCHEDULER_TASK_STATUS_CHANGED = 'SCHEDULER_TASK_STATUS_CHANGED',
  SCHEDULER_STATE_CHANGED = 'SCHEDULER_STATE_CHANGED',
  SCHEDULER_EVENT = 'SCHEDULER_EVENT', // Unified event for real-time updates (T020)

  // Session management messages (Feature 015: Multi-Agent Instances)
  SESSION_LIST = 'SESSION_LIST', // Get list of all sessions
  SESSION_GET_ACTIVE_COUNT = 'SESSION_GET_ACTIVE_COUNT', // Get active session count
  SESSION_EVENT = 'SESSION_EVENT', // Session lifecycle events (created, stateChanged, terminated)

  // Sidepanel multi-chat session messages
  SIDEPANEL_CREATE_SESSION = 'SIDEPANEL_CREATE_SESSION', // Create new 'primary' session for chat
  SIDEPANEL_CLOSE_SESSION = 'SIDEPANEL_CLOSE_SESSION', // Terminate session when chat closed
  SIDEPANEL_LIST_SESSIONS = 'SIDEPANEL_LIST_SESSIONS', // Get all 'primary' sessions for restoration

  // A2A Agent-to-Agent Protocol messages (Feature 021)
  A2A_GET_AGENTS = 'A2A_GET_AGENTS',
  A2A_ADD_AGENT = 'A2A_ADD_AGENT',
  A2A_UPDATE_AGENT = 'A2A_UPDATE_AGENT',
  A2A_REMOVE_AGENT = 'A2A_REMOVE_AGENT',
  A2A_CONNECT = 'A2A_CONNECT',
  A2A_DISCONNECT = 'A2A_DISCONNECT',
  A2A_GET_CONNECTION = 'A2A_GET_CONNECTION',
  A2A_GET_CONNECTIONS = 'A2A_GET_CONNECTIONS',
  A2A_GET_ALL_SKILLS = 'A2A_GET_ALL_SKILLS',
  A2A_EXECUTE_SKILL = 'A2A_EXECUTE_SKILL',
  A2A_CANCEL_TASK = 'A2A_CANCEL_TASK',
}

/**
 * Chrome extension message format
 * Feature 015: Added sessionId for multi-agent routing
 */
export interface ExtensionMessage {
  type: MessageType;
  payload?: any;
  id?: string;
  source?: 'background' | 'content' | 'sidepanel' | 'popup';
  tabId?: number;
  timestamp?: number;
  /** Feature 015: Target session ID for routing (defaults to primary if omitted) */
  sessionId?: string;
}

/**
 * Response format for messages
 */
export interface MessageResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Message router class
 */
export class MessageRouter {
  private handlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageIdCounter: number = 0;
  private source: ExtensionMessage['source'];
  private connected: boolean = false;

  constructor(source: ExtensionMessage['source']) {
    this.source = source;
    this.setupMessageListener();
  }

  /**
   * Setup Chrome runtime message listener
   */
  private setupMessageListener(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener(
        (message: ExtensionMessage, sender, sendResponse) => {
          this.handleMessage(message, sender, sendResponse);
          // Return true to indicate async response
          return true;
        }
      );
      console.log('[MessageRouter] Listener registered successfully');

      // Setup connection listeners for persistent connections
      chrome.runtime.onConnect.addListener((port) => {
        this.handleConnection(port);
      });
    } else {
      console.error('[MessageRouter] Cannot register listener - chrome.runtime not available!');
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void
  ): Promise<void> {
    try {
      // Add sender info to message
      message.tabId = sender.tab?.id;
      message.timestamp = Date.now();

      // Handle response messages
      if (message.id && this.pendingRequests.has(message.id)) {
        const request = this.pendingRequests.get(message.id)!;
        this.pendingRequests.delete(message.id);
        request.resolve(message.payload);
        sendResponse({ success: true });
        return;
      }

      // Process message through handlers
      const handlers = this.handlers.get(message.type);
      if (handlers && handlers.size > 0) {
        const responses: any[] = [];

        for (const handler of handlers) {
          try {
            const result = await handler(message, sender);
            if (result !== undefined) {
              responses.push(result);
            }
          } catch (error) {
            console.error(`Handler error for ${message.type}:`, error);
          }
        }

        // Send first response back
        if (responses.length > 0) {
          sendResponse({ success: true, data: responses[0] });
        } else {
          sendResponse({ success: true });
        }
      } else {
        sendResponse({
          success: false,
          error: `No handler for message type: ${message.type}`
        });
      }
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Handle persistent connection
   */
  private handleConnection(port: chrome.runtime.Port): void {
    console.log(`Connection established: ${port.name}`);

    port.onMessage.addListener((message) => {
      this.handlePortMessage(port, message);
    });

    port.onDisconnect.addListener(() => {
      console.log(`Connection closed: ${port.name}`);
      this.connected = false;
    });

    this.connected = true;
  }

  /**
   * Handle message from persistent port
   */
  private async handlePortMessage(
    port: chrome.runtime.Port,
    message: ExtensionMessage
  ): Promise<void> {
    // Process through regular handlers
    const handlers = this.handlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = await handler(message, { tab: { id: port.sender?.tab?.id } } as any);
          if (result !== undefined) {
            port.postMessage({
              type: message.type,
              payload: result,
              id: message.id,
            });
          }
        } catch (error) {
          console.error(`Port handler error for ${message.type}:`, error);
        }
      }
    }
  }

  /**
   * Register message handler
   */
  on(
    type: MessageType,
    handler: MessageHandler
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }

    this.handlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Send message to extension
   */
  async send(
    type: MessageType,
    payload?: any,
    tabId?: number
  ): Promise<any> {
    const messageId = `msg_${++this.messageIdCounter}`;
    const message: ExtensionMessage = {
      type,
      payload,
      id: messageId,
      source: this.source,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      // Store pending request
      this.pendingRequests.set(messageId, {
        resolve,
        reject,
        timestamp: Date.now(),
      });

      // Set timeout for response
      setTimeout(() => {
        if (this.pendingRequests.has(messageId)) {
          this.pendingRequests.delete(messageId);
          reject(new Error('Message timeout'));
        }
      }, 30000); // 30 second timeout

      // Send message
      if (tabId) {
        // Send to specific tab
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            this.pendingRequests.delete(messageId);
            reject(chrome.runtime.lastError);
          } else if (response?.success === false) {
            this.pendingRequests.delete(messageId);
            reject(new Error(response.error || 'Message failed'));
          } else {
            this.pendingRequests.delete(messageId);
            resolve(response?.data);
          }
        });
      } else {
        // Send to extension runtime
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            this.pendingRequests.delete(messageId);
            reject(chrome.runtime.lastError);
          } else if (response?.success === false) {
            this.pendingRequests.delete(messageId);
            reject(new Error(response.error || 'Message failed'));
          } else {
            this.pendingRequests.delete(messageId);
            resolve(response?.data);
          }
        });
      }
    });
  }

  /**
   * Broadcast message to all tabs
   */
  async broadcast(
    type: MessageType,
    payload?: any
  ): Promise<void> {
    const tabs = await chrome.tabs.query({});
    const promises = tabs.map(tab => {
      if (tab.id) {
        return this.send(type, payload, tab.id).catch(() => {
          // Ignore errors for individual tabs
        });
      }
    });

    await Promise.all(promises);
  }

  /**
   * Send submission to agent
   */
  async sendSubmission(submission: Submission): Promise<void> {
    await this.send(MessageType.SUBMISSION, submission);
  }

  /**
   * Send event from agent
   */
  async sendEvent(event: Event): Promise<void> {
    await this.send(MessageType.EVENT, event);
  }

  /**
   * Request current state
   */
  async getState(): Promise<any> {
    return this.send(MessageType.GET_STATE);
  }

  /**
   * Send state update
   */
  async updateState(state: any): Promise<void> {
    await this.send(MessageType.STATE_UPDATE, state);
  }

  /**
   * Execute tab command
   */
  async executeTabCommand(
    tabId: number,
    command: string,
    args?: any
  ): Promise<any> {
    return this.send(
      MessageType.TAB_COMMAND,
      { command, args },
      tabId
    );
  }

  /**
   * Storage operations
   */
  async storageGet(key: string): Promise<any> {
    return this.send(MessageType.STORAGE_GET, { key });
  }

  async storageSet(key: string, value: any): Promise<void> {
    await this.send(MessageType.STORAGE_SET, { key, value });
  }

  /**
   * Tool execution operations
   */
  async executeToolMessage(toolName: string, args: any): Promise<any> {
    return this.send(MessageType.TOOL_EXECUTE, { toolName, args });
  }

  /**
   * Approval operations (kept for future use)
   */
  async requestApproval(approvalId: string, type: string, details: any): Promise<any> {
    return this.send(MessageType.APPROVAL_REQUEST, { approvalId, type, details });
  }

  /**
   * Diff tracking operations (kept for future use)
   */
  async sendDiffGenerated(diffId: string, path: string, content: any): Promise<void> {
    await this.send(MessageType.DIFF_GENERATED, { diffId, path, content });
  }

  /**
   * ResponseEvent operations (Phase 6)
   */
  async sendResponseEvent(event: ResponseEvent): Promise<void> {
    await this.send(MessageType.RESPONSE_EVENT, event);
  }

  async sendResponseCreated(): Promise<void> {
    await this.send(MessageType.RESPONSE_CREATED, {});
  }

  async sendResponseOutputItemDone(item: any): Promise<void> {
    await this.send(MessageType.RESPONSE_OUTPUT_ITEM_DONE, { item });
  }

  async sendResponseCompleted(responseId: string, tokenUsage?: any): Promise<void> {
    await this.send(MessageType.RESPONSE_COMPLETED, { responseId, tokenUsage });
  }

  async sendResponseOutputTextDelta(delta: string): Promise<void> {
    await this.send(MessageType.RESPONSE_OUTPUT_TEXT_DELTA, { delta });
  }

  async sendResponseReasoningSummaryDelta(delta: string): Promise<void> {
    await this.send(MessageType.RESPONSE_REASONING_SUMMARY_DELTA, { delta });
  }

  async sendResponseReasoningContentDelta(delta: string): Promise<void> {
    await this.send(MessageType.RESPONSE_REASONING_CONTENT_DELTA, { delta });
  }

  async sendResponseReasoningSummaryPartAdded(): Promise<void> {
    await this.send(MessageType.RESPONSE_REASONING_SUMMARY_PART_ADDED, {});
  }

  async sendResponseWebSearchCallBegin(callId: string): Promise<void> {
    await this.send(MessageType.RESPONSE_WEB_SEARCH_CALL_BEGIN, { callId });
  }

  async sendResponseRateLimits(snapshot: any): Promise<void> {
    await this.send(MessageType.RESPONSE_RATE_LIMITS, { snapshot });
  }

  /**
   * Broadcast ResponseEvent to all tabs
   */
  async broadcastResponseEvent(event: ResponseEvent): Promise<void> {
    await this.broadcast(MessageType.RESPONSE_EVENT, event);
  }

  /**
   * Helper to convert ResponseEvent to specific message type
   */
  private getMessageTypeForResponseEvent(event: ResponseEvent): MessageType {
    switch (event.type) {
      case 'Created':
        return MessageType.RESPONSE_CREATED;
      case 'OutputItemDone':
        return MessageType.RESPONSE_OUTPUT_ITEM_DONE;
      case 'Completed':
        return MessageType.RESPONSE_COMPLETED;
      case 'OutputTextDelta':
        return MessageType.RESPONSE_OUTPUT_TEXT_DELTA;
      case 'ReasoningSummaryDelta':
        return MessageType.RESPONSE_REASONING_SUMMARY_DELTA;
      case 'ReasoningContentDelta':
        return MessageType.RESPONSE_REASONING_CONTENT_DELTA;
      case 'ReasoningSummaryPartAdded':
        return MessageType.RESPONSE_REASONING_SUMMARY_PART_ADDED;
      case 'WebSearchCallBegin':
        return MessageType.RESPONSE_WEB_SEARCH_CALL_BEGIN;
      case 'RateLimits':
        return MessageType.RESPONSE_RATE_LIMITS;
      default:
        return MessageType.RESPONSE_EVENT;
    }
  }

  /**
   * Send typed ResponseEvent with automatic message type detection
   */
  async sendTypedResponseEvent(event: ResponseEvent): Promise<void> {
    const messageType = this.getMessageTypeForResponseEvent(event);
    await this.send(messageType, event);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Request session reset
   */
  async requestSessionReset(): Promise<void> {
    return this.send(MessageType.SESSION_RESET);
  }

  /**
   * Clean up pending requests
   */
  cleanup(): void {
    // Reject all pending requests
    for (const [id, request] of this.pendingRequests) {
      request.reject(new Error('Router cleanup'));
    }
    this.pendingRequests.clear();

    // Clear handlers
    this.handlers.clear();
  }
}

/**
 * Message handler type
 */
type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
) => Promise<any> | any;

/**
 * Pending request tracker
 */
interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * Create router for current context
 */
export function createRouter(): MessageRouter {
  // Determine source based on context
  let source: ExtensionMessage['source'] = 'background';

  if (typeof chrome !== 'undefined') {
    if (chrome.sidePanel) {
      source = 'sidepanel';
    } else if (typeof window !== 'undefined' && window.location?.protocol === 'chrome-extension:') {
      // Could be popup or background
      if (typeof document !== 'undefined' && document.querySelector('body')) {
        source = 'popup';
      }
    } else if (typeof window !== 'undefined') {
      source = 'content';
    }
    // If window is not defined, we're in a service worker, so keep 'background'
  }

  return new MessageRouter(source);
}
