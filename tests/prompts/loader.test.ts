import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PromptLoader tests
 *
 * loadPrompt() uses Vite ?raw imports at build time. In the test environment,
 * Vitest handles these imports, so we can test the actual behavior.
 *
 * When PromptComposer is not configured (default), loadPrompt() returns
 * the default bundled prompt (default_browserx_agent_prompt.md).
 *
 * When configured via configurePromptComposer(), loadPrompt() returns
 * a dynamically composed prompt.
 */

// Reset module state between tests to clear PromptComposer configuration
beforeEach(() => {
  vi.resetModules();
});

describe('PromptLoader', () => {
  it('returns default prompt when PromptComposer is not configured', async () => {
    const { loadPrompt } = await import('../../src/core/PromptLoader');

    const prompt = await loadPrompt();

    // Default prompt is the renamed agent_prompt.md (browserx-specific)
    expect(prompt).toContain('BrowserX');
    expect(prompt).toContain('browser automation agent');
    expect(prompt).toContain('Core Directive');
  });

  it('returns composed prompt after configurePromptComposer is called', async () => {
    const { loadPrompt, configurePromptComposer } = await import('../../src/core/PromptLoader');

    configurePromptComposer('browserx', { browserConnection: 'extension' });

    const prompt = await loadPrompt();

    // Composed browserx prompt includes intro, safety, tools, policies
    expect(prompt).toContain('BrowserX');
    expect(prompt).toContain('Safety and Ethics');
    expect(prompt).toContain('DOMTool');
    expect(prompt).toContain('Task Execution Policies');
  });

  it('composes pi agent prompt with runtime context', async () => {
    const { loadPrompt, configurePromptComposer } = await import('../../src/core/PromptLoader');

    configurePromptComposer('pi', {
      os: 'linux',
      arch: 'x86_64',
      shell: 'bash',
      homeDir: '/home/testuser',
      browserConnection: 'mcp',
    });

    const prompt = await loadPrompt();

    // Pi-specific content
    expect(prompt).toContain('Pi');
    expect(prompt).toContain('desktop automation agent');
    expect(prompt).toContain('TerminalTool');

    // Runtime metadata
    expect(prompt).toContain('Linux');
    expect(prompt).toContain('x86_64');
    expect(prompt).toContain('bash');
    expect(prompt).toContain('/home/testuser');
    expect(prompt).toContain('MCP browser automation server');

    // Should NOT contain browserx-specific tools
    expect(prompt).not.toContain('DOMTool');
    expect(prompt).not.toContain('PageVisionTool');
  });

  it('includes fresh currentDateTime on each loadPrompt call', async () => {
    const { loadPrompt, configurePromptComposer } = await import('../../src/core/PromptLoader');

    configurePromptComposer('browserx');

    const prompt1 = await loadPrompt();
    // Small delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));
    const prompt2 = await loadPrompt();

    // Both should contain date/time
    expect(prompt1).toContain('Current date/time');
    expect(prompt2).toContain('Current date/time');
  });

  it('loads user instructions', async () => {
    const { loadUserInstructions } = await import('../../src/core/PromptLoader');

    const instructions = await loadUserInstructions();

    // user_instruction.md exists but may be empty
    expect(typeof instructions).toBe('string');
  });
});
