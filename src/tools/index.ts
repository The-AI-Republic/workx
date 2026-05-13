/**
 * Tool registration and management for pi
 */

import { ToolRegistry, type ToolRegistrationOptions } from './ToolRegistry';
import type { IToolsConfig } from '../config/types';
import { WebScrapingTool } from './WebScrapingTool';
import { FormAutomationTool } from './FormAutomationTool';
import { NetworkInterceptTool } from './NetworkInterceptTool';
import { DataExtractionTool } from './DataExtractionTool';
import { DOMTool } from './DOMTool';
import { NavigationTool } from './NavigationTool';
import { StorageTool } from './StorageTool';
import { PageVisionTool } from './PageVisionTool';
import { PlanningTool } from './PlanningTool';
import { WebSearchTool } from './WebSearchTool';
import { getTaskStore } from '../core/taskmanager';
import { SettingTool } from './SettingTool';
import { DomToolRiskAssessor } from '../core/approval/assessors/DomToolRiskAssessor';
import { StaticRiskAssessor } from '../core/approval/assessors/StaticRiskAssessor';
import { SettingToolRiskAssessor } from '../core/approval/assessors/SettingToolRiskAssessor';
import type { BaseTool } from './BaseTool';

// Re-export core tools (non-DOM tools for service worker compatibility)
export { ToolRegistry, type ToolRegistrationOptions } from './ToolRegistry';
export { BaseTool, createFunctionTool, createObjectSchema, createToolDefinition } from './BaseTool';
export type { ToolDefinition, JsonSchema, ResponsesApiTool, FreeformTool, FreeformToolFormat, ToolMetadata, Platform } from './BaseTool';
export type {
  ToolConcurrencyProfile,
  ToolUIProfile,
  ToolResultProfile,
  ToolRuntimeMetadata,
  ToolProgressData,
  ToolProgress,
  ToolProgressCallback,
} from './runtimeMetadata';
export { DEFAULT_TOOL_CONCURRENCY_PROFILE } from './runtimeMetadata';
export { WebScrapingTool } from './WebScrapingTool';
export { FormAutomationTool } from './FormAutomationTool';
export { NetworkInterceptTool } from './NetworkInterceptTool';
export { DataExtractionTool } from './DataExtractionTool';
export { DOMTool } from './DOMTool';
export { NavigationTool } from './NavigationTool';
export { StorageTool } from './StorageTool';
export { PageVisionTool } from './PageVisionTool';
export { PlanningTool } from './PlanningTool';
export { WebSearchTool } from './WebSearchTool';
export { SettingTool } from './SettingTool';

/**
 * Register browser automation tools based on configuration
 * @param registry - Tool registry instance
 * @param toolsConfig - Tool configuration settings
 * @param modelConfig - Optional model configuration for feature filtering (e.g., image support)
 */
