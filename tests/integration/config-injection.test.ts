import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';

// These imports will initially fail because the implementations don't exist yet
import { AgentConfig } from '../../src/config/AgentConfig';
import { BrowserxAgent } from '../../src/core/BrowserxAgent';
import { AgentTask } from '../../src/core/AgentTask';
import { TaskRunner } from '../../src/core/TaskRunner';
import { useAgentConfig } from '../../src/hooks/useAgentConfig';

// Mock Svelte components that will use config
import MockSettingsPanel from '../mocks/MockSettingsPanel.svelte';
import MockTaskDisplay from '../mocks/MockTaskDisplay.svelte';
import MockAgentStatus from '../mocks/MockAgentStatus.svelte';

import type { AgentConfigData } from '../../src/config/types';

// Mock Chrome APIs
const mockChromeStorage = {
  get: vi.fn(),
  set: vi.fn(),
  onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
};

// @ts-ignore
global.chrome = {
  storage: {
    sync: mockChromeStorage,
    local: mockChromeStorage
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() }
  }
};

describe('Config Injection Integration', () => {
  let agentConfig: AgentConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    AgentConfig.resetInstance?.();
    agentConfig = AgentConfig.getInstance();
    await agentConfig.initialize();
  });

  afterEach(() => {
    AgentConfig.resetInstance?.();
  });

  describe('Component Config Injection', () => {
    it('should inject config into Svelte components via context', async () => {
      // Create component that uses config context
      const { container } = render(MockSettingsPanel, {
        props: {
          testConfigInjection: true
        }
      });

      // Component should have access to current configuration
      const modelSelect = container.querySelector('[data-testid="model-select"]');
      expect(modelSelect).toBeTruthy();
      expect(modelSelect?.textContent).toContain('claude-3-5-sonnet-20241022');
    });

    it('should update components when configuration changes', async () => {
      const { container, component } = render(MockSettingsPanel);

      // Initial state
      expect(container.querySelector('[data-testid="current-model"]')?.textContent)
        .toBe('claude-3-5-sonnet-20241022');

      // Update configuration
      await agentConfig.updateConfig({ model: 'claude-3-haiku-20240307' });

      // Component should reflect new configuration
      expect(container.querySelector('[data-testid="current-model"]')?.textContent)
        .toBe('claude-3-haiku-20240307');
    });

    it('should handle config loading states in components', async () => {
      const { container } = render(MockSettingsPanel, {
        props: { showLoadingState: true }
      });

      // Should show loading indicator initially
      expect(container.querySelector('[data-testid="config-loading"]')).toBeTruthy();

      // Wait for config to load
      await new Promise(resolve => setTimeout(resolve, 100));

      // Loading indicator should disappear
      expect(container.querySelector('[data-testid="config-loading"]')).toBeFalsy();
    });

    it('should provide config validation feedback in UI', async () => {
      const { container, component } = render(MockSettingsPanel, {
        props: { enableValidation: true }
      });

      // Simulate invalid model selection
      const modelInput = container.querySelector('[data-testid="model-input"]') as HTMLInputElement;
      if (modelInput) {
        modelInput.value = 'invalid-model';
        modelInput.dispatchEvent(new Event('input'));
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should show validation error
      expect(container.querySelector('[data-testid="validation-error"]')?.textContent)
        .toContain('Invalid model');
    });
  });

  describe('Agent Component Integration', () => {
    it('should inject config into BrowserxAgent components', async () => {
      const browserxAgent = new BrowserxAgent();
      await browserxAgent.initialize();

      const { container } = render(MockAgentStatus, {
        props: { agent: browserxAgent }
      });

      // Component should display agent configuration
      expect(container.querySelector('[data-testid="agent-model"]')?.textContent)
        .toBe('claude-3-5-sonnet-20241022');

      expect(container.querySelector('[data-testid="approval-policy"]')?.textContent)
        .toBe('on-request');
    });

    it('should update agent components when config changes', async () => {
      const browserxAgent = new BrowserxAgent();
      await browserxAgent.initialize();

      // Subscribe agent to config changes
      agentConfig.subscribe((newConfig) => {
        browserxAgent.updateConfig(newConfig);
      });

      const { container } = render(MockAgentStatus, {
        props: { agent: browserxAgent, reactive: true }
      });

      // Update configuration
      await agentConfig.updateConfig({
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      });

      // Component should reflect updated agent config
      expect(container.querySelector('[data-testid="agent-model"]')?.textContent)
        .toBe('claude-3-haiku-20240307');

      expect(container.querySelector('[data-testid="approval-policy"]')?.textContent)
        .toBe('never');
    });

    it('should handle agent status changes based on config', async () => {
      const browserxAgent = new BrowserxAgent();
      await browserxAgent.initialize();

      const { container } = render(MockAgentStatus, {
        props: { agent: browserxAgent, showStatus: true }
      });

      // Initially should show ready status
      expect(container.querySelector('[data-testid="agent-status"]')?.textContent)
        .toBe('ready');

      // Change to restricted sandbox mode
      await agentConfig.updateConfig({
        sandbox_policy: { mode: 'read-only' }
      });

      browserxAgent.updateConfig(agentConfig.getConfig());

      // Status should reflect restricted mode
      expect(container.querySelector('[data-testid="agent-status"]')?.textContent)
        .toContain('restricted');
    });
  });

  describe('Task Component Integration', () => {
    it('should inject config into AgentTask components', async () => {
      const taskConfig: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'untrusted'
      };

      const task = new AgentTask('test-task', taskConfig);

      const { container } = render(MockTaskDisplay, {
        props: { task }
      });

      // Component should display task-specific configuration
      expect(container.querySelector('[data-testid="task-model"]')?.textContent)
        .toBe('claude-3-haiku-20240307');

      expect(container.querySelector('[data-testid="task-approval"]')?.textContent)
        .toBe('untrusted');
    });

    it('should update task components when task config changes', async () => {
      const task = new AgentTask('test-task');

      const { container } = render(MockTaskDisplay, {
        props: { task, reactive: true }
      });

      // Update task configuration
      await task.updateConfig({ model: 'claude-3-opus-20240229' });

      // Component should reflect updated task config
      expect(container.querySelector('[data-testid="task-model"]')?.textContent)
        .toBe('claude-3-opus-20240229');
    });

    it('should handle task execution with injected config', async () => {
      const taskRunner = new TaskRunner();
      await taskRunner.initialize();

      const task = new AgentTask('config-test-task', {
        model: 'claude-3-haiku-20240307',
        sandbox_policy: { mode: 'read-only' }
      });

      const { container } = render(MockTaskDisplay, {
        props: { task, showExecution: true }
      });

      // Start task execution
      const executeButton = container.querySelector('[data-testid="execute-button"]') as HTMLButtonElement;
      executeButton?.click();

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should show execution with configured model
      expect(container.querySelector('[data-testid="execution-model"]')?.textContent)
        .toBe('claude-3-haiku-20240307');
    });
  });

  describe('React Hook Integration', () => {
    it('should provide config through useAgentConfig hook', async () => {
      // This would test React hook if we had React components
      // For now, we'll test the hook logic directly

      const { config, updateConfig, loading, error } = await useAgentConfig();

      expect(loading).toBe(false);
      expect(error).toBeNull();
      expect(config.model).toBe('claude-3-5-sonnet-20241022');

      // Test update functionality
      await updateConfig({ model: 'claude-3-haiku-20240307' });

      const { config: updatedConfig } = await useAgentConfig();
      expect(updatedConfig.model).toBe('claude-3-haiku-20240307');
    });

    it('should handle hook error states', async () => {
      // Mock config failure
      vi.spyOn(agentConfig, 'updateConfig').mockRejectedValue(new Error('Config update failed'));

      const { updateConfig, error } = await useAgentConfig();

      await updateConfig({ model: 'invalid-model' });

      expect(error).toBeTruthy();
      expect(error?.message).toBe('Config update failed');
    });

    it('should provide loading states in hook', async () => {
      // Mock slow config loading
      vi.spyOn(agentConfig, 'initialize').mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 200))
      );

      const { loading } = await useAgentConfig();

      expect(loading).toBe(true);

      // Wait for loading to complete
      await new Promise(resolve => setTimeout(resolve, 250));

      const { loading: updatedLoading } = await useAgentConfig();
      expect(updatedLoading).toBe(false);
    });
  });

  describe('Profile Integration with Components', () => {
    it('should update components when switching profiles', async () => {
      // Create development profile
      await agentConfig.createProfile('development', {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      });

      const { container } = render(MockSettingsPanel, {
        props: { showProfileSelector: true }
      });

      // Switch to development profile
      const profileSelect = container.querySelector('[data-testid="profile-select"]') as HTMLSelectElement;
      if (profileSelect) {
        profileSelect.value = 'development';
        profileSelect.dispatchEvent(new Event('change'));
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      // Components should reflect development profile config
      expect(container.querySelector('[data-testid="current-model"]')?.textContent)
        .toBe('claude-3-haiku-20240307');

      expect(container.querySelector('[data-testid="current-approval"]')?.textContent)
        .toBe('never');
    });

    it('should show profile creation UI', async () => {
      const { container } = render(MockSettingsPanel, {
        props: { showProfileManagement: true }
      });

      // Should show profile creation form
      expect(container.querySelector('[data-testid="create-profile-form"]')).toBeTruthy();

      // Fill out new profile form
      const nameInput = container.querySelector('[data-testid="profile-name-input"]') as HTMLInputElement;
      const modelSelect = container.querySelector('[data-testid="profile-model-select"]') as HTMLSelectElement;

      if (nameInput && modelSelect) {
        nameInput.value = 'production';
        modelSelect.value = 'claude-3-opus-20240229';

        nameInput.dispatchEvent(new Event('input'));
        modelSelect.dispatchEvent(new Event('change'));
      }

      // Submit form
      const createButton = container.querySelector('[data-testid="create-profile-button"]') as HTMLButtonElement;
      createButton?.click();

      await new Promise(resolve => setTimeout(resolve, 50));

      // New profile should appear in selector
      const profileOptions = container.querySelectorAll('[data-testid="profile-option"]');
      const profileNames = Array.from(profileOptions).map(option => option.textContent);
      expect(profileNames).toContain('production');
    });
  });

  describe('Error Handling in Components', () => {
    it('should display config errors in UI', async () => {
      const { container } = render(MockSettingsPanel, {
        props: { showErrors: true }
      });

      // Trigger configuration error
      try {
        await agentConfig.updateConfig({ model: 'invalid-model' } as any);
      } catch (error) {
        // Expected
      }

      // Component should show error message
      expect(container.querySelector('[data-testid="config-error"]')?.textContent)
        .toContain('Invalid model');
    });

    it('should recover from component injection failures', async () => {
      // Mock config injection failure
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(agentConfig, 'getConfig').mockImplementation(() => {
        throw new Error('Config access failed');
      });

      const { container } = render(MockSettingsPanel, {
        props: { handleErrors: true }
      });

      // Should show fallback UI instead of crashing
      expect(container.querySelector('[data-testid="fallback-ui"]')).toBeTruthy();

      consoleSpy.mockRestore();
    });

    it('should handle component unmounting during config updates', async () => {
      const { container, unmount } = render(MockSettingsPanel);

      // Start config update
      const updatePromise = agentConfig.updateConfig({ model: 'claude-3-haiku-20240307' });

      // Unmount component before update completes
      unmount();

      // Update should complete without errors
      await expect(updatePromise).resolves.not.toThrow();
    });
  });
});