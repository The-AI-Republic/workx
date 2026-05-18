import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    const { loadPrompt } = await import('@/core/PromptLoader');

    const prompt = await loadPrompt();

    // Default prompt is the renamed agent_prompt.md (browserx-specific)
    expect(prompt).toContain('BrowserX');
    expect(prompt).toContain('browser automation agent');
    expect(prompt).toContain('Core Directive');
  });

  it('returns composed prompt after configurePromptComposer is called', async () => {
    const { loadPrompt, configurePromptComposer } = await import('@/core/PromptLoader');

    configurePromptComposer('browserx', { browserConnection: 'extension' });

    const prompt = await loadPrompt();

    // Composed browserx prompt includes intro, safety, tools, policies
    expect(prompt).toContain('BrowserX');
    expect(prompt).toContain('Safety and Ethics');
    expect(prompt).toContain('System Semantics');
    expect(prompt).toContain('Action Risk and Approval');
    expect(prompt).toContain('Work Loop');
    expect(prompt).toContain('DOMTool');
    expect(prompt).toContain('Communication');
    expect(prompt).not.toContain('Task Execution Policies');
  });

  it('composes pi agent prompt with runtime context', async () => {
    const { loadPrompt, configurePromptComposer } = await import('@/core/PromptLoader');

    configurePromptComposer('applepi', {
      os: 'linux',
      arch: 'x86_64',
      shell: 'bash',
      homeDir: '/home/testuser',
      browserConnection: 'mcp',
    });

    const prompt = await loadPrompt();

    // Apple Pi-specific content
    expect(prompt).toContain('Apple Pi');
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

  it('composes applepi server prompt with server identity', async () => {
    const { loadPrompt, configurePromptComposer } = await import('@/core/PromptLoader');

    configurePromptComposer('applepi-server', {
      os: 'linux',
      shell: 'bash',
      cwd: '/srv/browserx',
      browserConnection: 'mcp',
    });

    const prompt = await loadPrompt();

    expect(prompt).toContain('Apple Pi Server');
    expect(prompt).toContain('headless automation agent');
    expect(prompt).toContain('/srv/browserx');
    expect(prompt).toContain('TerminalTool');
    expect(prompt).not.toContain('DOMTool');
  });

  it('appends registered prompt extensions after the base prompt', async () => {
    const { loadPrompt, configurePromptComposer, registerPromptExtension } = await import('@/core/PromptLoader');

    configurePromptComposer('browserx');
    registerPromptExtension('test-memory', () => 'MEMORY_EXTENSION_MARKER');
    registerPromptExtension('test-skills', () => 'SKILLS_EXTENSION_MARKER');

    const prompt = await loadPrompt();

    expect(prompt.indexOf('MEMORY_EXTENSION_MARKER')).toBeGreaterThan(prompt.indexOf('## Communication'));
    expect(prompt.indexOf('SKILLS_EXTENSION_MARKER')).toBeGreaterThan(prompt.indexOf('MEMORY_EXTENSION_MARKER'));
  });

  it('includes fresh currentDateTime on each loadPrompt call', async () => {
    const { loadPrompt, configurePromptComposer } = await import('@/core/PromptLoader');

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
    const { loadUserInstructions } = await import('@/core/PromptLoader');

    const instructions = await loadUserInstructions();

    // user_instruction.md exists but may be empty
    expect(typeof instructions).toBe('string');
  });

  it('combines user instructions with CLAUDE.md project instructions', async () => {
    const { combineUserAndProjectInstructions } = await import('@/core/PromptLoader');

    expect(combineUserAndProjectInstructions('User rules', '# CLAUDE.md instructions\nProject rules'))
      .toBe('User rules\n\n# CLAUDE.md instructions\nProject rules');
    expect(combineUserAndProjectInstructions('', '# CLAUDE.md instructions\nProject rules'))
      .toBe('# CLAUDE.md instructions\nProject rules');
  });

  it('falls back to default prompt when composeMainInstruction throws', async () => {
    const { loadPrompt, configurePromptComposer } = await import('@/core/PromptLoader');
    const PromptComposerModule = await import('@/prompts/PromptComposer');

    // Configure the composer, then sabotage its method to throw
    configurePromptComposer('browserx');
    vi.spyOn(PromptComposerModule.PromptComposer.prototype, 'composeMainInstruction')
      .mockImplementation(() => { throw new Error('fragment import failed'); });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const prompt = await loadPrompt();

    // Should fall back to default browserx prompt
    expect(prompt).toContain('BrowserX');
    expect(prompt).toContain('Core Directive');
    expect(prompt).toContain('System Semantics');
    expect(prompt).toContain('Action Risk and Approval');
    expect(prompt).toContain('Work Loop');

    // Should have logged the error
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('composeMainInstruction failed'),
      expect.any(Error)
    );
  });

  it('isComposerConfigured returns false before config, true after', async () => {
    const { isComposerConfigured, configurePromptComposer } = await import('@/core/PromptLoader');

    expect(isComposerConfigured()).toBe(false);

    configurePromptComposer('browserx');

    expect(isComposerConfigured()).toBe(true);
  });

  it('returns browserx default prompt (not pi) when composer is not configured', async () => {
    const { loadPrompt } = await import('@/core/PromptLoader');

    const prompt = await loadPrompt();

    // In test/extension mode (__BUILD_MODE__ is undefined), fallback should be browserx
    expect(prompt).toContain('BrowserX');
    // Must not contain "ApplePi" or standalone "Pi" (only "BrowserX" identity)
    expect(prompt).not.toMatch(/\bApplePi\b/);
    expect(prompt).not.toMatch(/\bPi\b/);
    expect(prompt).not.toContain('desktop automation agent');
  });
});
