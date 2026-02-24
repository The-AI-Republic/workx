/**
 * Tool registration and management for pi
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
import { PageVisionTool } from './PageVisionTool';
import { PlanningTool } from './PlanningTool';
import { WebSearchTool } from './WebSearchTool';
import { SettingTool } from './SettingTool';
import { DomToolRiskAssessor } from '../core/approval/assessors/DomToolRiskAssessor';
import { StaticRiskAssessor } from '../core/approval/assessors/StaticRiskAssessor';
import { SettingToolRiskAssessor } from '../core/approval/assessors/SettingToolRiskAssessor';
import type { IRiskAssessor } from '../core/approval/types';

// Re-export core tools (non-DOM tools for service worker compatibility)
export { ToolRegistry } from './ToolRegistry';
export { BaseTool, createFunctionTool, createObjectSchema, createToolDefinition } from './BaseTool';
export type { ToolDefinition, JsonSchema, ResponsesApiTool, FreeformTool, FreeformToolFormat, ToolMetadata, Platform } from './BaseTool';
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

    // Helper function to register a tool with error handling
    const registerTool = async (toolName: string, toolInstance: any, riskAssessor?: IRiskAssessor) => {
      if (!registry.getTool(toolName)) {
        const definition = toolInstance.getDefinition();
        console.log(`Registering ${toolName}...`);

        await registry.register(definition, async (params, context) => {
          // Flatten context: pass metadata directly, with sessionId/turnId/toolName alongside
          return toolInstance.execute(params, {
            metadata: {
              ...context.metadata,  // tabId and other metadata fields
              sessionId: context.sessionId,
              turnId: context.turnId,
              toolName: context.toolName,
            }
          });
        }, riskAssessor);
      } else {
        console.log(`${toolName} already registered, skipping...`);
      }
    };

    // Web Scraping Tool
    if (isToolEnabled('web_scraping')) {
      const webScrapingTool = new WebScrapingTool();
      await registerTool('web_scraping', webScrapingTool, staticRiskAssessor);
    } else {
      console.log('WebScrapingTool disabled in configuration, skipping...');
    }

    // Form Automation Tool
    if (isToolEnabled('form_automation')) {
      const formAutomationTool = new FormAutomationTool();
      await registerTool('form_automation', formAutomationTool, staticRiskAssessor);
    } else {
      console.log('FormAutomationTool disabled in configuration, skipping...');
    }

    // Network Intercept Tool
    if (isToolEnabled('network_intercept')) {
      const networkInterceptTool = new NetworkInterceptTool();
      await registerTool('network_intercept', networkInterceptTool, staticRiskAssessor);
    } else {
      console.log('NetworkInterceptTool disabled in configuration, skipping...');
    }

    // Data Extraction Tool
    if (isToolEnabled('data_extraction')) {
      const dataExtractionTool = new DataExtractionTool();
      await registerTool('data_extraction', dataExtractionTool, staticRiskAssessor);
    } else {
      console.log('DataExtractionTool disabled in configuration, skipping...');
    }

    // DOM Tool
    if (isToolEnabled('dom_tool')) {
      const domTool = new DOMTool();
      await registerTool('dom_tool', domTool, domRiskAssessor);
    } else {
      console.log('DOMTool disabled in configuration, skipping...');
    }

    // Navigation Tool
    if (isToolEnabled('navigation_tool')) {
      const navigationTool = new NavigationTool();
      await registerTool('navigation_tool', navigationTool, staticRiskAssessor);
    } else {
      console.log('NavigationTool disabled in configuration, skipping...');
    }

    // Storage Tool
    if (isToolEnabled('storage_tool')) {
      const storageTool = new StorageTool();
      await registerTool('storage_tool', storageTool, staticRiskAssessor);
    } else {
      console.log('StorageTool disabled in configuration, skipping...');
    }

    // Tab management is automatic via TabManager (FR-023) - no TabTool needed

    // PageVision Tool - Only register if model supports image input
    if (isToolEnabled('page_vision_tool')) {
      // Check if model supports image input
      if (!modelConfig || modelConfig.supportsImage !== false) {
        const pageVisionTool = new PageVisionTool();
        await registerTool('page_vision', pageVisionTool, staticRiskAssessor);
      } else {
        console.log(`PageVisionTool disabled: Model "${modelConfig.name}" does not support image input`);
      }
    } else {
      console.log('PageVisionTool disabled in configuration, skipping...');
    }

    // Page Action Tool - REMOVED: Functionality merged into DOMTool v3.0
    // Use DOMTool with action parameter instead

    // Planning Tool - Always enabled for task planning and progress tracking
    const planningTool = new PlanningTool();
    await registerTool('planning_tool', planningTool, new StaticRiskAssessor(0));
    console.log('PlanningTool registered (always enabled)');

    // Setting Tool - Always enabled for reading/writing allowlisted settings via chat
    const settingTool = new SettingTool();
    await registerTool('setting_tool', settingTool, new SettingToolRiskAssessor());
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
