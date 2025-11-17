/**
 * Chrome extension background service worker
 * Central coordinator for the Browserx agent
 */

import { BrowserxAgent } from '../core/BrowserxAgent';
import { MessageRouter, MessageType } from '../core/MessageRouter';
import type { Submission } from '../protocol/types';
import { validateSubmission } from '../protocol/schemas';
import { CacheManager } from '../storage/CacheManager';
import { StorageQuotaManager } from '../storage/StorageQuotaManager';
import { RolloutRecorder } from '../storage/rollout';
import { AgentConfig } from '../config/AgentConfig';
import { TabManager } from '../core/TabManager';

// Global instances
let agent: BrowserxAgent | null = null;
let router: MessageRouter | null = null;
let cacheManager: CacheManager | null = null;
let storageQuotaManager: StorageQuotaManager | null = null;
let agentConfig: AgentConfig | null = null;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Initialize the service worker
 */
async function initialize(): Promise<void> {
  // If already initialized, return immediately
  if (isInitialized) {
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  initializationPromise = doInitialize();

  try {
    await initializationPromise;
    isInitialized = true;
  } finally {
    initializationPromise = null;
  }
}

/**
 * Actual initialization logic
 */
async function doInitialize(): Promise<void> {
  // Initialize TabManager at service worker level (before agent)
  const tabManager = TabManager.getInstance();
  await tabManager.initialize();

  // Initialize configuration singleton first
  agentConfig = await AgentConfig.getInstance();

  // Create message router (must be created before agent)
  router = new MessageRouter('background');

  // Create agent instance with config and router (agent will initialize ModelClientFactory and ToolRegistry)
  agent = new BrowserxAgent(agentConfig!, router);
  await agent.initialize();

  // Setup message handlers
  setupMessageHandlers();

  // Setup Chrome event listeners
  setupChromeListeners();

  // Setup periodic tasks
  setupPeriodicTasks();

  // Initialize storage layer
  await initializeStorage();
}

/**
 * Setup message handlers
 */
function setupMessageHandlers(): void {
  console.log('[ServiceWorker] $$$ setupMessageHandlers() called');
  if (!router || !agent) {
    console.log('[ServiceWorker] $$$ setupMessageHandlers() aborted - router or agent not ready');
    return;
  }
  
  // Handle submissions from UI
  router.on(MessageType.SUBMISSION, async (message) => {
    const submission = message.payload as Submission;


    if (!validateSubmission(submission)) {
      return;
    }

    const session = agent!.getSession();
    const currentSessionTabId = session.getTabId();

    try {
      // Pass the submission context to the agent
      // The agent will handle tab binding/creation based on context.tabId
      const id = await agent!.submitOperation(submission.op, submission.context);

      const sessionTabIdAfter = session.getTabId();


      return { submissionId: id };
    } catch (error) {
      throw error;
    }
  });
  
  // Handle state queries
  router.on(MessageType.GET_STATE, async () => {
    if (!agent) return null;

    const session = agent.getSession();
    const sessionId = session.getId();

    // Get current tab binding for this session
    const tabManager = TabManager.getInstance();
    const tabId = tabManager.getTabForSession(sessionId);

    return {
      sessionId: session.conversationId,
      isActiveTurn: session.isActiveTurn(), // Include active turn status
      tabId: tabId, // US3: Include current tab binding
    };
  });
  
  // Handle ping/pong for connection testing
  router.on(MessageType.PING, async (message, sender) => {
    const senderInfo = sender.tab?.id
      ? `tab ${sender.tab.id}`
      : `${message.source || 'unknown'} (url: ${sender.url || 'no url'})`;
    console.log('[ServiceWorker] $$$ Received PING from:', senderInfo);

    // When content script pings, try to send a test message back via tabs API
    if (sender.tab?.id && router) {
      setTimeout(async () => {
        console.log('[ServiceWorker] $$$ Attempting test broadcast to tab', sender.tab!.id);
        try {
          await chrome.tabs.sendMessage(sender.tab!.id, {
            type: 'TEST_BROADCAST',
            payload: { test: 'direct message from background' }
          });
          console.log('[ServiceWorker] $$$ Test broadcast successful');
        } catch (error) {
          console.error('[ServiceWorker] $$$ Test broadcast failed:', error);
        }
      }, 1000);
    }

    return { type: MessageType.PONG, timestamp: Date.now() };
  });

  // Handle health check - validates agent is ready with API key
  router.on(MessageType.HEALTH_CHECK, async () => {
    if (!agent) {
      return {
        type: MessageType.HEALTH_STATUS,
        ready: false,
        message: 'Agent not initialized',
        timestamp: Date.now(),
      };
    }

    const status = await agent.isReady();
    return {
      type: MessageType.HEALTH_STATUS,
      ...status,
      timestamp: Date.now(),
    };
  });

  // Test handler to verify content script communication
  router.on(MessageType.TEST_CONTENT_SCRIPT, async () => {
    console.log('[ServiceWorker] $$$ TEST_CONTENT_SCRIPT requested - broadcasting to all tabs');

    try {
      const tabs = await chrome.tabs.query({});
      const results = [];

      for (const tab of tabs) {
        if (tab.id) {
          console.log('[ServiceWorker] $$$ Sending TEST_CONTENT_SCRIPT to tab', tab.id);
          try {
            const response = await chrome.tabs.sendMessage(tab.id, {
              type: 'TEST_CONTENT_SCRIPT'
            });
            console.log('[ServiceWorker] $$$ Tab', tab.id, 'responded:', response);
            results.push({ tabId: tab.id, success: true, response });
          } catch (error) {
            console.log('[ServiceWorker] $$$ Tab', tab.id, 'failed:', error.message);
            results.push({ tabId: tab.id, success: false, error: error.message });
          }
        }
      }

      return {
        success: true,
        message: `Tested ${results.length} tabs`,
        results
      };
    } catch (error) {
      console.error('[ServiceWorker] $$$ TEST_CONTENT_SCRIPT failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Handle session reset
  router.on(MessageType.SESSION_RESET, async () => {
    if (agent) {
      // Get the current session
      const session = agent.getSession();
      const sessionId = session.getId();

      // Abort all running tasks before resetting
      await session.abortAllTasks('UserInterrupt');

      // Unbind session from TabManager before reset
      const tabManager = TabManager.getInstance();
      await tabManager.unbindSession(sessionId);

      // Reset the session (this will also reset tabId to -1 in session and turnContext)
      await session.reset();

      return { type: MessageType.SESSION_RESET_COMPLETE, timestamp: Date.now() };
    }
    throw new Error('Agent not initialized');
  });

  // Handle abort task (stop running tasks without resetting session)
  router.on(MessageType.ABORT_TASK, async () => {
    if (agent) {
      // Get the current session
      const session = agent.getSession();

      // Abort all running tasks (but don't reset session/history)
      await session.abortAllTasks('UserInterrupt');

      return { type: MessageType.ABORT_TASK_COMPLETE, timestamp: Date.now() };
    }
    throw new Error('Agent not initialized');
  });

  // Handle events from BrowserxAgent and broadcast to all content scripts
  // T032-T033: Helper function to check if content scripts can be injected on a tab
  function isInjectableTab(tab: chrome.tabs.Tab): boolean {
    if (!tab.url) return false;

    // Filter out restricted URLs where content scripts cannot be injected
    return !tab.url.startsWith('chrome://') &&
           !tab.url.startsWith('chrome-extension://') &&
           !tab.url.startsWith('edge://') &&
           !tab.url.startsWith('about:');
  }

  // BYPASS MessageRouter and listen directly via chrome.runtime.onMessage
  // This ensures we catch ALL EVENT messages regardless of MessageRouter routing
  console.log('[ServiceWorker] Setting up DIRECT chrome.runtime.onMessage listener for EVENT broadcasting');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only handle EVENT type messages
    if (message.type === 'EVENT') {
      // T021: Enhanced logging with $$$ marker
      console.log('[ServiceWorker] $$$ DIRECT listener caught EVENT:', message.payload?.msg?.type);

      // Broadcast to all tabs asynchronously
      (async () => {
        try {
          const tabs = await chrome.tabs.query({});

          // T034: Apply tab filtering to skip restricted pages
          const injectableTabs = tabs.filter(isInjectableTab);
          const restrictedCount = tabs.length - injectableTabs.length;
          // Abort all running tasks
          await session.abortAllTasks('UserInterrupt');

          // T035: Filtered tab count logging
          console.log(`[ServiceWorker] $$$ Broadcasting EVENT to ${injectableTabs.length} tabs (filtered ${restrictedCount} restricted)`);

          for (const tab of injectableTabs) {
            if (tab.id) {
              // T023: Per-tab logging
              console.log('[ServiceWorker] $$$ Attempting broadcast to tab', tab.id);

              chrome.tabs.sendMessage(tab.id, {
                type: 'EVENT',
                payload: message.payload
              }).catch((error) => {
                // T024: Enhanced error logging with tab ID
                console.log('[ServiceWorker] $$$ Tab', tab.id, 'not ready:', error.message);
              });
            }
          }

          // T036: Log skipped restricted tabs
          const restrictedTabs = tabs.filter(tab => !isInjectableTab(tab));
          for (const tab of restrictedTabs) {
            if (tab.id) {
              console.log(`[ServiceWorker] $$$ Skipping tab ${tab.id} - restricted URL: ${tab.url?.substring(0, 50)}...`);
            }
          }

          console.log('[ServiceWorker] $$$ Broadcast complete');
        } catch (error) {
          console.error('[ServiceWorker] $$$ Broadcast failed:', error);
        }
      })();

      // Don't return anything to avoid interfering with other listeners
      return false;
    }

    // Let other messages pass through to MessageRouter
    return false;
  });

  // Handle storage operations
  router.on(MessageType.STORAGE_GET, async (message) => {
    const { key } = message.payload;
    const result = await chrome.storage.local.get(key);
    return result[key];
  });

  router.on(MessageType.STORAGE_SET, async (message) => {
    const { key, value } = message.payload;
    await chrome.storage.local.set({ [key]: value });
    return { success: true };
  });

  // Handle tool execution messages
  router.on(MessageType.TOOL_EXECUTE, async (message) => {
    if (!agent) throw new Error('Agent not initialized');

    const { toolName, args } = message.payload;
    const toolRegistry = agent.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // For now, just return a placeholder result
    return { success: true, message: `Tool ${toolName} executed` };
  });

  // Handle approval requests
  router.on(MessageType.APPROVAL_REQUEST, async (message) => {
    if (!agent) throw new Error('Agent not initialized');

    const { approvalId, type, details } = message.payload;
    const approvalManager = agent.getApprovalManager();

    // For now, just return a placeholder approval response
    return { approved: false, message: 'Approval system not fully integrated yet' };
  });

  // Handle configuration updates
  router.on(MessageType.CONFIG_UPDATE, async () => {
    try {
      // Reload AgentConfig from storage
      if (agentConfig) {
        await agentConfig.reload();
      } else {
        // Initialize a new configuration singleton
        agentConfig = await AgentConfig.getInstance();
      }

      // Recreate BrowserxAgent with updated configuration
      if (agent) {
        // Clean up old agent
        const session = agent.getSession();
        await session.close();
        await agent.cleanup();
      }

      // Create new agent with updated config
      agent = new BrowserxAgent(agentConfig, router!);
      await agent.initialize();

      // Notify all clients (sidepanel, etc.) that agent was reinitialized
      chrome.runtime.sendMessage({
        type: MessageType.AGENT_REINITIALIZED,
        payload: {
          timestamp: Date.now()
        }
      }).catch(() => {
        // Ignore errors if no listeners (e.g., sidepanel not open)
      });

      return { success: true, message: 'Configuration reloaded and agent recreated' };
    } catch (error) {
      console.error('Failed to reload configuration:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Handle diff events
  router.on(MessageType.DIFF_GENERATED, async (message) => {
    if (!agent) throw new Error('Agent not initialized');

    const { diffId, path, content } = message.payload;
    const diffTracker = agent.getDiffTracker();

    // Broadcast diff to UI
    if (router) {
      await router.broadcast(MessageType.DIFF_GENERATED, message.payload);
    }
  });
  
  // Handle tab commands
  router.on(MessageType.TAB_COMMAND, async (message) => {
    const { command, args } = message.payload;
    const tabId = message.tabId;

    if (!tabId) {
      throw new Error('Tab ID required for tab command');
    }

    return executeTabCommand(tabId, command, args);
  });

  // NOTE: PageAction execution logic removed from here.
  // All PageAction tool execution now flows through:
  // TurnManager.executeBrowserTool() → ToolRegistry.execute() → PageActionTool.executeImpl()
  // See src/core/TurnManager.ts:774-822 for the execution entry point.
}

/**
 * Setup Chrome API event listeners
 */
function setupChromeListeners(): void {
  // Handle extension installation
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      // Open welcome page on first install
      chrome.tabs.create({
        url: chrome.runtime.getURL('welcome.html'),
      });
    }
    
    // Setup context menus
    setupContextMenus();
  });
  
  // Handle side panel opening
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  
  // Handle commands (keyboard shortcuts)
  chrome.commands.onCommand.addListener((command) => {
    handleCommand(command);
  });
  
  // Handle context menu clicks
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab);
  });
}

/**
 * Setup context menus
 */
function setupContextMenus(): void {
  chrome.contextMenus.create({
    id: 'browserx-explain',
    title: 'Explain with Browserx',
    contexts: ['selection'],
  });
  
  chrome.contextMenus.create({
    id: 'browserx-improve',
    title: 'Improve with Browserx',
    contexts: ['selection'],
  });
  
  chrome.contextMenus.create({
    id: 'browserx-extract',
    title: 'Extract data with Browserx',
    contexts: ['page', 'frame'],
  });
}

/**
 * Handle keyboard commands
 */
function handleCommand(command: string): void {
  switch (command) {
    case 'toggle-sidepanel':
      // Toggle side panel
      chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      break;
      
    case 'quick-action':
      // Trigger quick action on current tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          executeQuickAction(tabs[0].id);
        }
      });
      break;
  }
}

