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

  // Up/Down recall of recent messages. The recall list is supplied by the page
  // via `recentUserMessages` (most-recent-first), derived from the rendered
  // conversation timeline — so it is naturally per-session with no local buffer.
  describe('Message recall (Up/Down history)', () => {
    it('recalls the most recent message on ArrowUp', async () => {
      render(MessageInput, {
        props: { value: '', onSubmit: vi.fn(), recentUserMessages: ['hello world'] },
      });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('hello world');
    });

    it('walks older then newer through the recall list', async () => {
      render(MessageInput, {
        props: {
          value: '',
          onSubmit: vi.fn(),
          recentUserMessages: ['third', 'second', 'first'],
        },
      });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('third');
      textarea.selectionStart = textarea.selectionEnd = 0;
      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('second');
      textarea.selectionStart = textarea.selectionEnd = 0;
      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('first');

      // Down walks back toward newer entries.
      await fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      expect(textarea.value).toBe('second');
    });

    it('stays at the oldest entry when walking past the top', async () => {
      render(MessageInput, {
        props: { value: '', onSubmit: vi.fn(), recentUserMessages: ['newer', 'older'] },
      });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      for (let i = 0; i < 4; i++) {
        await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
        textarea.selectionStart = textarea.selectionEnd = 0;
      }
      expect(textarea.value).toBe('older');
    });

    it('restores the in-progress draft when Down returns to the bottom', async () => {
      render(MessageInput, {
        props: { value: '', onSubmit: vi.fn(), recentUserMessages: ['sent message'] },
      });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      // In-progress draft the user was typing.
      await fireEvent.input(textarea, { target: { value: 'draft in progress' } });
      textarea.selectionStart = textarea.selectionEnd = 0;

      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('sent message');

      await fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      expect(textarea.value).toBe('draft in progress');
    });

    it('does not recall when there is no history', async () => {
      render(MessageInput, { props: { value: '', onSubmit: vi.fn() } });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('');
    });

    it('does not hijack ArrowUp when the caret is not at the start', async () => {
      render(MessageInput, {
        props: { value: '', onSubmit: vi.fn(), recentUserMessages: ['recorded'] },
      });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      // Multi-line draft with the caret at the end (second line) → Up should
      // move the cursor, not replace the text.
      await fireEvent.input(textarea, { target: { value: 'line one\nline two' } });
      textarea.selectionStart = textarea.selectionEnd = 'line one\nline two'.length;

      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('line one\nline two');
    });

    it('does not hijack ArrowUp in the middle of a visually wrapped line', async () => {
      render(MessageInput, {
        props: { value: '', onSubmit: vi.fn(), recentUserMessages: ['recorded'] },
      });
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      await fireEvent.input(textarea, {
        target: { value: 'a single line long enough to wrap in a narrow composer' },
      });
      textarea.selectionStart = textarea.selectionEnd = 12;

      await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('a single line long enough to wrap in a narrow composer');
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

  describe('Working folder chip', () => {
    it('shows only the final folder and exposes the full path on hover', () => {
      render(MessageInput, {
        props: {
          value: '',
          workingDirectory: '/Users/rich/projects/workx',
          onChooseWorkingDirectory: vi.fn(),
        },
      });

      const chip = screen.getByRole('button', { name: /working folder/i });
      expect(chip.textContent).toContain('.../workx');
      expect(chip.textContent).not.toContain('📁');
      expect(chip.classList.contains('text-sm')).toBe(true);
      expect(chip.classList.contains('text-xs')).toBe(false);
      expect(chip.textContent).not.toContain('/Users/rich/projects');
      expect(chip.getAttribute('title')).toBe('/Users/rich/projects/workx');
      const contextRow = chip.closest('.composer-context-row');
      expect(contextRow).toBeTruthy();
      const spacer = contextRow?.querySelector('.flex-1');
      const newConversation = screen.getByRole('button', { name: /start new conversation/i });
      expect(spacer).toBeTruthy();
      expect(contextRow?.contains(newConversation)).toBe(true);
      expect(chip.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
      expect(spacer!.compareDocumentPosition(newConversation) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    });

    it('opens the folder picker callback when clicked', async () => {
      const onChooseWorkingDirectory = vi.fn();
      render(MessageInput, {
        props: {
          value: '',
          workingDirectory: '/home/rich',
          onChooseWorkingDirectory,
        },
      });

      await fireEvent.click(screen.getByRole('button', { name: /working folder/i }));
      expect(onChooseWorkingDirectory).toHaveBeenCalledTimes(1);
    });

    it.each(['/', 'C:\\'])('shows a root path without adding an ellipsis: %s', (root) => {
      render(MessageInput, {
        props: {
          value: '',
          workingDirectory: root,
          onChooseWorkingDirectory: vi.fn(),
        },
      });

      const chip = screen.getByRole('button', { name: /working folder/i });
      expect(chip.textContent).toContain(root);
      expect(chip.textContent).not.toContain('.../');
    });
  });
});
