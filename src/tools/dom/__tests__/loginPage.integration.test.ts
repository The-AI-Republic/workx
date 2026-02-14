/**
 * Integration Test: Login Page Scenario
 *
 * Purpose: Validates complete login page capture matching acceptance criteria from spec.md
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Reference: specs/038-implement-captureinteractioncontent-request/spec.md - Scenario 1
 */

import { describe, it, expect } from 'vitest';
import { captureInteractionContent } from '@/tools/dom/interactionCapture';

describe('Integration: Login Page Scenario', () => {
  const loginPageHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Login - Example Site</title>
    </head>
    <body>
      <header>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
        </nav>
      </header>

      <main>
        <h1>Login</h1>
        <form id="login-form">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required placeholder="you@example.com">

          <label for="password">Password</label>
          <input type="password" id="password" name="password" required>

          <button type="submit" class="btn-primary">Sign In</button>
        </form>
      </main>

      <footer>
        <p>&copy; 2025 Example Inc.</p>
      </footer>
    </body>
    </html>
  `;

  it('should capture login page with correct structure', async () => {
    const result = await captureInteractionContent(loginPageHtml, {
      baseUrl: 'https://example.com/login'
    });

    // Title extraction
    expect(result.title).toBe('Login - Example Site');
    expect(result.url).toBe('https://example.com/login');

    // Headings extraction
    expect(result.headings).toContain('Login');
    expect(result.headings.length).toBeGreaterThanOrEqual(1);

    // Regions detection
    expect(result.regions).toContain('main');
    expect(result.regions).toContain('navigation');

    // Controls captured (2 links + 2 inputs + 1 button = 5)
    expect(result.controls.length).toBeGreaterThanOrEqual(5);
  });

  it('should extract email input with correct properties', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    const emailControl = result.controls.find(c =>
      c.name.toLowerCase().includes('email') && c.role === 'textbox'
    );

    expect(emailControl).toBeDefined();
    expect(emailControl!.id).toMatch(/^te_\d+$/); // textbox ID pattern
    expect(emailControl!.selector).toContain('email'); // ID-based selector
    expect(emailControl!.states.required).toBe(true);
    expect(emailControl!.states.placeholder).toBe('you@example.com');
    expect(emailControl!.states.value_len).toBe(0); // Empty initially
    expect(emailControl!.visible).toBe(true);
    expect(emailControl!.region).toBe('main');
  });

  it('should extract password input with privacy protection', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    const passwordControl = result.controls.find(c =>
      c.name.toLowerCase().includes('password') && c.role === 'textbox'
    );

    expect(passwordControl).toBeDefined();
    expect(passwordControl!.id).toMatch(/^te_\d+$/);
    expect(passwordControl!.states.required).toBe(true);

    // Privacy: password value_len should NOT be included
    expect(passwordControl!.states).not.toHaveProperty('value_len');

    // Privacy: password value should NEVER be exposed
    expect(passwordControl!.states).not.toHaveProperty('value');
  });

  it('should extract submit button with correct properties', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    const submitButton = result.controls.find(c =>
      c.name.toLowerCase().includes('sign in') && c.role === 'button'
    );

    expect(submitButton).toBeDefined();
    expect(submitButton!.id).toMatch(/^bu_\d+$/); // button ID pattern
    expect(submitButton!.name).toBe('Sign In');
    expect(submitButton!.selector).toContain('btn-primary'); // class-based selector
    expect(submitButton!.region).toBe('main');
    expect(submitButton!.visible).toBe(true);
  });

  it('should extract navigation links with correct properties', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    const homeLink = result.controls.find(c =>
      c.name === 'Home' && c.role === 'link'
    );

    const aboutLink = result.controls.find(c =>
      c.name === 'About' && c.role === 'link'
    );

    expect(homeLink).toBeDefined();
    expect(homeLink!.id).toMatch(/^li_\d+$/); // link ID pattern
    expect(homeLink!.states.href).toBe('/');
    expect(homeLink!.region).toBe('navigation');

    expect(aboutLink).toBeDefined();
    expect(aboutLink!.states.href).toBe('/about');
  });

  it('should generate stable IDs for all controls', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    const ids = result.controls.map(c => c.id);

    // All IDs unique
    expect(new Set(ids).size).toBe(ids.length);

    // All IDs match pattern {role[0:2]}_{counter}
    for (const id of ids) {
      expect(id).toMatch(/^[a-z]{2}_\d+$/);
    }
  });

  it('should have aimap keys matching all control IDs', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    const controlIds = new Set(result.controls.map(c => c.id));
    const aimapKeys = new Set(Object.keys(result.aimap));

    expect(controlIds).toEqual(aimapKeys);

    // Every aimap value should be a valid CSS selector
    for (const selector of Object.values(result.aimap)) {
      expect(selector).toBeTruthy();
      expect(typeof selector).toBe('string');
    }
  });

  it('should preserve selector-to-element mapping integrity', async () => {
    const result = await captureInteractionContent(loginPageHtml, {});

    // For each control, verify its selector matches the aimap entry
    for (const control of result.controls) {
      expect(result.aimap[control.id]).toBe(control.selector);
    }
  });
});
