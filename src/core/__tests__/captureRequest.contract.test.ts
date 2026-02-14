/**
 * Contract Test: CaptureRequest Schema Validation
 *
 * Purpose: Validates that captureInteractionContent() accepts CaptureRequest parameters
 * conforming to the CaptureRequest JSON schema and applies default values correctly.
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Schema: specs/038-implement-captureinteractioncontent-request/contracts/capture-request.schema.json
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// This import WILL FAIL initially - that's expected for TDD
import { captureInteractionContent } from '@/tools/dom/interactionCapture';

describe('CaptureRequest Contract Tests', () => {
  // Load JSON schema
  const schemaPath = resolve(__dirname, '../../specs/038-implement-captureinteractioncontent-request/contracts/capture-request.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

  // Setup JSON Schema validator
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const testHtml = '<html><head><title>Test</title></head><body><button>Click</button></body></html>';

  it('should accept empty request object (all defaults)', async () => {
    const request = {};

    const valid = validate(request);
    expect(valid).toBe(true);

    // Should not throw with empty request
    const result = await captureInteractionContent(testHtml, request);
    expect(result).toBeTruthy();
  });

  it('should accept valid CaptureRequest with all fields', async () => {
    const request = {
      baseUrl: 'https://example.com',
      maxControls: 400,
      maxHeadings: 30,
      includeValues: false,
      maxIframeDepth: 1
    };

    const valid = validate(request);
    expect(valid).toBe(true);

    const result = await captureInteractionContent(testHtml, request);
    expect(result).toBeTruthy();
  });

  it('should apply default values when fields omitted', async () => {
    const html = Array.from({ length: 500 }, (_, i) =>
      `<button id="btn-${i}">Button ${i}</button>`
    ).join('\n');

    const fullHtml = `<html><head><title>Test</title></head><body>${html}</body></html>`;

    // Omit maxControls - should default to 400
    const result = await captureInteractionContent(fullHtml, {});

    expect(result.controls.length).toBeLessThanOrEqual(400);
  });

  it('should respect custom maxControls value', async () => {
    const html = Array.from({ length: 100 }, (_, i) =>
      `<button id="btn-${i}">Button ${i}</button>`
    ).join('\n');

    const fullHtml = `<html><head><title>Test</title></head><body>${html}</body></html>`;

    const result = await captureInteractionContent(fullHtml, {
      maxControls: 50
    });

    expect(result.controls.length).toBeLessThanOrEqual(50);
  });

  it('should respect custom maxHeadings value', async () => {
    const html = Array.from({ length: 50 }, (_, i) =>
      `<h1>Heading ${i}</h1>`
    ).join('\n');

    const fullHtml = `<html><head><title>Test</title></head><body>${html}</body></html>`;

    const result = await captureInteractionContent(fullHtml, {
      maxHeadings: 10
    });

    expect(result.headings.length).toBeLessThanOrEqual(10);
  });

  it('should use baseUrl for relative path resolution', async () => {
    const html = `
      <html>
        <head><title>Test</title></head>
        <body>
          <a href="/relative-path">Link</a>
        </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {
      baseUrl: 'https://example.com'
    });

    // URL should be set from baseUrl
    expect(result.url).toBe('https://example.com');
  });

  it('should reject invalid CaptureRequest (maxControls < 1)', () => {
    const request = {
      maxControls: 0
    };

    const valid = validate(request);
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('should reject invalid CaptureRequest (maxHeadings < 1)', () => {
    const request = {
      maxHeadings: 0
    };

    const valid = validate(request);
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('should reject invalid CaptureRequest (maxIframeDepth < 0)', () => {
    const request = {
      maxIframeDepth: -1
    };

    const valid = validate(request);
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('should reject invalid CaptureRequest (baseUrl not valid URI)', () => {
    const request = {
      baseUrl: 'not-a-valid-url'
    };

    const valid = validate(request);
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });

  it('should reject additional properties not in schema', () => {
    const request = {
      unknownField: 'invalid'
    };

    const valid = validate(request);
    expect(valid).toBe(false);
    expect(validate.errors).toBeTruthy();
  });
});
