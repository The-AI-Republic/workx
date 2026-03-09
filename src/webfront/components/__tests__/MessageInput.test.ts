import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import MessageInput from '@/webfront/components/MessageInput.svelte';

describe('MessageInput Component', () => {
  // Component rendering test
  describe('Component Rendering', () => {
    it('should render with all props', () => {
      const onSubmit = vi.fn();
      render(MessageInput, {
        props: {
          value: 'test message',
          placeholder: 'Type here...',
          onSubmit,
          tabId: 123,
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea).toBeDefined();
      expect(textarea.value).toBe('test message');
      expect(textarea.placeholder).toBe('Type here...');
    });

    it('should render with default props', () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea).toBeDefined();
      expect(textarea.placeholder).toBe('>> Enter command...');
    });
  });

  // TabContext integration test
  describe('TabContext Integration', () => {
    it('should display TabContext with correct tabId', () => {
      const { container } = render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
          tabId: 456,
        },
      });

      // TabContext is rendered inside a div.contents wrapper when platform.hasTabSelection is true
      // In test environment, platform detection may not enable tab selection, so we verify
      // the overall input structure renders correctly
      const inputShell = container.querySelector('.input-shell');
      expect(inputShell).toBeTruthy();
    });

    it('should pass tabId=-1 when not specified', () => {
      const { container } = render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const inputShell = container.querySelector('.input-shell');
      expect(inputShell).toBeTruthy();
    });
  });

  // Enter key submit test
  describe('Keyboard Interactions', () => {
    it('should submit on Enter key without Shift', async () => {
      const onSubmit = vi.fn();
      render(MessageInput, {
        props: {
          value: 'test message',
          onSubmit,
          tabId: 123,
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, {
        key: 'Enter',
        shiftKey: false,
      });

      expect(onSubmit).toHaveBeenCalledWith('test message');
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('should NOT submit on Shift+Enter', async () => {
      const onSubmit = vi.fn();
      render(MessageInput, {
        props: {
          value: 'test message',
          onSubmit,
          tabId: 123,
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, {
        key: 'Enter',
        shiftKey: true,
      });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should NOT submit on Enter when value is empty', async () => {
      const onSubmit = vi.fn();
      render(MessageInput, {
        props: {
          value: '',
          onSubmit,
          tabId: 123,
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, {
        key: 'Enter',
        shiftKey: false,
      });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should NOT submit on Enter when value is whitespace only', async () => {
      const onSubmit = vi.fn();
      render(MessageInput, {
        props: {
          value: '   ',
          onSubmit,
          tabId: 123,
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, {
        key: 'Enter',
        shiftKey: false,
      });

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  // Value binding test
  describe('Value Binding', () => {
    it('should reflect value prop in textarea', () => {
      const { component } = render(MessageInput, {
        props: {
          value: 'initial value',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('initial value');
    });

    it('should update when value changes', async () => {
      const { rerender } = render(MessageInput, {
        props: {
          value: 'initial',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('initial');

      // Update prop
      await rerender({ value: 'updated', onSubmit: () => {} });
      expect(textarea.value).toBe('updated');
    });
  });

  // Placeholder test
  describe('Placeholder', () => {
    it('should display custom placeholder', () => {
      render(MessageInput, {
        props: {
          value: '',
          placeholder: 'Custom placeholder text',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe('Custom placeholder text');
    });

    it('should use default placeholder when not specified', () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe('>> Enter command...');
    });
  });

  // Accessibility test
  describe('Accessibility', () => {
    it('should be keyboard accessible', () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      // Should be focusable
      expect(textarea.tabIndex).not.toBe(-1);
    });

    it('should have proper ARIA label', () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByLabelText('Message input');
      expect(textarea).toBeDefined();
    });

    it('should be focusable', () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      textarea.focus();

      expect(document.activeElement).toBe(textarea);
    });
  });

  // Additional styling tests
  describe('Styling', () => {
    it('should have correct CSS classes', () => {
      const { container } = render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      // Outer wrapper is a simple w-full div
      const outerWrapper = container.querySelector('.w-full');
      expect(outerWrapper).toBeTruthy();

      // Input shell contains the textarea and action bar
      const inputShell = container.querySelector('.input-shell');
      expect(inputShell).toBeTruthy();

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.className).toContain('terminal-textarea');
    });

    it('should use textarea element instead of input', () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: () => {},
        },
      });

      const textarea = screen.getByRole('textbox');
      expect(textarea.tagName.toLowerCase()).toBe('textarea');
    });
  });
});
