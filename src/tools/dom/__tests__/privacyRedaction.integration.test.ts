/**
 * Integration Test: Privacy Redaction Scenario
 *
 * Purpose: Validates that sensitive form data is never exposed in output
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Reference: specs/038-implement-captureinteractioncontent-request/spec.md - Security Requirements
 */

import { describe, it, expect } from 'vitest';
import { captureInteractionContent } from '@/tools/dom/interactionCapture';

describe('Integration: Privacy Redaction', () => {
  it('should NEVER include password field values', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <form>
          <input type="password" id="pwd" name="password" value="secret123">
        </form>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      includeValues: false
    });

    const fullJson = JSON.stringify(result);

    // Password value must NEVER appear in output
    expect(fullJson).not.toContain('secret123');

    const passwordControl = result.controls.find(c =>
      c.selector.includes('pwd') || c.name.toLowerCase().includes('password')
    );

    expect(passwordControl).toBeDefined();

    // Password should NOT have value_len (even length can leak info)
    expect(passwordControl!.states).not.toHaveProperty('value_len');

    // Password should NOT have value property
    expect(passwordControl!.states).not.toHaveProperty('value');
  });

  it('should NEVER include password length (even with includeValues=false)', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="password" id="pwd" value="12345678">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      includeValues: false
    });

    const passwordControl = result.controls.find(c =>
      c.selector.includes('pwd')
    );

    expect(passwordControl).toBeDefined();
    expect(passwordControl!.states).not.toHaveProperty('value_len');
  });

  it('should NOT include form values by default (includeValues=false)', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <form>
          <input type="text" id="username" value="john_doe">
          <input type="email" id="email" value="john@example.com">
        </form>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      includeValues: false
    });

    const fullJson = JSON.stringify(result);

    // Form values should NOT appear in output
    expect(fullJson).not.toContain('john_doe');
    expect(fullJson).not.toContain('john@example.com');
  });

  it('should include value_len for non-password fields (privacy-preserving signal)', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="text" id="username" value="john_doe">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      includeValues: false
    });

    const usernameControl = result.controls.find(c =>
      c.selector.includes('username')
    );

    expect(usernameControl).toBeDefined();

    // Should have value_len (indicates filled vs empty)
    expect(usernameControl!.states).toHaveProperty('value_len');
    expect(usernameControl!.states.value_len).toBe(8); // "john_doe".length

    // Should NOT have actual value
    expect(usernameControl!.states).not.toHaveProperty('value');
  });

  it('should include placeholder text (not sensitive)', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="email" id="email" placeholder="you@example.com">
        <input type="password" id="pwd" placeholder="Enter password">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const emailControl = result.controls.find(c =>
      c.selector.includes('email')
    );

    const passwordControl = result.controls.find(c =>
      c.selector.includes('pwd')
    );

    // Placeholder text is safe to include
    expect(emailControl!.states.placeholder).toBe('you@example.com');
    expect(passwordControl!.states.placeholder).toBe('Enter password');
  });

  it('should redact password values even with includeValues=true', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="password" id="pwd" value="secret123">
        <input type="text" id="username" value="john_doe">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      includeValues: true
    });

    const passwordControl = result.controls.find(c =>
      c.selector.includes('pwd')
    );

    const usernameControl = result.controls.find(c =>
      c.selector.includes('username')
    );

    // Password should still be redacted (never exposed)
    expect(passwordControl!.states).not.toHaveProperty('value');
    expect(passwordControl!.states).not.toHaveProperty('value_len');

    // Non-password field should include value when includeValues=true
    if (usernameControl) {
      expect(usernameControl.states).toHaveProperty('value');
      expect(usernameControl.states.value).toBe('john_doe');
    }
  });

  it('should handle empty password fields correctly', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="password" id="pwd" value="">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const passwordControl = result.controls.find(c =>
      c.selector.includes('pwd')
    );

    expect(passwordControl).toBeDefined();

    // Empty password should also not have value_len
    expect(passwordControl!.states).not.toHaveProperty('value_len');
    expect(passwordControl!.states).not.toHaveProperty('value');
  });

  it('should detect password inputs by type attribute', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="password" id="pwd1" value="test123">
        <input type="PASSWORD" id="pwd2" value="test456">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const fullJson = JSON.stringify(result);

    // No password values should leak
    expect(fullJson).not.toContain('test123');
    expect(fullJson).not.toContain('test456');

    const passwordControls = result.controls.filter(c =>
      c.selector.includes('pwd')
    );

    expect(passwordControls.length).toBe(2);

    for (const control of passwordControls) {
      expect(control.states).not.toHaveProperty('value');
      expect(control.states).not.toHaveProperty('value_len');
    }
  });

  it('should preserve required state for password fields', async () => {
    const html = `
      <html>
      <head><title>Privacy Test</title></head>
      <body>
        <input type="password" id="pwd" required>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const passwordControl = result.controls.find(c =>
      c.selector.includes('pwd')
    );

    expect(passwordControl).toBeDefined();

    // Required state is safe to include
    expect(passwordControl!.states.required).toBe(true);

    // But value/value_len must still be omitted
    expect(passwordControl!.states).not.toHaveProperty('value');
    expect(passwordControl!.states).not.toHaveProperty('value_len');
  });
});