/**
 * Handle context menu clicks
 */
async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  if (!tab?.id || !agent) return;
  
  const submission: Partial<Submission> = {
    id: `ctx_${Date.now()}`,
    op: {
      type: 'UserInput',
      items: [],
    },
  };
  
  switch (info.menuItemId) {
    case 'browserx-explain':
      if (info.selectionText) {
        submission.op = {
          type: 'UserInput',
          items: [
            {
              type: 'text',
              text: `Explain this: ${info.selectionText}`,
            },
          ],
        };
      }
      break;
      
    case 'browserx-improve':
      if (info.selectionText) {
        submission.op = {
          type: 'UserInput',
          items: [
            {
              type: 'text',
              text: `Improve this text: ${info.selectionText}`,
            },
          ],
        };
      }
      break;
      
    case 'browserx-extract':
      submission.op = {
        type: 'UserInput',
        items: [
          {
            type: 'text',
            text: `Extract structured data from this page`,
          },
          {
            type: 'context',
            path: info.pageUrl,
          },
        ],
      };
      break;
  }
  
  // Submit to agent
  if (submission.op) {
    await agent.submitOperation(submission.op);
    
    // Open side panel to show results
    chrome.sidePanel.open({ tabId: tab.id });
  }
}

/**
 * Execute tab command
 */
