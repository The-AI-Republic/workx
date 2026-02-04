/**
 * Profile Manager
 *
 * Manages Chrome profiles for session preservation.
 * Handles profile copying, backup, and restoration.
 *
 * @module desktop/tools/browser/ProfileManager
 */

import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';

/**
 * Profile status
 */
export type ProfileStatus = 'available' | 'in-use' | 'locked' | 'corrupted' | 'not-found';

/**
 * Profile info
 */
export interface ProfileInfo {
  /** Profile name */
  name: string;
  /** Profile path */
  path: string;
  /** Profile status */
  status: ProfileStatus;
  /** Last modified date */
  lastModified?: Date;
  /** Size in bytes */
  sizeBytes?: number;
  /** Whether this is the default profile */
  isDefault?: boolean;
}

/**
 * Copy options
 */
export interface CopyOptions {
  /** Include cookies (default: true) */
  includeCookies?: boolean;
  /** Include local storage (default: true) */
  includeLocalStorage?: boolean;
  /** Include session storage (default: true) */
  includeSessionStorage?: boolean;
  /** Include extensions (default: false) */
  includeExtensions?: boolean;
  /** Include history (default: false) */
  includeHistory?: boolean;
  /** Include bookmarks (default: false) */
  includeBookmarks?: boolean;
}

/**
 * Default copy options - session preservation focused
 */
const DEFAULT_COPY_OPTIONS: CopyOptions = {
  includeCookies: true,
  includeLocalStorage: true,
  includeSessionStorage: true,
  includeExtensions: false,
  includeHistory: false,
  includeBookmarks: false,
};

/**
 * ProfileManager manages Chrome profiles for session preservation
 *
 * @example
 * ```typescript
 * const manager = new ProfileManager();
 *
 * // Copy session data to a new profile
 * const newProfile = await manager.copyProfile('/path/to/chrome/Default', {
 *   includeCookies: true,
 *   includeLocalStorage: true,
 * });
 *
 * // Launch Chrome with the copied profile
 * chrome.launch({ userDataDir: newProfile });
 * ```
 */
export class ProfileManager {
  private profilesDir: string | null = null;

  /**
   * Get the directory for managed profiles
   */
  private async getProfilesDir(): Promise<string> {
    if (!this.profilesDir) {
      const appData = await appDataDir();
      this.profilesDir = `${appData}/profiles`;
    }
    return this.profilesDir;
  }

  /**
   * List all managed profiles
   *
   * @returns List of managed profiles
   */
  async listProfiles(): Promise<ProfileInfo[]> {
    try {
      const profilesDir = await this.getProfilesDir();
      const profiles = await invoke<ProfileInfo[]>('list_profiles', { profilesDir });
      return profiles || [];
    } catch (error) {
      console.warn('[ProfileManager] Failed to list profiles:', error);
      return [];
    }
  }

  /**
   * Copy a Chrome profile with session data
   *
   * @param sourceProfilePath - Path to source profile directory
   * @param options - Copy options
   * @returns Path to the new profile
   */
  async copyProfile(sourceProfilePath: string, options?: CopyOptions): Promise<string> {
    const opts = { ...DEFAULT_COPY_OPTIONS, ...options };
    const profilesDir = await this.getProfilesDir();
    const timestamp = Date.now();
    const destPath = `${profilesDir}/session-${timestamp}`;

    console.log(`[ProfileManager] Copying profile from ${sourceProfilePath} to ${destPath}`);

    try {
      // Create destination directory
      await invoke('create_directory', { path: destPath });

      // Copy selected profile components
      const filesToCopy: string[] = [];

      if (opts.includeCookies) {
        filesToCopy.push('Cookies', 'Cookies-journal');
      }

      if (opts.includeLocalStorage) {
        filesToCopy.push('Local Storage');
      }

      if (opts.includeSessionStorage) {
        filesToCopy.push('Session Storage');
      }

      if (opts.includeExtensions) {
        filesToCopy.push('Extensions');
      }

      if (opts.includeHistory) {
        filesToCopy.push('History', 'History-journal');
      }

      if (opts.includeBookmarks) {
        filesToCopy.push('Bookmarks');
      }

      // Always copy essential files
      filesToCopy.push('Preferences', 'Secure Preferences', 'Login Data', 'Web Data');

      // Perform copy
      await invoke('copy_profile_files', {
        sourcePath: sourceProfilePath,
        destPath,
        files: filesToCopy,
      });

      console.log(`[ProfileManager] Profile copied successfully to ${destPath}`);
      return destPath;
    } catch (error) {
      console.error('[ProfileManager] Failed to copy profile:', error);
      throw new Error(`Failed to copy profile: ${error}`);
    }
  }

  /**
   * Create a fresh profile directory
   *
   * @returns Path to the new profile
   */
  async createFreshProfile(): Promise<string> {
    const profilesDir = await this.getProfilesDir();
    const timestamp = Date.now();
    const destPath = `${profilesDir}/fresh-${timestamp}`;

    await invoke('create_directory', { path: destPath });
    console.log(`[ProfileManager] Created fresh profile at ${destPath}`);

    return destPath;
  }

  /**
   * Delete a managed profile
   *
   * @param profilePath - Path to the profile to delete
   */
  async deleteProfile(profilePath: string): Promise<void> {
    const profilesDir = await this.getProfilesDir();

    // Safety check: only delete profiles in our managed directory
    if (!profilePath.startsWith(profilesDir)) {
      throw new Error('Cannot delete profiles outside of managed directory');
    }

    await invoke('delete_directory', { path: profilePath });
    console.log(`[ProfileManager] Deleted profile at ${profilePath}`);
  }

  /**
   * Clean up old profiles
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 7 days)
   * @returns Number of profiles deleted
   */
  async cleanupOldProfiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const profiles = await this.listProfiles();
    const now = Date.now();
    let deleted = 0;

    for (const profile of profiles) {
      if (profile.lastModified) {
        const age = now - profile.lastModified.getTime();
        if (age > maxAgeMs && profile.status !== 'in-use') {
          try {
            await this.deleteProfile(profile.path);
            deleted++;
          } catch (error) {
            console.warn(`[ProfileManager] Failed to delete old profile ${profile.path}:`, error);
          }
        }
      }
    }

    console.log(`[ProfileManager] Cleaned up ${deleted} old profiles`);
    return deleted;
  }

  /**
   * Get profile status
   *
   * @param profilePath - Path to the profile
   * @returns Profile status
   */
  async getProfileStatus(profilePath: string): Promise<ProfileStatus> {
    try {
      const status = await invoke<ProfileStatus>('get_profile_status', { profilePath });
      return status;
    } catch {
      return 'not-found';
    }
  }

  /**
   * Check if a profile is locked (in use by another process)
   *
   * @param profilePath - Path to the profile
   * @returns true if profile is locked
   */
  async isProfileLocked(profilePath: string): Promise<boolean> {
    const status = await this.getProfileStatus(profilePath);
    return status === 'locked' || status === 'in-use';
  }
}