export async function registerTools(
  registry: ToolRegistry,
  toolsConfig: IToolsConfig,
  modelConfig?: { name: string; supportsImage?: boolean }
): Promise<void> {
  try {
    console.log('Starting advanced tool registration...');

    // Helper function to check if a tool should be enabled
    const isToolEnabled = (toolName: string): boolean => {
      // Check if enable_all_tools is true
      if (toolsConfig.enable_all_tools === true) {
        return true;
      }

      // Check specific tool configuration
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

    // Risk assessors for extension tools
    const domRiskAssessor = new DomToolRiskAssessor();
    const staticRiskAssessor = new StaticRiskAssessor();

    /**
     * Register a BaseTool instance with runtime metadata.
     * Creates a handler that threads callId, onProgress, and metadata into tool.execute().
     */
    const registerBaseTool = async (
      toolName: string,
      toolInstance: BaseTool,
      opts: ToolRegistrationOptions,
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
        opts,
      );
    };

    // ── browser_dom (registry key: dom_tool) ────────────────────────────
    if (isToolEnabled('dom_tool')) {
      await registerBaseTool('dom_tool', new DOMTool(), {
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
    } else {
      console.log('DOMTool disabled in configuration, skipping...');
    }

    // ── browser_navigation (registry key: navigation_tool) ──────────────
    if (isToolEnabled('navigation_tool')) {
      const READ_NAV_ACTIONS = new Set(['getHistory', 'getCurrentUrl']);
      await registerBaseTool('navigation_tool', new NavigationTool(), {
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
    } else {
      console.log('NavigationTool disabled in configuration, skipping...');
    }

    // ── web_scraping ────────────────────────────────────────────────────
    if (isToolEnabled('web_scraping')) {
      await registerBaseTool('web_scraping', new WebScrapingTool(), {
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
    } else {
      console.log('WebScrapingTool disabled in configuration, skipping...');
    }

    // ── form_automation ─────────────────────────────────────────────────
    if (isToolEnabled('form_automation')) {
      await registerBaseTool('form_automation', new FormAutomationTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: () => false,
            isReadOnly: () => false,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: () => 'Filling form fields',
          },
          result: { maxResultSizeChars: 10_000 },
        },
      });
    } else {
      console.log('FormAutomationTool disabled in configuration, skipping...');
    }

    // ── network_intercept ───────────────────────────────────────────────
    if (isToolEnabled('network_intercept')) {
      await registerBaseTool('network_intercept', new NetworkInterceptTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: () => false, // stateful shared browser rule state
            isReadOnly: () => false,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: () => 'Configuring network intercept',
          },
          result: { maxResultSizeChars: 10_000 },
        },
      });
    } else {
      console.log('NetworkInterceptTool disabled in configuration, skipping...');
    }

    // ── data_extraction ─────────────────────────────────────────────────
    // NOTE: Marked non-safe until the tool is fixed to use bound session tab
    // instead of querying active tab directly (see design doc finding #7).
    if (isToolEnabled('data_extraction')) {
      await registerBaseTool('data_extraction', new DataExtractionTool(), {
        riskAssessor: staticRiskAssessor,
        runtime: {
          concurrency: {
            isConcurrencySafe: () => false, // TODO: mark safe after tab binding fix
            isReadOnly: () => true,
            isDestructive: () => false,
          },
          ui: {
            getActivityDescription: (input) =>
              `Extracting ${input.mode ?? 'structured'} data`,
          },
          result: { maxResultSizeChars: 30_000 },
        },
      });
    } else {
      console.log('DataExtractionTool disabled in configuration, skipping...');
    }

    // ── storage_tool (cache_storage_tool) ───────────────────────────────
    if (isToolEnabled('storage_tool')) {
      const READ_STORAGE_ACTIONS = new Set(['read', 'list']);
      await registerBaseTool('storage_tool', new StorageTool(), {
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
          result: { maxResultSizeChars: 50_000 },
        },
      });
    } else {
      console.log('StorageTool disabled in configuration, skipping...');
    }

    // ── page_vision ─────────────────────────────────────────────────────
    if (isToolEnabled('page_vision_tool')) {
      if (!modelConfig || modelConfig.supportsImage !== false) {
        await registerBaseTool('page_vision', new PageVisionTool(), {
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
            result: { maxResultSizeChars: 50_000 },
          },
        });
      } else {
        console.log(`PageVisionTool disabled: Model "${modelConfig.name}" does not support image input`);
      }
    } else {
      console.log('PageVisionTool disabled in configuration, skipping...');
    }

    // ── planning_tool ───────────────────────────────────────────────────
    try {
      const READ_PLAN_COMMANDS = new Set(['list', 'get', 'get_plan']);
      await registerBaseTool('planning_tool', new PlanningTool(getTaskStore()), {
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
      console.log('PlanningTool registered (always enabled)');
    } catch (planError) {
      console.error('[registerTools] Failed to register PlanningTool (StorageProvider unavailable):', planError);
    }

    // ── setting_tool ────────────────────────────────────────────────────
    const READ_SETTING_ACTIONS = new Set(['get', 'list']);
    await registerBaseTool('setting_tool', new SettingTool(), {
      riskAssessor: new SettingToolRiskAssessor(),
      runtime: {
        concurrency: {
          isConcurrencySafe: (input) => READ_SETTING_ACTIONS.has(input.action as string),
          isReadOnly: (input) => READ_SETTING_ACTIONS.has(input.action as string),
          isDestructive: () => false,
        },
        ui: {
          getActivityDescription: (input) =>
            READ_SETTING_ACTIONS.has(input.action as string) ? 'Reading settings' : 'Updating settings',
        },
        result: { maxResultSizeChars: 10_000 },
      },
    });
    console.log('SettingTool registered (always enabled)');

    console.log('Advanced browser tools registration completed');
  } catch (error) {
    console.error('Failed to register advanced tools:', error);
  }
}

/**
 * Get tool definitions for OpenAI/model format
 */
export function getToolDefinitions(registry: ToolRegistry): any[] {
  return registry.listTools().map((tool: any) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * Execute a tool by name
 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  parameters: any,
  sessionId: string = 'default-session',
  turnId: string = 'default-turn'
): Promise<any> {
  return registry.execute({
    toolName: name,
    parameters: parameters,
    sessionId: sessionId,
    turnId: turnId
  });
}

/**
 * Cleanup all tools
 */
export async function cleanupTools(registry: ToolRegistry): Promise<void> {
  registry.clear();
}