async function executeTabCommand(
  tabId: number,
  command: string,
  args?: any
): Promise<any> {
  switch (command) {
    case 'evaluate':
      return chrome.scripting.executeScript({
        target: { tabId },
        func: (code: string) => eval(code),
        args: [args.code],
      });
      
    case 'screenshot':
      return chrome.tabs.captureVisibleTab({ format: 'png' });
      
    case 'get-html':
      return chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.documentElement.outerHTML,
      });
      
    case 'get-text':
      return chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body.innerText,
      });
      
    case 'navigate':
      return chrome.tabs.update(tabId, { url: args.url });
      
    case 'reload':
      return chrome.tabs.reload(tabId);
      
    case 'close':
      return chrome.tabs.remove(tabId);
      
    default:
      throw new Error(`Unknown tab command: ${command}`);
  }
}

/**
 * Initialize storage layer
 */
async function initializeStorage(): Promise<void> {
  // Initialize cache manager
  cacheManager = new CacheManager({
    maxSize: 50 * 1024 * 1024, // 50MB
    defaultTTL: 3600000, // 1 hour
    evictionPolicy: 'lru'
  });

  // Initialize storage quota manager
  storageQuotaManager = new StorageQuotaManager(cacheManager);
  await storageQuotaManager.initialize();

  // Check storage quota
  const quota = await storageQuotaManager.getQuota();

  // Request persistent storage if not already granted
  if (!quota.persistent) {
    await storageQuotaManager.requestPersistentStorage();
  }
}

