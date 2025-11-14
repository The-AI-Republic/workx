/**
 * FormAutomationTool - Smart form detection and automation
 *
 * Provides intelligent form field detection, multi-step form support,
 * validation handling, and automated form submission.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from './BaseTool';

/**
 * Form field types
 */
export type FormFieldType = 'text' | 'email' | 'password' | 'tel' | 'number' | 'date' |
  'select' | 'checkbox' | 'radio' | 'textarea' | 'file' | 'submit' | 'button';

/**
 * Form field definition
 */
export interface FormField {
  name: string;
  id?: string;
  type: FormFieldType;
  label?: string;
  required: boolean;
  value?: any;
  options?: string[]; // for select/radio
  validation?: string; // regex pattern
  placeholder?: string;
  selector?: string;
}

/**
 * Form field mapping for filling
 */
export interface FormFieldMapping {
  name?: string;
  selector?: string;
  type?: FormFieldType;
  value: any;
  required?: boolean;
  validation?: string;
  trigger?: 'change' | 'input' | 'blur';
}

/**
 * Form automation task configuration
 */
export interface FormAutomationTask extends BaseToolRequest {
  url?: string;
  formSelector?: string;
  autoDetect?: boolean;
  fields: FormFieldMapping[];
  steps?: FormStep[];
  submitButton?: string;
  submitMethod?: 'click' | 'enter' | 'javascript';
  validateBeforeSubmit?: boolean;
  waitAfterSubmit?: number;
  successIndicator?: string;
  errorIndicator?: string;
}

/**
 * Multi-step form configuration
 */
export interface FormStep {
  name: string;
  trigger: 'auto' | 'click' | 'wait';
  selector?: string;
  delay?: number;
  fields: FormFieldMapping[];
  validation?: (result: any) => boolean;
}

/**
 * Form automation result
 */
export interface FormResult {
  success: boolean;
  filledFields: string[];
  errors: FieldError[];
  submitted: boolean;
  responseUrl?: string;
  validationErrors?: string[];
  metadata?: {
    formId?: string;
    formAction?: string;
    formMethod?: string;
    duration: number;
  };
}

/**
 * Field-specific error
 */
export interface FieldError {
  field: string;
  message: string;
  value?: any;
}

/**
 * Form validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: FieldError[];
  warnings?: string[];
}

/**
 * FormAutomationTool implementation
 */
export class FormAutomationTool extends BaseTool {
  protected toolDefinition: ToolDefinition;

