/**
 * Extension Tool Registration
 *
 * Registers browser automation tools that require Chrome Extension APIs.
 * Only imported by the extension build — desktop and server builds
 * never touch this file, so chrome.* dependencies are excluded from
 * those bundles at compile time.
 */

import { ToolRegistry, type ToolRegistrationOptions } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { IRiskAssessor } from '../../core/approval/types';
import type { BaseTool } from '../../tools/BaseTool';

// Extension-only tools
import { WebScrapingTool } from './WebScrapingTool';
import { FormAutomationTool } from './FormAutomationTool';
import { NetworkInterceptTool } from './NetworkInterceptTool';
import { DataExtractionTool } from './DataExtractionTool';
import { DOMTool } from './DOMTool';
import { NavigationTool } from './NavigationTool';
import { StorageTool } from './StorageTool';
import { PageVisionTool } from './PageVisionTool';

// Cross-platform tools (also used in extension)
import { PlanningTool } from '../../tools/PlanningTool';
import { WebSearchTool } from '../../tools/WebSearchTool';
import { SettingTool } from '../../tools/SettingTool';

// Risk assessors
import { DomToolRiskAssessor } from '../../core/approval/assessors/DomToolRiskAssessor';
import { StaticRiskAssessor } from '../../core/approval/assessors/StaticRiskAssessor';
import { SettingToolRiskAssessor } from '../../core/approval/assessors/SettingToolRiskAssessor';

import { getTaskStore } from '../../core/taskmanager';

/**
 * Register all extension tools based on configuration.
 */