/**
 * Execute quick action on tab
 */
async function executeQuickAction(tabId: number): Promise<void> {
  // Get current page context
  const tab = await chrome.tabs.get(tabId);

  if (!agent) return;

  // Submit quick analysis request
  await agent.submitOperation({
    type: 'UserInput',
    items: [
      {
        type: 'text',
        text: 'Analyze this page and provide key insights',
      },
      {
        type: 'context',
        path: tab.url,
      },
    ],
  });

  // Open side panel
  chrome.sidePanel.open({ tabId });
}

/**
 * Setup periodic tasks
 */
function setupPeriodicTasks(): void {
  console.log('[ServiceWorker] setupPeriodicTasks() called');
  // NOTE: Keep-alive mechanism intentionally NOT implemented here
  // The service worker will be woken up on-demand when messages arrive
  // UI (App.svelte) handles retries with exponential backoff if service worker is asleep
  // See App.svelte lines 54-87 for wake-up retry logic
  // TODO: Implement sophisticated keep-alive mechanism in the future

  // Process event queue periodically
  setInterval(async () => {
    if (!agent || !router) return;

    // Get next event from agent
    const event = await agent.getNextEvent();
    if (event) {
      // Broadcast event to all connected clients
      await router.broadcast(MessageType.EVENT, event);
    }
  }, 100); // Check every 100ms

  // Cleanup old data and manage storage periodically
  // Wrap in try-catch to handle any chrome API issues
  try {
    // Check if chrome.alarms API is available
    if (typeof chrome !== 'undefined' && chrome?.alarms?.create) {
    chrome.alarms.create('rollout-cleanup', { periodInMinutes: 60 });
    chrome.alarms.create('cache-cleanup', { periodInMinutes: 30 });
    chrome.alarms.create('quota-check', { periodInMinutes: 10 });

    // Handle alarms
    chrome.alarms.onAlarm?.addListener(async (alarm) => {
      switch (alarm.name) {
        case 'rollout-cleanup':
          await performRolloutCleanup();
          break;
        case 'cache-cleanup':
          if (cacheManager) {
            await cacheManager.cleanup();
          }
          break;
        case 'quota-check':
          if (storageQuotaManager) {
            const shouldCleanup = await storageQuotaManager.shouldCleanup();
            if (shouldCleanup) {
              await storageQuotaManager.cleanup(70);
            }
          }
          break;
      }
    });
  } else {
    console.warn('chrome.alarms API not available, periodic cleanup disabled');
    // Fallback: Use setInterval for cleanup tasks if alarms API is not available
    setInterval(async () => {
      await performRolloutCleanup();
    }, 60 * 60 * 1000); // Every hour

    setInterval(async () => {
      if (cacheManager) {
        await cacheManager.cleanup();
      }
    }, 30 * 60 * 1000); // Every 30 minutes

    setInterval(async () => {
      if (storageQuotaManager) {
        const shouldCleanup = await storageQuotaManager.shouldCleanup();
        if (shouldCleanup) {
          await storageQuotaManager.cleanup(70);
        }
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }
  } catch (error) {
    console.error('Failed to setup Chrome alarms:', error);
    console.warn('Falling back to setInterval for periodic cleanup');

    // Fallback: Use setInterval for cleanup tasks if alarms API fails
    setInterval(async () => {
      await performRolloutCleanup();
    }, 60 * 60 * 1000); // Every hour

    setInterval(async () => {
      if (cacheManager) {
        await cacheManager.cleanup();
      }
    }, 30 * 60 * 1000); // Every 30 minutes

    setInterval(async () => {
      if (storageQuotaManager) {
        const shouldCleanup = await storageQuotaManager.shouldCleanup();
        if (shouldCleanup) {
          await storageQuotaManager.cleanup(70);
        }
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }
}

/**
 * Perform rollout cleanup
 */
async function performRolloutCleanup(): Promise<void> {
  try {
    await RolloutRecorder.cleanupExpired();
  } catch (error) {
    console.error('[RolloutCleanup] Failed to cleanup expired rollouts:', error);
  }

  // Also clean up temporary chrome.storage items
  const storage = await chrome.storage.local.get(null);
  const now = Date.now();
  const keysToRemove: string[] = [];

  // Remove old temporary data (older than 24 hours)
  for (const key in storage) {
    if (key.startsWith('temp_')) {
      const data = storage[key];
      if (data.timestamp && now - data.timestamp > 24 * 60 * 60 * 1000) {
        keysToRemove.push(key);
      }
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

/**
 * Handle service worker activation
 */
chrome.runtime.onStartup.addListener(() => {
  initialize();
});

/**
 * Handle service worker installation
 */
chrome.runtime.onInstalled.addListener(async () => {
  // Continue with normal initialization
  initialize();
});

/**
 * Handle service worker shutdown
 */
chrome.runtime.onSuspend.addListener(async () => {
  // Cleanup resources
  if (agent) {
    const session = agent.getSession();
    await session.close();
    await agent.cleanup();
  }

  if (router) {
    router.cleanup();
  }

  if (cacheManager) {
    cacheManager.destroy();
  }

  if (storageQuotaManager) {
    storageQuotaManager.destroy();
  }

  // Reset initialization flag so it can be re-initialized if the service worker restarts
  isInitialized = false;
  initializationPromise = null;
});

// ============================================================================
// ON-DEMAND SERVICE WORKER WAKE-UP STRATEGY
// ============================================================================
// Chrome terminates service workers after 30 seconds of inactivity.
// Instead of keeping the service worker alive with alarms, we use on-demand wake-up:
//
// 1. Service Worker: Auto-initializes when ANY message arrives (see below)
// 2. UI (App.svelte): Retries with exponential backoff if worker is asleep
//    - Initial retry: 200ms, then 400ms, 800ms, 1600ms, 3200ms
//    - Max retries: 8 attempts
//    - Detects "port closed" errors and shows helpful messages
//
// Benefits:
// - Simpler implementation (no keep-alive alarms)
// - Better battery life (worker sleeps when not needed)
// - Graceful degradation (UI handles wake-up transparently)
//
// Trade-offs:
// - First message after sleep takes longer (~200-400ms)
// - User sees brief "Service worker starting..." message
//
// Future: Implement sophisticated keep-alive for production use
// ============================================================================

// Ensure initialization happens when messages arrive
// This handles cases where the service worker wakes up from sleep
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Initialize if not already initialized
  if (!isInitialized && !initializationPromise) {
    // Start async initialization and keep port open
    initialize()
      .then(() => {
        console.log('[Service Worker] Initialization complete on message wake-up');
        sendResponse({ success: true, initialized: true });
      })
      .catch(err => {
        console.error('Failed to initialize on message:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message port open for async response
  }
  // If initialization is in progress, wait for it
  if (initializationPromise) {
    initializationPromise
      .then(() => {
        sendResponse({ success: true, initialized: true });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message port open
  }
  // Don't return true - let MessageRouter handle the response
  return false;
});

// Initialize on script load
// Note: MessageRouter's listener (in MessageRouter.ts) is the ONLY chrome.runtime.onMessage listener
// All message handling goes through MessageRouter's handler system (router.on)
initialize();

// Export for testing
export { agent, router, initialize };
