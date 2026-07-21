import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import UserLoginStatus from '../UserLoginStatus.svelte';
import { userStore } from '../../../stores/userStore';

describe('UserLoginStatus folded navigation', () => {
  afterEach(() => {
    userStore.reset();
  });

  it('renders each shared user-center destination once', async () => {
    userStore.setUser({ name: 'Test User', email: 'test@example.com' });
    const { container } = render(UserLoginStatus);
    const trigger = container.querySelector<HTMLElement>('[aria-haspopup="true"]');

    expect(trigger).not.toBeNull();
    await fireEvent.click(trigger!);

    await waitFor(() => {
      expect(screen.getAllByRole('menuitem', { name: 'Usage' })).toHaveLength(1);
      expect(screen.getAllByRole('menuitem', { name: 'Settings' })).toHaveLength(1);
    });
  });
});
