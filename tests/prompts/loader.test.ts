import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadPrompt } from '../../src/core/PromptLoader';

// Mock chrome.runtime.getURL
global.chrome = {
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://test-extension/${path}`)
  }
} as any;

// Mock fetch
global.fetch = vi.fn();

describe('Agent Prompt Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads agent prompt successfully', async () => {
    const mockPromptContent = `You are Browserx Web Agent, based on GPT-5. You are running as a browser automation agent in the Browserx Chrome Extension.

## General

- Browser operations are performed through specialized tools (DOMTool, NavigationTool, FormAutomationTool, WebScrapingTool, NetworkInterceptTool, StorageTool)
- Always specify the target tab when performing operations. Do not rely on "current tab" unless explicitly confirmed
- When searching for elements, prefer CSS selectors over XPath for better performance and readability. Use querySelector for single elements and querySelectorAll for multiple elements`;

    // Mock fetch response
    (global.fetch as any).mockResolvedValue({
      text: async () => mockPromptContent
    });

    const prompt = await loadPrompt();

    // Verify chrome.runtime.getURL was called correctly
    expect(chrome.runtime.getURL).toHaveBeenCalledWith('prompts/agent_prompt.md');

    // Verify fetch was called with correct URL
    expect(fetch).toHaveBeenCalledWith('chrome-extension://test-extension/prompts/agent_prompt.md');

    // Verify content assertions
    expect(prompt).toContain('Browserx Web Agent');
    expect(prompt).not.toContain('shell');
    expect(prompt).not.toContain('filesystem');
    expect(prompt).toContain('querySelector');
    expect(prompt).toContain('DOMTool');
    expect(prompt).toContain('NavigationTool');
  });
});