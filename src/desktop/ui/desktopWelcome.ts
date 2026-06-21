import { STORAGE_KEYS } from '@/config/defaults';
import { getConfigStorage } from '@/core/storage';

/**
 * Decide whether the desktop first-run guide should open.
 *
 * The guide is only for genuinely clean desktop profiles:
 * - No guide marker and no agent config: seed marker=false and show it.
 * - No guide marker but existing config: seed marker=true so upgrades do not
 *   interrupt established users.
 * - marker=false: keep showing until the user completes or skips the guide.
 */
export async function shouldShowDesktopWelcome(): Promise<boolean> {
  const storage = getConfigStorage();
  const completed = await storage.get<boolean>(STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED);

  if (completed === true) {
    return false;
  }

  if (completed === false) {
    return true;
  }

  const storedConfig = await storage.get(STORAGE_KEYS.CONFIG);
  const isFreshProfile = !storedConfig;
  await storage.set(STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED, !isFreshProfile);
  return isFreshProfile;
}

export async function markDesktopWelcomeCompleted(): Promise<void> {
  await getConfigStorage().set(STORAGE_KEYS.DESKTOP_WELCOME_COMPLETED, true);
}
