/**
 * Unit tests for FormAutomationTool
 *
 * Covers:
 * - Tool definition and parameter validation
 * - Form field detection (detectFieldsInPage logic)
 * - Input type handling (text, email, checkbox, radio, select, file, etc.)
 * - Form filling behavior
 * - Validation before submit
 * - Submit behavior (click, enter, javascript)
 * - Error handling for invalid selectors and missing elements
 * - Multi-step form execution
 * - Form metadata retrieval
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FormAutomationTool } from '@/tools/FormAutomationTool';
import type { FormAutomationTask } from '@/tools/FormAutomationTool';

// ---------------------------------------------------------------------------
// Chrome API helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock chrome.scripting.executeScript that runs the injected function
 * against jsdom's document, mimicking what the real Chrome API does in-page.
 */
function createScriptExecutor() {
  return vi.fn().mockImplementation(
    async ({ func, args }: { target: { tabId: number }; func: (...a: any[]) => any; args?: any[] }) => {
      const result = func(...(args ?? []));
      return [{ result }];
    }
  );
}

/**
 * Return a fake chrome.tabs.Tab object.
 */
function fakeTab(id: number = 1, url: string = 'https://example.com'): chrome.tabs.Tab {
  return {
    id, url, index: 0, pinned: false, highlighted: false,
    windowId: 1, active: true, incognito: false, selected: false,
    discarded: false, autoDiscardable: true, groupId: -1,
  } as chrome.tabs.Tab;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Helper to execute tool with validation bypassed.
 *
 * The tool schema (additionalProperties: false) does not declare every property
 * that FormAutomationTask supports (e.g. `steps`). When we want to test runtime
 * behaviour that depends on those extra properties we bypass BaseTool validation.
 */
async function executeBypassingValidation(
  tool: FormAutomationTool,
  request: FormAutomationTask,
  options?: { metadata?: Record<string, any> },
) {
  // Temporarily stub validateParameters to pass
  const spy = vi.spyOn(tool as any, 'validateParameters').mockReturnValue({ valid: true, errors: [] });
  try {
    return await tool.execute(request, options);
  } finally {
    spy.mockRestore();
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('FormAutomationTool', () => {
  let tool: FormAutomationTool;
  let executeScriptMock: ReturnType<typeof createScriptExecutor>;

  beforeEach(() => {
    tool = new FormAutomationTool();
    executeScriptMock = createScriptExecutor();

    // Extend the global chrome mock provided by the test-setup with scripting + tabs.get
    const chromeAny = globalThis.chrome as any;
    chromeAny.scripting = { executeScript: executeScriptMock };
    chromeAny.tabs.get = vi.fn().mockResolvedValue(fakeTab(1));
    chromeAny.tabs.create = vi.fn().mockResolvedValue(fakeTab(2, 'https://new.example.com'));

    // Reset the document body between tests so each test starts with a clean DOM.
    document.body.innerHTML = '';
  });

  // =========================================================================
  // 1. Tool Definition
  // =========================================================================
  describe('Tool Definition', () => {
    it('should expose a function-type tool definition', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
    });

    it('should be named "form_automation"', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.name).toBe('form_automation');
      }
    });

    it('should declare "fields" as a required parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const params = def.function.parameters;
        if (params.type === 'object' && params.required) {
          expect(params.required).toContain('fields');
        }
      }
    });

    it('should include url, formSelector, submitButton, submitMethod, and other parameters', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const params = def.function.parameters;
        if (params.type === 'object') {
          const keys = Object.keys(params.properties!);
          expect(keys).toEqual(
            expect.arrayContaining([
              'url',
              'formSelector',
              'autoDetect',
              'fields',
              'submitButton',
              'submitMethod',
              'validateBeforeSubmit',
              'waitAfterSubmit',
            ])
          );
        }
      }
    });

    it('should declare category as "browser" in metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).category).toBe('browser');
      }
    });
  });

  // =========================================================================
  // 2. Parameter Validation (via BaseTool.execute)
  // =========================================================================
  describe('Parameter Validation', () => {
    it('should fail when "fields" is missing', async () => {
      const result = await tool.execute(
        {} as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("'fields'");
      expect(result.error).toContain('missing');
    });

    it('should fail when "fields" is null', async () => {
      const result = await tool.execute(
        { fields: null } as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("'fields'");
    });

    it('should fail when "fields" is not an array', async () => {
      const result = await tool.execute(
        { fields: 'not-an-array' } as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('array');
    });

    it('should fail when "submitMethod" is not a string', async () => {
      const result = await tool.execute(
        { fields: [], submitMethod: 123 } as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should fail when "waitAfterSubmit" is not a number', async () => {
      const result = await tool.execute(
        { fields: [], waitAfterSubmit: 'abc' } as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('number');
    });

    it('should fail when "validateBeforeSubmit" is not a boolean', async () => {
      const result = await tool.execute(
        { fields: [], validateBeforeSubmit: 'yes' } as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('boolean');
    });

    it('should pass validation with valid parameters', async () => {
      // Provide a matching form in the DOM so waitForForm succeeds immediately
      document.body.innerHTML = '<form><input id="name" name="name" type="text" /></form>';

      const result = await tool.execute(
        {
          fields: [{ selector: '#name', value: 'Alice' }],
          formSelector: 'form',
          submitMethod: 'click',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      // Should not fail parameter validation
      if (!result.success) {
        expect(result.error).not.toContain('Parameter validation failed');
      }
    });
  });

  // =========================================================================
  // 3. Form Field Detection
  // =========================================================================
  describe('Form Field Detection', () => {
    it('should detect text input fields within a form', async () => {
      document.body.innerHTML = `
        <form id="myform">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" required placeholder="Enter username" />
        </form>
      `;

      const fields = await tool.detectFields(1, '#myform');
      expect(fields.length).toBe(1);
      expect(fields[0].name).toBe('username');
      expect(fields[0].type).toBe('text');
      expect(fields[0].required).toBe(true);
      expect(fields[0].label).toBe('Username');
      expect(fields[0].placeholder).toBe('Enter username');
      expect(fields[0].selector).toBe('#username');
    });

    it('should detect email fields by input type', async () => {
      document.body.innerHTML = `
        <form>
          <input id="email" name="email" type="email" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(1);
      expect(fields[0].type).toBe('email');
    });

    it('should detect email fields by name attribute heuristic', async () => {
      document.body.innerHTML = `
        <form>
          <input id="user_email" name="user_email" type="text" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(1);
      expect(fields[0].type).toBe('email');
    });

    it('should detect password fields', async () => {
      document.body.innerHTML = `
        <form>
          <input id="pw" name="password" type="password" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(1);
      expect(fields[0].type).toBe('password');
    });

    it('should detect telephone fields by name heuristic', async () => {
      document.body.innerHTML = `
        <form>
          <input id="phone_num" name="phone" type="text" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].type).toBe('tel');
    });

    it('should detect number fields', async () => {
      document.body.innerHTML = `
        <form>
          <input id="qty" name="quantity" type="number" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].type).toBe('number');
    });

    it('should detect date fields', async () => {
      document.body.innerHTML = `
        <form>
          <input id="dob" name="birthdate" type="date" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].type).toBe('date');
    });

    it('should detect checkbox fields', async () => {
      document.body.innerHTML = `
        <form>
          <input id="agree" name="terms" type="checkbox" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].type).toBe('checkbox');
    });

    it('should detect radio fields', async () => {
      document.body.innerHTML = `
        <form>
          <input id="opt1" name="option" type="radio" value="a" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].type).toBe('radio');
    });

    it('should detect select elements and capture options', async () => {
      document.body.innerHTML = `
        <form>
          <select id="color" name="color">
            <option value="red">Red</option>
            <option value="blue">Blue</option>
            <option value="green">Green</option>
          </select>
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(1);
      expect(fields[0].type).toBe('select');
      expect(fields[0].options).toEqual(['red', 'blue', 'green']);
    });

    it('should detect textarea elements', async () => {
      document.body.innerHTML = `
        <form>
          <textarea id="bio" name="bio"></textarea>
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(1);
      expect(fields[0].type).toBe('textarea');
    });

    it('should skip hidden inputs', async () => {
      document.body.innerHTML = `
        <form>
          <input type="hidden" name="csrf" value="token123" />
          <input id="name" name="name" type="text" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(1);
      expect(fields[0].name).toBe('name');
    });

    it('should capture validation pattern from the pattern attribute', async () => {
      document.body.innerHTML = `
        <form>
          <input id="zip" name="zip" type="text" pattern="[0-9]{5}" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].validation).toBe('[0-9]{5}');
    });

    it('should detect multiple fields in a single form', async () => {
      document.body.innerHTML = `
        <form>
          <input id="first" name="first_name" type="text" />
          <input id="last" name="last_name" type="text" />
          <input id="em" name="email" type="email" />
          <textarea id="msg" name="message"></textarea>
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields.length).toBe(4);
    });

    it('should return empty array when form selector does not match', async () => {
      document.body.innerHTML = '<div>No form here</div>';

      const fields = await tool.detectFields(1, '#nonexistent');
      expect(fields).toEqual([]);
    });

    it('should find label via for attribute', async () => {
      document.body.innerHTML = `
        <form>
          <label for="fname">First Name</label>
          <input id="fname" name="first_name" type="text" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].label).toBe('First Name');
    });

    it('should find label via parent label element', async () => {
      document.body.innerHTML = `
        <form>
          <label>
            Last Name
            <input name="last_name" type="text" />
          </label>
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].label).toContain('Last Name');
    });

    it('should generate name-based selector when element has name but no id', async () => {
      document.body.innerHTML = `
        <form>
          <input name="city" type="text" />
        </form>
      `;

      const fields = await tool.detectFields(1, 'form');
      expect(fields[0].selector).toBe('[name="city"]');
    });
  });

  // =========================================================================
  // 4. Form Filling & Input Type Handling
  // =========================================================================
  describe('Form Filling', () => {
    it('should fill a text input by selector', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#name', value: 'Alice' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.filledFields).toContain('#name');

      const input = document.querySelector('#name') as HTMLInputElement;
      expect(input.value).toBe('Alice');
    });

    it('should fill a text input by name when no selector is provided', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input name="username" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ name: 'username', value: 'Bob' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.filledFields).toContain('username');

      const input = document.querySelector('[name="username"]') as HTMLInputElement;
      expect(input.value).toBe('Bob');
    });

    it('should check a checkbox when value is truthy string', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="agree" name="agree" type="checkbox" />
        </form>
      `;

      // The schema declares value as string. The implementation uses !!field.value
      // so a non-empty string will be truthy.
      const result = await executeBypassingValidation(tool, {
        fields: [{ selector: '#agree', type: 'checkbox', value: true }],
        formSelector: '#f1',
        validateBeforeSubmit: false,
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(result.success).toBe(true);
      const checkbox = document.querySelector('#agree') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it('should uncheck a checkbox when value is falsy', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="agree" name="agree" type="checkbox" checked />
        </form>
      `;

      // Use boolean false -- bypassing schema validation since schema says string
      const result = await executeBypassingValidation(tool, {
        fields: [{ selector: '#agree', type: 'checkbox', value: false }],
        formSelector: '#f1',
        validateBeforeSubmit: false,
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(result.success).toBe(true);
      const checkbox = document.querySelector('#agree') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it('should check a radio button when value matches', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="opt_a" name="choice" type="radio" value="a" />
          <input id="opt_b" name="choice" type="radio" value="b" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#opt_a', type: 'radio', value: 'a' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      const radio = document.querySelector('#opt_a') as HTMLInputElement;
      expect(radio.checked).toBe(true);
    });

    it('should not check a radio button when value does not match', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="opt_a" name="choice" type="radio" value="a" />
        </form>
      `;

      await tool.execute(
        {
          fields: [{ selector: '#opt_a', type: 'radio', value: 'b' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      const radio = document.querySelector('#opt_a') as HTMLInputElement;
      expect(radio.checked).toBe(false);
    });

    it('should set select element value', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <select id="color" name="color">
            <option value="red">Red</option>
            <option value="blue">Blue</option>
          </select>
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#color', type: 'select', value: 'blue' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      const select = document.querySelector('#color') as HTMLSelectElement;
      expect(select.value).toBe('blue');
    });

    it('should report an error for file inputs', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="upload" name="upload" type="file" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#upload', type: 'file', value: '/tmp/test.txt' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.errors.length).toBeGreaterThan(0);
      expect(result.data.errors[0].message).toContain('File inputs cannot be programmatically filled');
    });

    it('should report an error when field selector matches nothing', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#nonexistent', value: 'test' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.errors.length).toBe(1);
      expect(result.data.errors[0].message).toBe('Field not found');
    });

    it('should timeout when form selector matches nothing', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '<div>No form</div>';

      const promise = tool.execute(
        {
          fields: [{ selector: '#name', value: 'test' }],
          formSelector: '#missing_form',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      // Advance time past the 10 s waitForForm timeout
      await vi.advanceTimersByTimeAsync(11000);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout waiting for form');

      vi.useRealTimers();
    });

    it('should fill multiple fields in one call', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="first" name="first_name" type="text" />
          <input id="last" name="last_name" type="text" />
          <input id="em" name="email" type="email" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [
            { selector: '#first', value: 'Alice' },
            { selector: '#last', value: 'Smith' },
            { selector: '#em', value: 'alice@example.com' },
          ],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.filledFields).toHaveLength(3);
      expect((document.querySelector('#first') as HTMLInputElement).value).toBe('Alice');
      expect((document.querySelector('#last') as HTMLInputElement).value).toBe('Smith');
      expect((document.querySelector('#em') as HTMLInputElement).value).toBe('alice@example.com');
    });

    it('should dispatch change and input events by default', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" />
        </form>
      `;

      const inputEl = document.querySelector('#name') as HTMLInputElement;
      const changeHandler = vi.fn();
      const inputHandler = vi.fn();
      inputEl.addEventListener('change', changeHandler);
      inputEl.addEventListener('input', inputHandler);

      await tool.execute(
        {
          fields: [{ selector: '#name', value: 'Test' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(changeHandler).toHaveBeenCalledTimes(1);
      expect(inputHandler).toHaveBeenCalledTimes(1);
    });

    it('should dispatch custom trigger event when specified', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" />
        </form>
      `;

      const inputEl = document.querySelector('#name') as HTMLInputElement;
      const blurHandler = vi.fn();
      inputEl.addEventListener('blur', blurHandler);

      // trigger is not in the item schema, bypass validation
      await executeBypassingValidation(tool, {
        fields: [{ selector: '#name', value: 'Test', trigger: 'blur' }],
        formSelector: '#f1',
        validateBeforeSubmit: false,
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(blurHandler).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 5. Form Validation
  // =========================================================================
  describe('Form Validation', () => {
    it('should return valid when all required fields are filled', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" required value="Alice" />
        </form>
      `;

      const validation = await tool.validateForm(1, '#f1');
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should return errors when required fields are empty', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" required value="" />
        </form>
      `;

      const validation = await tool.validateForm(1, '#f1');
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      const fieldError = validation.errors.find(e => e.field === 'name');
      expect(fieldError).toBeDefined();
    });

    it('should detect pattern mismatch', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="zip" name="zip" type="text" pattern="[0-9]{5}" value="abc" />
        </form>
      `;

      const validation = await tool.validateForm(1, '#f1');
      expect(validation.valid).toBe(false);

      // The validateFormInPage implementation has two code paths that catch
      // pattern mismatches: the HTML5 checkValidity path (whose message varies
      // by environment) and the explicit pattern-regex check path whose message
      // contains the word "pattern". At least one error for "zip" must exist.
      const zipErrors = validation.errors.filter(e => e.field === 'zip');
      expect(zipErrors.length).toBeGreaterThan(0);
    });

    it('should pass validation when pattern matches', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="zip" name="zip" type="text" pattern="[0-9]{5}" value="12345" />
        </form>
      `;

      const validation = await tool.validateForm(1, '#f1');
      const zipErrors = validation.errors.filter(e => e.field === 'zip');
      expect(zipErrors).toHaveLength(0);
    });

    it('should return form-not-found error when form selector does not match', async () => {
      document.body.innerHTML = '<div>No form</div>';

      const validation = await tool.validateForm(1, '#nonexistent');
      expect(validation.valid).toBe(false);
      expect(validation.errors[0].field).toBe('form');
      expect(validation.errors[0].message).toBe('Form not found');
    });

    it('should validate before submit when validateBeforeSubmit is true', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="req" name="req" type="text" required value="" />
          <button id="sub" type="submit">Submit</button>
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [],
          formSelector: '#f1',
          validateBeforeSubmit: true,
          submitButton: '#sub',
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      // Should have validation errors and should NOT submit
      expect(result.data.errors.length).toBeGreaterThan(0);
      expect(result.data.submitted).toBe(false);
    });
  });

  // =========================================================================
  // 6. Form Submission
  // =========================================================================
  describe('Form Submission', () => {
    it('should submit form via click method', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" value="Alice" />
          <button id="sub" type="submit">Submit</button>
        </form>
      `;

      const submitBtn = document.querySelector('#sub') as HTMLButtonElement;
      const clickSpy = vi.spyOn(submitBtn, 'click');

      const submitted = await tool.submitForm(1, '#sub', 'click');
      expect(submitted).toBe(true);
      expect(clickSpy).toHaveBeenCalled();
    });

    it('should submit form via javascript method', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input name="name" type="text" value="Alice" />
        </form>
      `;

      const form = document.querySelector('#f1') as HTMLFormElement;
      const submitSpy = vi.spyOn(form, 'submit').mockImplementation(() => {});

      const submitted = await tool.submitForm(1, undefined, 'javascript');
      expect(submitted).toBe(true);
      expect(submitSpy).toHaveBeenCalled();
    });

    it('should submit form via enter method (dispatching submit event)', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input name="name" type="text" value="Alice" />
        </form>
      `;

      const form = document.querySelector('#f1') as HTMLFormElement;
      const submitHandler = vi.fn();
      form.addEventListener('submit', submitHandler);

      const submitted = await tool.submitForm(1, undefined, 'enter');
      expect(submitted).toBe(true);
      expect(submitHandler).toHaveBeenCalled();
    });

    it('should return false when submit button selector matches nothing and no fallback exists', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input name="name" type="text" value="Alice" />
        </form>
      `;

      const submitted = await tool.submitForm(1, '#nonexistent_button', 'click');
      expect(submitted).toBe(false);
    });

    it('should fall back to first submit button when click method button not found', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input name="name" type="text" value="Alice" />
          <input id="fallback" type="submit" value="Go" />
        </form>
      `;

      const fallbackBtn = document.querySelector('#fallback') as HTMLInputElement;
      const clickSpy = vi.spyOn(fallbackBtn, 'click');

      const submitted = await tool.submitForm(1, '#nonexistent_button', 'click');
      expect(submitted).toBe(true);
      expect(clickSpy).toHaveBeenCalled();
    });

    it('should not submit when there are validation errors and submitButton is set', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="req" name="req" type="text" required />
          <button id="sub" type="submit">Submit</button>
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#req', value: '' }],
          formSelector: '#f1',
          validateBeforeSubmit: true,
          submitButton: '#sub',
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.submitted).toBe(false);
    });

    it('should submit when there are no errors and submitButton is set', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" />
          <button id="sub" type="submit">Submit</button>
        </form>
      `;

      const chromeAny = globalThis.chrome as any;
      chromeAny.tabs.get = vi.fn().mockResolvedValue(fakeTab(1, 'https://example.com/thanks'));

      const result = await tool.execute(
        {
          fields: [{ selector: '#name', value: 'Alice' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
          submitButton: '#sub',
          waitAfterSubmit: 0,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.submitted).toBe(true);
    });
  });

  // =========================================================================
  // 7. Error Handling
  // =========================================================================
  describe('Error Handling', () => {
    it('should throw when no tabId and no URL are provided', async () => {
      document.body.innerHTML = '<form><input name="x" type="text" /></form>';

      const result = await tool.execute(
        { fields: [{ selector: '#x', value: 'v' }] } as FormAutomationTask,
        { metadata: {} },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should create a new tab when URL is provided but no tabId', async () => {
      document.body.innerHTML = '<form id="f1"><input id="x" name="x" type="text" /></form>';

      const chromeAny = globalThis.chrome as any;
      chromeAny.tabs.create = vi.fn().mockResolvedValue(fakeTab(99, 'https://example.com/form'));
      chromeAny.tabs.get = vi.fn().mockResolvedValue(fakeTab(99, 'https://example.com/form'));

      const result = await tool.execute(
        {
          url: 'https://example.com/form',
          fields: [{ selector: '#x', value: 'hello' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: {} },
      );

      expect(chromeAny.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/form' }),
      );
      expect(result.success).toBe(true);
    });

    it('should wrap errors in "Form automation failed" message', async () => {
      // Make executeScript throw to simulate a script injection failure
      executeScriptMock.mockRejectedValueOnce(new Error('Script injection blocked'));

      document.body.innerHTML = '<form><input name="x" type="text" /></form>';

      const result = await tool.execute(
        {
          fields: [{ selector: '#x', value: 'v' }],
          formSelector: 'form',
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Form automation failed');
    });

    it('should timeout when referenced form selector does not exist', async () => {
      vi.useFakeTimers();

      document.body.innerHTML = `
        <form id="f1">
          <input id="x" name="x" type="text" />
        </form>
      `;

      const promise = tool.execute(
        {
          fields: [{ selector: '#x', value: 'v' }],
          formSelector: '#missing',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      await vi.advanceTimersByTimeAsync(11000);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout waiting for form');

      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 8. Form Metadata
  // =========================================================================
  describe('Form Metadata', () => {
    it('should include form metadata in the result', async () => {
      document.body.innerHTML = `
        <form id="contact" action="/submit" method="post">
          <input id="name" name="name" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#name', value: 'Alice' }],
          formSelector: '#contact',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata).toBeDefined();
      expect(result.data.metadata.formId).toBe('contact');
      expect(result.data.metadata.formMethod).toBe('post');
      expect(result.data.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return metadata even when form has no id/action', async () => {
      document.body.innerHTML = `
        <form>
          <input id="x" name="x" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#x', value: 'v' }],
          formSelector: 'form',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata).toBeDefined();
      expect(result.data.metadata.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 9. Multi-Step Forms (via validation bypass since schema lacks "steps")
  // =========================================================================
  describe('Multi-Step Forms', () => {
    it('should fill fields across multiple steps', async () => {
      document.body.innerHTML = `
        <form id="wizard">
          <div id="step1">
            <input id="name" name="name" type="text" />
          </div>
          <div id="step2">
            <input id="email_field" name="email_field" type="email" />
          </div>
          <button id="next" type="button">Next</button>
        </form>
      `;

      const result = await executeBypassingValidation(tool, {
        fields: [],
        formSelector: '#wizard',
        steps: [
          {
            name: 'Step 1',
            trigger: 'auto' as const,
            fields: [{ selector: '#name', value: 'Alice' }],
          },
          {
            name: 'Step 2',
            trigger: 'auto' as const,
            fields: [{ selector: '#email_field', value: 'alice@test.com' }],
          },
        ],
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(result.success).toBe(true);
      expect(result.data.filledFields).toContain('#name');
      expect(result.data.filledFields).toContain('#email_field');
      expect(result.data.submitted).toBe(true); // All steps completed
    });

    it('should click the trigger selector for click-trigger steps', async () => {
      document.body.innerHTML = `
        <form id="wizard">
          <input id="name" name="name" type="text" />
          <button id="next" type="button">Next</button>
        </form>
      `;

      const nextBtn = document.querySelector('#next') as HTMLButtonElement;
      const clickSpy = vi.spyOn(nextBtn, 'click');

      await executeBypassingValidation(tool, {
        fields: [],
        formSelector: '#wizard',
        steps: [
          {
            name: 'Step 1',
            trigger: 'click' as const,
            selector: '#next',
            fields: [{ selector: '#name', value: 'Alice' }],
          },
        ],
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(clickSpy).toHaveBeenCalled();
    });

    it('should stop on step validation failure', async () => {
      document.body.innerHTML = `
        <form id="wizard">
          <input id="name" name="name" type="text" />
          <input id="email_field" name="email_field" type="email" />
        </form>
      `;

      const result = await executeBypassingValidation(tool, {
        fields: [],
        formSelector: '#wizard',
        steps: [
          {
            name: 'Step 1',
            trigger: 'auto' as const,
            fields: [{ selector: '#name', value: 'Alice' }],
            validation: () => false,
          },
          {
            name: 'Step 2',
            trigger: 'auto' as const,
            fields: [{ selector: '#email_field', value: 'alice@test.com' }],
          },
        ],
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(result.success).toBe(true);
      // The result.data is the FormResult from executeMultiStepForm
      expect(result.data.success).toBe(false);
      expect(result.data.errors.length).toBeGreaterThan(0);
      expect(result.data.errors[0].message).toContain('Step 1 validation failed');
      // Step 2 should NOT have been filled
      expect(result.data.filledFields).not.toContain('#email_field');
    });

    it('should report submitted=false when steps do not all complete', async () => {
      document.body.innerHTML = `
        <form id="wizard">
          <input id="name" name="name" type="text" />
          <input id="x" name="x" type="text" />
        </form>
      `;

      const result = await executeBypassingValidation(tool, {
        fields: [],
        formSelector: '#wizard',
        steps: [
          {
            name: 'Step 1',
            trigger: 'auto' as const,
            fields: [{ selector: '#name', value: 'Alice' }],
            validation: () => false,
          },
          {
            name: 'Step 2',
            trigger: 'auto' as const,
            fields: [{ selector: '#x', value: 'val' }],
          },
        ],
      } as FormAutomationTask, { metadata: { tabId: 1 } });

      expect(result.success).toBe(true);
      expect(result.data.submitted).toBe(false);
    });
  });

  // =========================================================================
  // 10. Auto-Detect Integration
  // =========================================================================
  describe('Auto-Detect Fields', () => {
    it('should auto-detect and map fields when autoDetect is true and fields array is empty', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="name" name="name" type="text" />
          <input id="em" name="email" type="email" />
        </form>
      `;

      const result = await tool.execute(
        {
          autoDetect: true,
          fields: [
            { name: 'name', value: 'Alice' },
            { name: 'email', value: 'alice@test.com' },
          ],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // 11. Edge Cases
  // =========================================================================
  describe('Edge Cases', () => {
    it('should handle a form with no fields gracefully', async () => {
      document.body.innerHTML = '<form id="f1"></form>';

      const fields = await tool.detectFields(1, '#f1');
      expect(fields).toEqual([]);
    });

    it('should handle field with neither name nor id', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input type="text" placeholder="Enter something" />
        </form>
      `;

      const fields = await tool.detectFields(1, '#f1');
      expect(fields.length).toBe(1);
      expect(fields[0].name).toBe('');
    });

    it('should detect submit/button input types', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="txt" name="txt" type="text" />
          <input id="sub" name="sub" type="submit" value="Go" />
          <input id="btn" name="btn" type="button" value="Click" />
        </form>
      `;

      const fields = await tool.detectFields(1, '#f1');
      const types = fields.map(f => f.type);
      expect(types).toContain('text');
      expect(types).toContain('submit');
      expect(types).toContain('button');
    });

    it('should use default formSelector "form" when none is specified', async () => {
      document.body.innerHTML = `
        <form>
          <input id="x" name="x" type="text" />
        </form>
      `;

      const fields = await tool.detectFields(1);
      expect(fields.length).toBe(1);
    });

    it('should handle empty fields array without errors', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="x" name="x" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.filledFields).toEqual([]);
      expect(result.data.errors).toEqual([]);
    });

    it('should include duration in result metadata', async () => {
      document.body.innerHTML = `
        <form id="f1">
          <input id="x" name="x" type="text" />
        </form>
      `;

      const result = await tool.execute(
        {
          fields: [{ selector: '#x', value: 'v' }],
          formSelector: '#f1',
          validateBeforeSubmit: false,
        } as FormAutomationTask,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(typeof result.data.metadata.duration).toBe('number');
      expect(result.data.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('should reject unknown top-level parameters', async () => {
      const result = await tool.execute(
        {
          fields: [],
          unknownProp: 'value',
        } as any,
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown parameter');
    });
  });
});
