/**
 * Contract Test: PageModel Schema Validation
 *
 * Purpose: Validates that captureInteractionContent() output conforms to the PageModel JSON schema.
 * This test MUST FAIL initially (before implementation) and PASS after implementation.
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Schema: specs/038-implement-captureinteractioncontent-request/contracts/page-model.schema.json
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// This import WILL FAIL initially - that's expected for TDD
import { captureInteractionContent } from '@/tools/dom/interactionCapture';
import type { PageModel } from '@/tools/dom/pageModel';

describe('PageModel Contract Tests', () => {
  // Load JSON schema
  const schemaPath = resolve(__dirname, '../../specs/038-implement-captureinteractioncontent-request/contracts/page-model.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

  // Setup JSON Schema validator
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it('should produce output conforming to PageModel schema', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Test Heading</h1>
          <button id="test-btn">Click Me</button>
        </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      baseUrl: 'https://example.com'
    });

    const valid = validate(result);

    if (!valid) {
      console.error('Schema validation errors:', validate.errors);
    }

    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('should have required fields: title, headings, regions, controls, aimap', async () => {
    const html = '<html><head><title>Minimal</title></head><body></body></html>';

    const result = await captureInteractionContent(html, {});

    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('headings');
    expect(result).toHaveProperty('regions');
    expect(result).toHaveProperty('controls');
    expect(result).toHaveProperty('aimap');

    expect(Array.isArray(result.headings)).toBe(true);
    expect(Array.isArray(result.regions)).toBe(true);
    expect(Array.isArray(result.controls)).toBe(true);
    expect(typeof result.aimap).toBe('object');
  });

  it('should cap controls at maxControls limit', async () => {
    // Generate HTML with 500 buttons (exceeds 400 cap)
    const buttons = Array.from({ length: 500 }, (_, i) =>
      `<button id="btn-${i}">Button ${i}</button>`
    ).join('\n');

    const html = `
      <html>
        <head><title>Many Buttons</title></head>
        <body>${buttons}</body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      maxControls: 400
    });

    expect(result.controls.length).toBeLessThanOrEqual(400);
  });

  it('should cap headings at maxHeadings limit', async () => {
    // Generate HTML with 50 headings (exceeds 30 cap)
    const headings = Array.from({ length: 50 }, (_, i) =>
      `<h${(i % 3) + 1}>Heading ${i}</h${(i % 3) + 1}>`
    ).join('\n');

    const html = `
      <html>
        <head><title>Many Headings</title></head>
        <body>${headings}</body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      maxHeadings: 30
    });

    expect(result.headings.length).toBeLessThanOrEqual(30);
  });

  it('should generate stable IDs matching pattern {role[0:2]}_{counter}', async () => {
    const html = `
      <html>
        <head><title>ID Test</title></head>
        <body>
          <button id="btn1">Button</button>
          <a href="/link">Link</a>
          <input type="text" id="input1">
        </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    for (const control of result.controls) {
      // ID format: 2-char role prefix + underscore + number
      expect(control.id).toMatch(/^[a-z]{2}_\d+$/);
    }
  });

  it('should have aimap keys matching control IDs exactly', async () => {
    const html = `
      <html>
        <head><title>Aimap Test</title></head>
        <body>
          <button id="btn1">Button</button>
          <a href="/link">Link</a>
        </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const controlIds = new Set(result.controls.map(c => c.id));
    const aimapKeys = new Set(Object.keys(result.aimap));

    expect(controlIds).toEqual(aimapKeys);
  });

  it('should include accessible names with max 160 chars', async () => {
    const longName = 'A'.repeat(200);
    const html = `
      <html>
        <head><title>Name Test</title></head>
        <body>
          <button aria-label="${longName}">Button</button>
        </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    for (const control of result.controls) {
      expect(control.name).toBeTruthy();
      expect(control.name.length).toBeLessThanOrEqual(160);
    }
  });

  it('should mark visible and inViewport flags correctly', async () => {
    const html = `
      <html>
        <head><title>Visibility Test</title></head>
        <body>
          <button id="visible-btn">Visible Button</button>
          <button id="hidden-btn" style="display: none;">Hidden Button</button>
        </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    for (const control of result.controls) {
      expect(typeof control.visible).toBe('boolean');
      expect(typeof control.inViewport).toBe('boolean');
    }
  });
});
