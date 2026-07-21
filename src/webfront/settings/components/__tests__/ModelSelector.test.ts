import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelSelector from '../ModelSelector.svelte';

vi.mock('@/webfront/lib/modelAccessPolicy', () => ({
  modelAccessPolicy: {
    isLocked: (_subject: unknown, target: { isCustom?: boolean }) =>
      !target.isCustom,
    getPreferredModelId: () => null,
    lockedCopy: {
      chatInline: 'Loading...',
      chatTooltip: 'Loading...',
      settingsTooltip: 'Loading...',
    },
  },
}));

const sharedModel = {
  modelName: 'Shared name',
  modelKey: 'shared-model',
  organization: null,
  apiKey: null,
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  baseUrl: 'https://example.test/v1',
  selected: false,
};

describe('ModelSelector access policy', () => {
  it('keeps a custom provider selectable in a mixed locked group', async () => {
    const onModelChange = vi.fn();
    const { container, getByRole } = render(ModelSelector, {
      props: {
        selectedModel: '',
        modelSelectionItems: [
          {
            ...sharedModel,
            modelId: 'builtin:shared-model',
            providerId: 'builtin',
            providerName: 'Built in',
            isCustom: false,
          },
          {
            ...sharedModel,
            modelId: 'custom:shared-model',
            providerId: 'custom',
            providerName: 'Custom',
            isCustom: true,
          },
        ],
        onModelChange,
      },
    });

    await fireEvent.click(container.querySelector('.model-selector > button')!);

    const builtIn = getByRole('button', { name: 'Built in' });
    const custom = getByRole('button', { name: 'Custom' });
    expect(builtIn.getAttribute('aria-disabled')).toBe('true');
    expect(custom.getAttribute('aria-disabled')).toBe('false');

    await fireEvent.click(builtIn);
    expect(onModelChange).not.toHaveBeenCalled();

    await fireEvent.click(custom);
    expect(onModelChange).toHaveBeenCalledWith({
      modelId: 'custom:shared-model',
    });
  });

  it('does not allow keyboard selection to bypass a provider lock', async () => {
    const onModelChange = vi.fn();
    const { container } = render(ModelSelector, {
      props: {
        selectedModel: '',
        modelSelectionItems: [
          {
            ...sharedModel,
            modelId: 'builtin:shared-model',
            providerId: 'builtin',
            providerName: 'Built in',
            isCustom: false,
          },
        ],
        onModelChange,
      },
    });

    const selector = container.querySelector('.model-selector')!;
    await fireEvent.keyDown(selector, { key: 'ArrowDown' });
    await fireEvent.keyDown(selector, { key: 'Enter' });
    expect(onModelChange).not.toHaveBeenCalled();
  });
});
