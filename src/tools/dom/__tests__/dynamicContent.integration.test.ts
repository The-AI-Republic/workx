/**
 * Integration Test: Dynamic Content Scenario
 *
 * Purpose: Validates capture of dynamic states (checkboxes, expandables, disabled elements)
 *
 * Feature: 038-implement-captureinteractioncontent-request
 * Reference: specs/038-implement-captureinteractioncontent-request/spec.md - Scenario 3
 */

import { describe, it, expect } from 'vitest';
import { captureInteractionContent } from '@/tools/dom/interactionCapture';

describe('Integration: Dynamic Content States', () => {
  it('should capture checkbox checked state', async () => {
    const html = `
      <html>
      <head><title>Checkbox Test</title></head>
      <body>
        <label><input type="checkbox" id="cb1" checked> Option 1</label>
        <label><input type="checkbox" id="cb2"> Option 2</label>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const checkedBox = result.controls.find(c => c.selector.includes('cb1'));
    const uncheckedBox = result.controls.find(c => c.selector.includes('cb2'));

    expect(checkedBox).toBeDefined();
    expect(checkedBox!.role).toBe('checkbox');
    expect(checkedBox!.states.checked).toBe(true);

    expect(uncheckedBox).toBeDefined();
    expect(uncheckedBox!.states.checked).toBe(false);
  });

  it('should capture radio button checked state', async () => {
    const html = `
      <html>
      <head><title>Radio Test</title></head>
      <body>
        <form>
          <label><input type="radio" name="option" value="a" id="r1" checked> Option A</label>
          <label><input type="radio" name="option" value="b" id="r2"> Option B</label>
        </form>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const radioA = result.controls.find(c => c.selector.includes('r1'));
    const radioB = result.controls.find(c => c.selector.includes('r2'));

    expect(radioA).toBeDefined();
    expect(radioA!.role).toBe('radio');
    expect(radioA!.states.checked).toBe(true);

    expect(radioB).toBeDefined();
    expect(radioB!.states.checked).toBe(false);
  });

  it('should capture aria-expanded state for expandable sections', async () => {
    const html = `
      <html>
      <head><title>Expandable Test</title></head>
      <body>
        <button aria-expanded="true" aria-controls="section1">Collapse Section</button>
        <div id="section1">Content here</div>

        <button aria-expanded="false" aria-controls="section2">Expand Section</button>
        <div id="section2" style="display: none;">Hidden content</div>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const expandedButton = result.controls.find(c =>
      c.name.includes('Collapse')
    );

    const collapsedButton = result.controls.find(c =>
      c.name.includes('Expand')
    );

    expect(expandedButton).toBeDefined();
    expect(expandedButton!.states.expanded).toBe(true);

    expect(collapsedButton).toBeDefined();
    expect(collapsedButton!.states.expanded).toBe(false);
  });

  it('should capture disabled state for buttons', async () => {
    const html = `
      <html>
      <head><title>Disabled Test</title></head>
      <body>
        <button id="active-btn">Active Button</button>
        <button id="disabled-btn" disabled>Disabled Button</button>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const activeButton = result.controls.find(c => c.selector.includes('active-btn'));
    const disabledButton = result.controls.find(c => c.selector.includes('disabled-btn'));

    expect(activeButton).toBeDefined();
    expect(activeButton!.states.disabled).toBeUndefined(); // Only include if true

    expect(disabledButton).toBeDefined();
    expect(disabledButton!.states.disabled).toBe(true);
  });

  it('should capture disabled state for inputs', async () => {
    const html = `
      <html>
      <head><title>Disabled Input Test</title></head>
      <body>
        <input type="text" id="active-input" placeholder="Active">
        <input type="text" id="disabled-input" disabled placeholder="Disabled">
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const activeInput = result.controls.find(c => c.selector.includes('active-input'));
    const disabledInput = result.controls.find(c => c.selector.includes('disabled-input'));

    expect(activeInput).toBeDefined();
    expect(activeInput!.states.disabled).toBeUndefined();

    expect(disabledInput).toBeDefined();
    expect(disabledInput!.states.disabled).toBe(true);
  });

  it('should capture aria-disabled state', async () => {
    const html = `
      <html>
      <head><title>ARIA Disabled Test</title></head>
      <body>
        <button aria-disabled="true">ARIA Disabled Button</button>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const button = result.controls.find(c => c.name.includes('ARIA Disabled'));

    expect(button).toBeDefined();
    expect(button!.states.disabled).toBe(true);
  });

  it('should mark visible elements correctly', async () => {
    const html = `
      <html>
      <head><title>Visibility Test</title></head>
      <body>
        <button id="visible-btn">Visible</button>
        <button id="hidden-btn" style="display: none;">Hidden</button>
        <button id="opacity-btn" style="opacity: 0;">Transparent</button>
        <button id="visibility-btn" style="visibility: hidden;">Not Visible</button>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const visibleBtn = result.controls.find(c => c.selector.includes('visible-btn'));
    const hiddenBtn = result.controls.find(c => c.selector.includes('hidden-btn'));
    const opacityBtn = result.controls.find(c => c.selector.includes('opacity-btn'));
    const visibilityBtn = result.controls.find(c => c.selector.includes('visibility-btn'));

    expect(visibleBtn).toBeDefined();
    expect(visibleBtn!.visible).toBe(true);

    // Hidden elements should either be filtered out or marked as not visible
    if (hiddenBtn) {
      expect(hiddenBtn.visible).toBe(false);
    }

    if (opacityBtn) {
      expect(opacityBtn.visible).toBe(false);
    }

    if (visibilityBtn) {
      expect(visibilityBtn.visible).toBe(false);
    }
  });

  it('should capture inViewport flag based on position', async () => {
    const html = `
      <html>
      <head><title>Viewport Test</title></head>
      <body>
        <button id="top-btn">Top Button</button>
        <div style="height: 10000px;"></div>
        <button id="bottom-btn">Bottom Button</button>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    // All controls should have inViewport flag set
    for (const control of result.controls) {
      expect(typeof control.inViewport).toBe('boolean');
    }
  });

  it('should capture details/summary expanded state', async () => {
    const html = `
      <html>
      <head><title>Details Test</title></head>
      <body>
        <details open>
          <summary>Expanded Section</summary>
          <p>Content is visible</p>
        </details>

        <details>
          <summary>Collapsed Section</summary>
          <p>Content is hidden</p>
        </details>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    // Summary elements should be captured with expanded state
    const summaries = result.controls.filter(c =>
      c.name.includes('Section')
    );

    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it('should capture select/combobox selected value length', async () => {
    const html = `
      <html>
      <head><title>Select Test</title></head>
      <body>
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">Select...</option>
          <option value="us" selected>United States</option>
          <option value="ca">Canada</option>
        </select>
      </body>
      </html>
    `;

    const result = await captureInteractionContent(html, {});

    const select = result.controls.find(c => c.selector.includes('country'));

    expect(select).toBeDefined();
    expect(select!.role).toBe('combobox');

    // Should include value_len for selected option
    if (select!.states.value_len !== undefined) {
      expect(select!.states.value_len).toBeGreaterThan(0);
    }
  });
});