export async function registerExtensionTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  try {
    console.log('[registerExtensionTools] Starting extension tool registration...');

    const isToolEnabled = (toolName: string): boolean => {
      if (toolsConfig.enable_all_tools === true) {
        return true;
      }

      switch (toolName) {
        case 'web_scraping':
          return toolsConfig.web_scraping_tool === true;
        case 'form_automation':
          return toolsConfig.form_automation_tool === true;
        case 'network_intercept':
          return toolsConfig.network_intercept_tool === true;
        case 'data_extraction':
          return toolsConfig.data_extraction_tool === true;
        case 'dom_tool':
          return toolsConfig.dom_tool === true;
        case 'navigation_tool':
          return toolsConfig.navigation_tool === true;
        case 'storage_tool':
          return toolsConfig.storage_tool === true;
        case 'page_vision_tool':
          return toolsConfig.page_vision_tool === true;
        case 'page_action':
          return toolsConfig.page_action_tool === true;
        default:
          return false;
      }
    };

    const domRiskAssessor = new DomToolRiskAssessor();
    const staticRiskAssessor = new StaticRiskAssessor();

    /**
     * Register a BaseTool instance.
     *
     * Accepts either a bare IRiskAssessor (legacy shape) or a full
     * ToolRegistrationOptions object carrying runtime metadata
     * (concurrency / ui / result profiles).
     *
     * Threads callId, onProgress, and per-request metadata into
     * tool.execute() so Track 02's progress + concurrency wiring works.
     */
    const registerTool = async (
      toolName: string,
      toolInstance: BaseTool,
      optionsOrAssessor?: IRiskAssessor | ToolRegistrationOptions,
    ) => {
      if (registry.getTool(toolName)) {
        console.log(`${toolName} already registered, skipping...`);
        return;
      }
      const definition = toolInstance.getDefinition();
      console.log(`Registering ${toolName}...`);

      await registry.register(
        definition,
        async (params, context) => {
          return toolInstance.execute(params, {
            metadata: {
              ...context.metadata,
              sessionId: context.sessionId,
              turnId: context.turnId,
              toolName: context.toolName,
            },
            callId: context.callId,
            onProgress: context.onProgress,
          });
        },
        optionsOrAssessor,
      );
    };

    // ── browser_dom (registry key: dom_tool) ────────────────────────────
    if (isToolEnabled('dom_tool')) {
      await registerTool('dom_tool', new DOMTool(), {
        riskAssessor: domRiskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: (input) => input.action === 'snapshot',
            isReadOnly: (input) => input.action === 'snapshot',
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: (input) => {
              switch (input.action) {
                case 'snapshot': return 'Capturing DOM snapshot';
                case 'click': return `Clicking DOM node ${input.node_id ?? ''}`.trim();
                case 'type': return `Typing into DOM node ${input.node_id ?? ''}`.trim();
                case 'keypress': return `Pressing ${input.key ?? ''}`.trim();
                case 'scroll': return `Scrolling DOM node ${input.node_id ?? ''}`.trim();
                default: return null;
              }
            },
          },
          result: { maxResultSizeChars: 100_000 },
        },
      });
    }

    // ── browser_navigation (registry key: navigation_tool) ──────────────
    if (isToolEnabled('navigation_tool')) {
      const READ_NAV_ACTIONS = new Set(['getHistory', 'getCurrentUrl']);
      await registerTool('navigation_tool', new NavigationTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: (input) => READ_NAV_ACTIONS.has(input.action as string),
            isReadOnly: (input) => READ_NAV_ACTIONS.has(input.action as string),
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: (input) => {
              switch (input.action) {
                case 'navigate': return `Navigating to ${input.url ?? ''}`.trim();
                case 'reload': return 'Reloading page';
                case 'goBack': return 'Going back';
                case 'goForward': return 'Going forward';
                case 'stop': return 'Stopping navigation';
                case 'waitForLoad': return 'Waiting for page load';
                case 'getHistory': return 'Getting navigation history';
                case 'getCurrentUrl': return 'Getting current URL';
                default: return null;
              }
            },
          },
          result: { maxResultSizeChars: 10_000 },
        },
      });
    }

    // ── web_scraping ────────────────────────────────────────────────────
    if (isToolEnabled('web_scraping')) {
      await registerTool('web_scraping', new WebScrapingTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            // Active-tab scrape (no url) reads live DOM that a concurrent
            // dom/navigation tool could mutate. With url it creates a new tab.
            // Either way, not concurrency-safe with sibling browser-state calls.
            isConcurrencySafe: () => false,
            isReadOnly: (input) => !input.url,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: () => 'Scraping content from page',
          },
          result: { maxResultSizeChars: 50_000 },
        },
      });
    }

    // ── form_automation ─────────────────────────────────────────────────
    if (isToolEnabled('form_automation')) {
      await registerTool('form_automation', new FormAutomationTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            // Form interactions mutate page state; never safe to parallelize.
            isConcurrencySafe: () => false,
            isReadOnly: () => false,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: () => 'Interacting with form',
          },
          result: { maxResultSizeChars: 20_000 },
        },
      });
    }

    // ── network_intercept ───────────────────────────────────────────────
    if (isToolEnabled('network_intercept')) {
      await registerTool('network_intercept', new NetworkInterceptTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            // Network interception modifies request handlers; sequential only.
            isConcurrencySafe: () => false,
            isReadOnly: () => false,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: () => 'Configuring network interception',
          },
          result: { maxResultSizeChars: 50_000 },
        },
      });
    }

    // ── data_extraction ─────────────────────────────────────────────────
    if (isToolEnabled('data_extraction')) {
      await registerTool('data_extraction', new DataExtractionTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            // Extraction reads live DOM that other browser-state calls could
            // mutate within the same turn; conservatively sequential.
            isConcurrencySafe: () => false,
            isReadOnly: () => true,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: () => 'Extracting structured data',
          },
          result: { maxResultSizeChars: 50_000 },
        },
      });
    }

    // ── storage_tool ────────────────────────────────────────────────────
    if (isToolEnabled('storage_tool')) {
      const READ_STORAGE_ACTIONS = new Set(['read', 'list']);
      await registerTool('storage_tool', new StorageTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: (input) => READ_STORAGE_ACTIONS.has(input.action as string),
            isReadOnly: (input) => READ_STORAGE_ACTIONS.has(input.action as string),
            isDestructive: (input) => input.action === 'delete',
          },
          ui: {
            getActivityDescription: (input) => {
              switch (input.action) {
                case 'read': return 'Reading cache';
                case 'list': return 'Listing cache entries';
                case 'write': return 'Writing to cache';
                case 'update': return 'Updating cache entry';
                case 'delete': return 'Deleting cache entry';
                default: return null;
              }
            },
          },
          // Infinity: cache_storage_tool is the retrieval path for persisted
          // tool results (track 09). Persisting its read responses would create
          // a circular Read → file → Read loop. Other actions (write/update/
          // delete/list) return small confirmation payloads that don't trip
          // the threshold anyway.
          result: { maxResultSizeChars: Number.POSITIVE_INFINITY },
        },
      });
    }

    // ── page_vision ─────────────────────────────────────────────────────
    if (isToolEnabled('page_vision_tool')) {
      if (!modelConfig || modelConfig.supportsImage !== false) {
        await registerTool('page_vision', new PageVisionTool(), {
          riskAssessor: staticRiskAssessor,
          runtime: {
            concurrency: {
              isConcurrencySafe: (input) => input.action === 'screenshot',
              isReadOnly: (input) => input.action === 'screenshot',
              isDestructive: () => false,
            },
            ui: {
              getActivityDescription: (input) => {
                switch (input.action) {
                  case 'screenshot': return 'Capturing screenshot';
                  case 'click': return `Clicking at (${input.x}, ${input.y})`;
                  case 'type': return 'Typing text';
                  case 'scroll': return 'Scrolling page';
                  case 'keypress': return `Pressing ${input.key ?? ''}`.trim();
                  default: return null;
                }
              },
            },
            result: { maxResultSizeChars: 100_000 },
          },
        });
      } else {
        console.log(`PageVisionTool disabled: Model "${modelConfig.name}" does not support image input`);
      }
    }

    // ── planning_tool ───────────────────────────────────────────────────
    try {
      const READ_PLAN_COMMANDS = new Set(['list', 'get', 'get_plan']);
      const planningTool = new PlanningTool(getTaskStore());
      await registerTool('planning_tool', planningTool, {
        riskAssessor: new StaticRiskAssessor(0),
        runtime: {
          concurrency: {
            isConcurrencySafe: (input) => READ_PLAN_COMMANDS.has(input.command as string),
            isReadOnly: (input) => READ_PLAN_COMMANDS.has(input.command as string),
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: (input) => {
              switch (input.command) {
                case 'plan': return 'Creating plan';
                case 'update': return 'Updating plan';
                case 'list': return 'Listing plans';
                case 'get': return 'Getting plan';
                case 'get_plan': return 'Getting plan details';
                default: return null;
              }
            },
          },
          result: { maxResultSizeChars: 10_000 },
        },
      });
    } catch (planError) {
      console.error('[registerExtensionTools] Failed to register PlanningTool:', planError);
    }

    // ── web_search ──────────────────────────────────────────────────────
    // Note: web_search concurrency safety is special-cased in toolOrchestration
    // (always safe — pure external read, no shared browser state).
    await registerTool('web_search', new WebSearchTool(), new StaticRiskAssessor(0));

    // ── setting_tool ────────────────────────────────────────────────────
    const READ_SETTING_ACTIONS = new Set(['get', 'list']);
    await registerTool('setting_tool', new SettingTool(), {
      riskAssessor: new SettingToolRiskAssessor(),
      runtime: {
        concurrency: {
          isConcurrencySafe: (input) => READ_SETTING_ACTIONS.has(input.action as string),
          isReadOnly: (input) => READ_SETTING_ACTIONS.has(input.action as string),
          isDestructive: () => false,
        },
        ui: {
          getActivityDescription: (input) => {
            switch (input.action) {
              case 'get': return 'Reading setting';
              case 'list': return 'Listing settings';
              case 'set': return 'Updating setting';
              case 'reset': return 'Resetting setting';
              default: return null;
            }
          },
        },
        result: { maxResultSizeChars: 10_000 },
      },
    });

    console.log('[registerExtensionTools] Extension tool registration completed');
  } catch (error) {
    console.error('[registerExtensionTools] Failed to register extension tools:', error);
    throw error;
  }
}
