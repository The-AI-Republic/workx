import { tick } from 'svelte';

/**
 * Scroll to and highlight a setting element by its ID.
 * Looks up by `id` attribute first, then by `data-setting-id`.
 * Applies a pulse animation on the closest card/group container.
 *
 * @param settingId - The element ID or data-setting-id to find
 * @param expandCollapsed - Optional async callback to expand collapsed sections before retrying
 */
export async function highlightSetting(
  settingId: string,
  expandCollapsed?: () => Promise<void>,
): Promise<void> {
  await tick();

  let el = findElement(settingId);

  if (!el && expandCollapsed) {
    await expandCollapsed();
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    el = findElement(settingId);
  }

  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const target = el.closest('.settings-card') || el.closest('.setting-section') || el.closest('.form-group') || el;
    target.classList.add('highlight-pulse');
    setTimeout(() => target.classList.remove('highlight-pulse'), 1500);
  }
}

function findElement(settingId: string): Element | null {
  return (
    document.getElementById(settingId) ||
    document.querySelector(`[data-setting-id="${settingId}"]`)
  );
}
