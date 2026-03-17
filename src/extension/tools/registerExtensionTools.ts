/**
 * Extension Tool Registration
 *
 * Registers browser automation tools that require Chrome Extension APIs.
 * Only imported by the extension build — desktop and server builds
 * never touch this file, so chrome.* dependencies are excluded from
 * those bundles at compile time.
 */

import { ToolRegistry } from '../../tools/ToolRegistry';
import type { IToolsConfig } from '../../config/types';
import type { IRiskAssessor } from '../../core/approval/types';

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

    const registerTool = async (toolName: string, toolInstance: any, riskAssessor?: IRiskAssessor) => {
      if (!registry.getTool(toolName)) {
        const definition = toolInstance.getDefinition();
        console.log(`Registering ${toolName}...`);

        await registry.register(definition, async (params, context) => {
          return toolInstance.execute(params, {
            metadata: {
              ...context.metadata,
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

    // Extension-only browser tools
    if (isToolEnabled('web_scraping')) {
      await registerTool('web_scraping', new WebScrapingTool(), staticRiskAssessor);
    }

    if (isToolEnabled('form_automation')) {
      await registerTool('form_automation', new FormAutomationTool(), staticRiskAssessor);
    }

    if (isToolEnabled('network_intercept')) {
      await registerTool('network_intercept', new NetworkInterceptTool(), staticRiskAssessor);
    }

    if (isToolEnabled('data_extraction')) {
      await registerTool('data_extraction', new DataExtractionTool(), staticRiskAssessor);
    }

    if (isToolEnabled('dom_tool')) {
      await registerTool('dom_tool', new DOMTool(), domRiskAssessor);
    }

    if (isToolEnabled('navigation_tool')) {
      await registerTool('navigation_tool', new NavigationTool(), staticRiskAssessor);
    }

    if (isToolEnabled('storage_tool')) {
      await registerTool('storage_tool', new StorageTool(), staticRiskAssessor);
    }

    if (isToolEnabled('page_vision_tool')) {
      if (!modelConfig || modelConfig.supportsImage !== false) {
        await registerTool('page_vision', new PageVisionTool(), staticRiskAssessor);
      } else {
        console.log(`PageVisionTool disabled: Model "${modelConfig.name}" does not support image input`);
      }
    }

    // Cross-platform tools
    try {
      const planningTool = new PlanningTool(getTaskStore());
      await registerTool('planning_tool', planningTool, new StaticRiskAssessor(0));
    } catch (planError) {
      console.error('[registerExtensionTools] Failed to register PlanningTool:', planError);
    }

    const webSearchTool = new WebSearchTool();
    await registerTool('web_search', webSearchTool, new StaticRiskAssessor(0));

    const settingTool = new SettingTool();
    await registerTool('setting_tool', settingTool, new SettingToolRiskAssessor());

    console.log('[registerExtensionTools] Extension tool registration completed');
  } catch (error) {
    console.error('[registerExtensionTools] Failed to register extension tools:', error);
  }
}
