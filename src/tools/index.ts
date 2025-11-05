/**
 * Tool registration and management for browserx-chrome
 */

import { ToolRegistry } from './ToolRegistry';
import type { IToolsConfig } from '../config/types';
import { WebScrapingTool } from './WebScrapingTool';
import { FormAutomationTool } from './FormAutomationTool';
import { NetworkInterceptTool } from './NetworkInterceptTool';
import { DataExtractionTool } from './DataExtractionTool';
import { DOMTool } from './DOMTool';
import { NavigationTool } from './NavigationTool';
import { StorageTool } from './StorageTool';
import { TabTool } from './TabTool';
import { PageVisionTool } from './PageVisionTool';

// Re-export core tools (non-DOM tools for service worker compatibility)
export { ToolRegistry } from './ToolRegistry';
export { BaseTool, createFunctionTool, createObjectSchema, createToolDefinition } from './BaseTool';
export type { ToolDefinition, JsonSchema, ResponsesApiTool, FreeformTool, FreeformToolFormat } from './BaseTool';
export { WebScrapingTool } from './WebScrapingTool';
export { FormAutomationTool } from './FormAutomationTool';
export { NetworkInterceptTool } from './NetworkInterceptTool';
export { DataExtractionTool } from './DataExtractionTool';
export { DOMTool } from './DOMTool';
export { NavigationTool } from './NavigationTool';
export { StorageTool } from './StorageTool';
export { TabTool } from './TabTool';
export { PageVisionTool } from './PageVisionTool';

/**
 * Register browser automation tools based on configuration
 */
export async function registerTools(registry: ToolRegistry, toolsConfig: IToolsConfig): Promise<void> {
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
        case 'tab_tool':
          return toolsConfig.tab_tool === true;
        case 'page_vision_tool':
          return toolsConfig.page_vision_tool === true;
        case 'page_action':
          return toolsConfig.page_action_tool === true;
        default:
          return false;
      }
    };

    // Helper function to register a tool with error handling
    const registerTool = async (toolName: string, toolInstance: any) => {
      if (!registry.getTool(toolName)) {
        const definition = toolInstance.getDefinition();
        console.log(`Registering ${toolName}...`);

        await registry.register(definition, async (params, context) => {
          // Pass context (including sessionId) to tool's execute method via options.metadata
          return toolInstance.execute(params, { metadata: context });
        });
      } else {
        console.log(`${toolName} already registered, skipping...`);
      }
    };

    // Web Scraping Tool
    if (isToolEnabled('web_scraping')) {
      const webScrapingTool = new WebScrapingTool();
      await registerTool('web_scraping', webScrapingTool);
    } else {
      console.log('WebScrapingTool disabled in configuration, skipping...');
    }

    // Form Automation Tool
    if (isToolEnabled('form_automation')) {
      const formAutomationTool = new FormAutomationTool();
      await registerTool('form_automation', formAutomationTool);
    } else {
      console.log('FormAutomationTool disabled in configuration, skipping...');
    }

    // Network Intercept Tool
    if (isToolEnabled('network_intercept')) {
      const networkInterceptTool = new NetworkInterceptTool();
      await registerTool('network_intercept', networkInterceptTool);
    } else {
      console.log('NetworkInterceptTool disabled in configuration, skipping...');
    }

    // Data Extraction Tool
    if (isToolEnabled('data_extraction')) {
      const dataExtractionTool = new DataExtractionTool();
      await registerTool('data_extraction', dataExtractionTool);
    } else {
      console.log('DataExtractionTool disabled in configuration, skipping...');
    }

    // DOM Tool
    if (isToolEnabled('dom_tool')) {
      const domTool = new DOMTool();
      await registerTool('dom_tool', domTool);
    } else {
      console.log('DOMTool disabled in configuration, skipping...');
    }

    // Navigation Tool
    if (isToolEnabled('navigation_tool')) {
      const navigationTool = new NavigationTool();
      await registerTool('navigation_tool', navigationTool);
    } else {
      console.log('NavigationTool disabled in configuration, skipping...');
    }

    // Storage Tool
    if (isToolEnabled('storage_tool')) {
      const storageTool = new StorageTool();
      await registerTool('storage_tool', storageTool);
    } else {
      console.log('StorageTool disabled in configuration, skipping...');
    }

    // Tab Tool
    if (isToolEnabled('tab_tool')) {
      const tabTool = new TabTool();
      await registerTool('tab_tool', tabTool);
    } else {
      console.log('TabTool disabled in configuration, skipping...');
    }

    // PageVision Tool
    if (isToolEnabled('page_vision_tool')) {
      const pageVisionTool = new PageVisionTool();
      await registerTool('page_vision', pageVisionTool);
    } else {
      console.log('PageVisionTool disabled in configuration, skipping...');
    }

    // Page Action Tool - REMOVED: Functionality merged into DOMTool v3.0
    // Use DOMTool with action parameter instead

    console.log('Advanced browser tools registration completed');
  } catch (error) {
    console.error('Failed to register advanced tools:', error);
  }
}

/**
 * Initialize all tools
 */
export async function initializeTools(toolsConfig?: IToolsConfig): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  // Only register tools if configuration is provided
  if (toolsConfig) {
    await registerTools(registry, toolsConfig);
  } else {
    console.log('No tools configuration provided, skipping advanced tools registration');
  }

  console.log(`Total tools registered: ${registry.listTools().length}`);
  return registry;
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