  constructor() {
    super();

    this.toolDefinition = createToolDefinition(
      'form_automation',
      'Automate form detection, filling, and submission',
      {
        url: {
          type: 'string',
          description: 'URL to navigate to (optional if tab is already bound to session)',
        },
        formSelector: {
          type: 'string',
          description: 'CSS selector for the form',
          default: 'form',
        },
        autoDetect: {
          type: 'boolean',
          description: 'Automatically detect form fields',
          default: true,
        },
        fields: {
          type: 'array',
          description: 'Fields to fill',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
              type: { type: 'string' }
            }
          },
        },
        submitButton: {
          type: 'string',
          description: 'Selector for submit button',
        },
        submitMethod: {
          type: 'string',
          description: 'Method to submit form',
          enum: ['click', 'enter', 'javascript'],
          default: 'click',
        },
        validateBeforeSubmit: {
          type: 'boolean',
          description: 'Validate form before submission',
          default: true,
        },
        waitAfterSubmit: {
          type: 'number',
          description: 'Wait time after submission (ms)',
          default: 2000,
        }
      },
      {
        required: ['fields'],
        category: 'browser',
        metadata: {
          permissions: ['tabs', 'scripting', 'activeTab'],
        },
      }
    );
  }

  /**
   * Execute form automation
   */
  protected async executeImpl(
    request: FormAutomationTask,
    options?: BaseToolOptions
  ): Promise<FormResult> {
    const startTime = Date.now();
    const errors: FieldError[] = [];
    const filledFields: string[] = [];

    try {
      // Get tabId from metadata (passed internally, not from LLM)
      const tabId = options?.metadata?.tabId;

      // Get target tab
      const tab = await this.getTab(tabId, request.url);

      // Wait for form to be ready
      if (request.formSelector) {
        await this.waitForForm(tab.id!, request.formSelector);
      }

      // Auto-detect fields if requested
      let fields = request.fields;
      if (request.autoDetect && (!fields || fields.length === 0)) {
        const detected = await this.detectFields(tab.id!, request.formSelector);
        fields = this.mapDetectedFields(detected, request.fields);
      }

      // Handle multi-step forms
      if (request.steps && request.steps.length > 0) {
        return await this.executeMultiStepForm(tab.id!, request.steps);
      }

      // Fill form fields
      const fillResult = await this.fillFields(tab.id!, fields, request.formSelector);
      filledFields.push(...fillResult.filled);
      errors.push(...fillResult.errors);

      // Validate if requested
      let validationErrors: string[] = [];
      if (request.validateBeforeSubmit) {
        const validation = await this.validateForm(tab.id!, request.formSelector);
        if (!validation.valid) {
          validationErrors = validation.errors.map(e => e.message);
          errors.push(...validation.errors);
        }
      }

      // Submit form if requested
      let submitted = false;
      let responseUrl: string | undefined;
      if (request.submitButton && errors.length === 0) {
        submitted = await this.submitForm(
          tab.id!,
          request.submitButton,
          request.submitMethod || 'click'
        );

        if (submitted && request.waitAfterSubmit) {
          await new Promise(resolve => setTimeout(resolve, request.waitAfterSubmit));

          // Check for success/error indicators
          if (request.successIndicator) {
            await this.waitForIndicator(tab.id!, request.successIndicator, 5000);
          }

          // Get final URL
          const updatedTab = await chrome.tabs.get(tab.id!);
          responseUrl = updatedTab.url;
        }
      }

      // Get form metadata
      const metadata = await this.getFormMetadata(tab.id!, request.formSelector);

      return {
        success: errors.length === 0 && (!request.submitButton || submitted),
        filledFields,
        errors,
        submitted,
        responseUrl,
        validationErrors,
        metadata: {
          ...metadata,
          duration: Date.now() - startTime,
        },
      };

    } catch (error) {
      throw new Error(`Form automation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get or navigate to tab
   */
  private async getTab(tabId?: number, url?: string): Promise<chrome.tabs.Tab> {
    if (tabId !== undefined && tabId !== null && tabId !== -1) {
      return await this.validateTabId(tabId);
    }

    if (url) {
      const tab = await chrome.tabs.create({ url, active: false });

      // Note: Tab will be added to group automatically when bound to session via TabManager

      return tab;
    }

    throw new Error('Target tab ID not provided in execution context and no URL specified');
  }

  /**
   * Wait for form to be present
   */
  private async waitForForm(tabId: number, selector?: string): Promise<void> {
    const formSelector = selector || 'form';
    const timeout = 10000;
    const endTime = Date.now() + timeout;

    while (Date.now() < endTime) {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => !!document.querySelector(sel),
        args: [formSelector],
      });

      if (result[0]?.result) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for form: ${formSelector}`);
  }

  /**
   * Detect form fields automatically
   */
  async detectFields(tabId: number, formSelector?: string): Promise<FormField[]> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: this.detectFieldsInPage,
      args: [formSelector || 'form'],
    });

    return result[0]?.result || [];
  }

  /**
   * Function executed in page context to detect fields
   */
  private detectFieldsInPage(formSelector: string): FormField[] {
    const form = document.querySelector(formSelector) as HTMLFormElement;
    if (!form) return [];

    const fields: FormField[] = [];
    const inputs = form.querySelectorAll('input, select, textarea');

    inputs.forEach((element) => {
      const field = extractFieldInfo(element);
      if (field) {
        fields.push(field);
      }
    });

    return fields;

    function extractFieldInfo(element: Element): FormField | null {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

      // Skip hidden and submit buttons
      if (input.type === 'hidden') return null;

      const field: FormField = {
        name: input.name || input.id || '',
        id: input.id || undefined,
        type: detectFieldType(input),
        label: findLabel(input),
        required: input.hasAttribute('required'),
        value: input.value || undefined,
        placeholder: (input as HTMLInputElement).placeholder || undefined,
        selector: generateSelector(input),
      };

      // Get options for select/radio
      if (input.tagName === 'SELECT') {
        const select = input as HTMLSelectElement;
        field.options = Array.from(select.options).map(opt => opt.value);
      }

      // Get validation pattern
      if ('pattern' in input && input.pattern) {
        field.validation = input.pattern;
      }

      return field;
    }

    function detectFieldType(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): FormFieldType {
      if (input.tagName === 'SELECT') return 'select';
      if (input.tagName === 'TEXTAREA') return 'textarea';

      const type = (input as HTMLInputElement).type;
      const name = input.name?.toLowerCase() || '';
      const id = input.id?.toLowerCase() || '';
      const placeholder = (input as HTMLInputElement).placeholder?.toLowerCase() || '';

      // Smart type detection based on attributes
      if (type === 'email' || name.includes('email') || id.includes('email')) {
        return 'email';
      }
      if (type === 'password' || name.includes('password') || id.includes('password')) {
        return 'password';
      }
      if (type === 'tel' || name.includes('phone') || id.includes('phone')) {
        return 'tel';
      }
      if (type === 'number' || name.includes('number') || name.includes('amount')) {
        return 'number';
      }
      if (type === 'date' || name.includes('date')) {
        return 'date';
      }
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
      if (type === 'submit' || type === 'button') return type as FormFieldType;

      return 'text';
    }

    function findLabel(input: HTMLElement): string | undefined {
      // Check for explicit label
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label) return label.textContent?.trim();
      }

      // Check parent label
      const parentLabel = input.closest('label');
      if (parentLabel) {
        return parentLabel.textContent?.trim();
      }

      // Check previous sibling
      const prev = input.previousElementSibling;
      if (prev?.tagName === 'LABEL') {
        return prev.textContent?.trim();
      }

      // Use placeholder as fallback
      return (input as HTMLInputElement).placeholder || input.name || undefined;
    }

    function generateSelector(element: HTMLElement): string {
      if (element.id) return `#${element.id}`;
      if (element.name) return `[name="${element.name}"]`;

      // Generate path-based selector
      const path = [];
      let current = element;
      while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.className) {
          selector += '.' + current.className.split(' ').join('.');
        }
        path.unshift(selector);
        current = current.parentElement!;
      }
      return path.join(' > ');
    }
  }

  /**
   * Map detected fields to field mappings
   */
  private mapDetectedFields(detected: FormField[], userFields: FormFieldMapping[]): FormFieldMapping[] {
    const mapped: FormFieldMapping[] = [];

    // Create a map of user-provided values
    const userValueMap = new Map<string, any>();
    userFields.forEach(field => {
      if (field.name) userValueMap.set(field.name, field.value);
      if (field.selector) userValueMap.set(field.selector, field.value);
    });

    // Map detected fields
    detected.forEach(field => {
      let value = userValueMap.get(field.name) ||
                  userValueMap.get(field.selector || '') ||
                  userValueMap.get(field.id || '');

      if (value !== undefined) {
        mapped.push({
          selector: field.selector,
          name: field.name,
          type: field.type,
          value: value,
          required: field.required,
          validation: field.validation,
        });
      }
    });

    return mapped;
  }

  /**
   * Fill form fields
   */
  private async fillFields(
    tabId: number,
    fields: FormFieldMapping[],
    formSelector?: string
  ): Promise<{ filled: string[]; errors: FieldError[] }> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: this.fillFieldsInPage,
      args: [fields, formSelector],
    });

    return result[0]?.result || { filled: [], errors: [] };
  }

  /**
   * Function executed in page context to fill fields
   */
  private fillFieldsInPage(
    fields: FormFieldMapping[],
    formSelector?: string
  ): { filled: string[]; errors: FieldError[] } {
    const filled: string[] = [];
    const errors: FieldError[] = [];
    const form = formSelector ? document.querySelector(formSelector) : document;

    if (!form) {
      errors.push({ field: 'form', message: 'Form not found' });
      return { filled, errors };
    }

    fields.forEach(field => {
      try {
        const element = field.selector
          ? form.querySelector(field.selector) as HTMLInputElement
          : field.name
          ? form.querySelector(`[name="${field.name}"]`) as HTMLInputElement
          : null;

        if (!element) {
          errors.push({
            field: field.name || field.selector || 'unknown',
            message: 'Field not found',
          });
          return;
        }

        // Fill based on field type
        const fieldType = field.type || element.type || 'text';

        switch (fieldType) {
          case 'checkbox':
            (element as HTMLInputElement).checked = !!field.value;
            break;

          case 'radio':
            if (element.value === field.value) {
              (element as HTMLInputElement).checked = true;
            }
            break;

          case 'select':
            (element as HTMLSelectElement).value = field.value;
            break;

          case 'file':
            // File inputs cannot be programmatically filled for security
            errors.push({
              field: field.name || field.selector || 'file',
              message: 'File inputs cannot be programmatically filled',
            });
            return;

          default:
            element.value = field.value;
        }

        // Trigger events
        const trigger = field.trigger || 'change';
        element.dispatchEvent(new Event(trigger, { bubbles: true }));
        element.dispatchEvent(new Event('input', { bubbles: true }));

        filled.push(field.name || field.selector || element.name || element.id);

      } catch (error) {
        errors.push({
          field: field.name || field.selector || 'unknown',
          message: error instanceof Error ? error.message : 'Failed to fill field',
        });
      }
    });

    return { filled, errors };
  }

  /**
   * Validate form before submission
   */
  async validateForm(tabId: number, formSelector?: string): Promise<ValidationResult> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: this.validateFormInPage,
      args: [formSelector],
    });

    return result[0]?.result || { valid: false, errors: [] };
  }

  /**
   * Function executed in page context to validate form
   */
  private validateFormInPage(formSelector?: string): ValidationResult {
    const errors: FieldError[] = [];
    const warnings: string[] = [];

    const form = (formSelector ? document.querySelector(formSelector) : document.querySelector('form')) as HTMLFormElement;

    if (!form) {
      return { valid: false, errors: [{ field: 'form', message: 'Form not found' }] };
    }

    // Check HTML5 validation
    if (!form.checkValidity()) {
      const inputs = form.querySelectorAll('input, select, textarea');
      inputs.forEach(input => {
        const element = input as HTMLInputElement;
        if (!element.checkValidity()) {
          errors.push({
            field: element.name || element.id || 'unknown',
            message: element.validationMessage,
            value: element.value,
          });
        }
      });
    }

    // Check required fields
    const requiredFields = form.querySelectorAll('[required]');
    requiredFields.forEach(field => {
      const input = field as HTMLInputElement;
      if (!input.value || input.value.trim() === '') {
        errors.push({
          field: input.name || input.id || 'unknown',
          message: 'Required field is empty',
        });
      }
    });

    // Check pattern validation
    const patternFields = form.querySelectorAll('[pattern]');
    patternFields.forEach(field => {
      const input = field as HTMLInputElement;
      if (input.value && input.pattern) {
        const regex = new RegExp(input.pattern);
        if (!regex.test(input.value)) {
          errors.push({
            field: input.name || input.id || 'unknown',
            message: `Value does not match required pattern: ${input.pattern}`,
            value: input.value,
          });
        }
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Submit form
   */
  async submitForm(
    tabId: number,
    submitButton?: string,
    method: 'click' | 'enter' | 'javascript' = 'click'
  ): Promise<boolean> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: this.submitFormInPage,
      args: [submitButton, method],
    });

    return result[0]?.result || false;
  }

  /**
   * Function executed in page context to submit form
   */
  private submitFormInPage(
    submitButton?: string,
    method: 'click' | 'enter' | 'javascript' = 'click'
  ): boolean {
    try {
      if (method === 'javascript') {
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) {
          form.submit();
          return true;
        }
      } else if (method === 'click' && submitButton) {
        const button = document.querySelector(submitButton) as HTMLElement;
        if (button) {
          button.click();
          return true;
        }
      } else if (method === 'enter') {
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) {
          const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
          form.dispatchEvent(submitEvent);
          return true;
        }
      }

      // Fallback: look for submit button
      const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]') as HTMLElement;
      if (submitBtn) {
        submitBtn.click();
        return true;
      }

      return false;
    } catch (error) {
      console.error('Form submission error:', error);
      return false;
    }
  }

  /**
   * Execute multi-step form
   */
  private async executeMultiStepForm(tabId: number, steps: FormStep[]): Promise<FormResult> {
    const filled: string[] = [];
    const errors: FieldError[] = [];
    let currentStep = 0;

    for (const step of steps) {
      try {
        // Fill fields for this step
        const stepResult = await this.fillFields(tabId, step.fields);
        filled.push(...stepResult.filled);
        errors.push(...stepResult.errors);

        // Trigger next step
        if (step.trigger === 'click' && step.selector) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) element.click();
            },
            args: [step.selector],
          });
        }

        // Wait if specified
        if (step.delay) {
          await new Promise(resolve => setTimeout(resolve, step.delay));
        }

        // Run validation if provided
        if (step.validation) {
          const valid = await step.validation({ filled, errors });
          if (!valid) {
            errors.push({
              field: `step_${currentStep}`,
              message: `Step ${step.name} validation failed`,
            });
            break;
          }
        }

        currentStep++;
      } catch (error) {
        errors.push({
          field: `step_${currentStep}`,
          message: error instanceof Error ? error.message : 'Step execution failed',
        });
        break;
      }
    }

    return {
      success: errors.length === 0,
      filledFields: filled,
      errors,
      submitted: currentStep === steps.length,
    };
  }

  /**
   * Wait for success/error indicator
   */
  private async waitForIndicator(tabId: number, selector: string, timeout: number): Promise<boolean> {
    const endTime = Date.now() + timeout;

    while (Date.now() < endTime) {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => !!document.querySelector(sel),
        args: [selector],
      });

      if (result[0]?.result) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false;
  }

  /**
   * Get form metadata
   */
  private async getFormMetadata(tabId: number, formSelector?: string): Promise<any> {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const form = (sel ? document.querySelector(sel) : document.querySelector('form')) as HTMLFormElement;
        if (!form) return {};

        return {
          formId: form.id,
          formAction: form.action,
          formMethod: form.method,
        };
      },
      args: [formSelector],
    });

    return result[0]?.result || {};
  }
}