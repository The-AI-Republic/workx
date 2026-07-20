import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MoreMenu from '../MoreMenu.svelte';

describe('MoreMenu folded navigation', () => {
  it('renders each shared destination once', async () => {
    render(MoreMenu);
    await fireEvent.click(screen.getByRole('button', { name: 'More' }));

    await waitFor(() => {
      expect(screen.getAllByRole('menuitem', { name: 'Usage' })).toHaveLength(1);
      expect(screen.getAllByRole('menuitem', { name: 'Settings' })).toHaveLength(1);
    });
  });
});
