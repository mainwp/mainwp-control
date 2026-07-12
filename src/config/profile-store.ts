/**
 * Profile store for mainwpcontrol
 *
 * Manages multiple Dashboard connection profiles.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { getConfigDir } from './settings.js';
import { atomicWriteFile } from './fs-utils.js';
import { sanitizeSingleLine } from '../utils/terminal-sanitizer.js';

/**
 * Profile data (credentials stored separately in keychain)
 */
export interface Profile {
  /** Profile name (unique identifier) */
  name: string;

  /** Dashboard URL */
  dashboardUrl: string;

  /** WordPress admin username */
  username: string;

  /** Skip SSL verification for this profile */
  skipSSLVerification?: boolean;

  /** Created timestamp */
  createdAt: string;

  /** Last used timestamp */
  lastUsedAt?: string;
}

/**
 * Profiles file structure
 */
interface ProfilesFile {
  activeProfile?: string | undefined;
  profiles: Profile[];
}

/**
 * Get the profiles file path
 */
function getProfilesPath(): string {
  return join(getConfigDir(), 'profiles.json');
}

/**
 * Load profiles from file
 */
async function loadProfilesFile(): Promise<ProfilesFile> {
  const path = getProfilesPath();

  try {
    const content = await fs.readFile(path, 'utf-8');
    return JSON.parse(content) as ProfilesFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { profiles: [] };
    }
    throw new ConfigError(
      `Failed to load profiles: ${(error as Error).message}`,
      undefined,
      'Check file permissions for ~/.config/mainwpcontrol/profiles.json'
    );
  }
}

/**
 * Save profiles to file
 *
 * SECURITY: Uses atomic write (tmp + rename) and restricted permissions.
 */
async function saveProfilesFile(data: ProfilesFile): Promise<void> {
  const path = getProfilesPath();
  await atomicWriteFile(path, JSON.stringify(data, null, 2));
}

/**
 * Profile store class
 */
export class ProfileStore {
  private data: ProfilesFile | null = null;

  /**
   * Validate a URL format and protocol
   */
  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConfigError(
        `Invalid Dashboard URL format: ${url}`,
        undefined,
        'URL must include protocol (http:// or https://) and hostname'
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError(
        `Invalid URL protocol: ${parsed.protocol}. Must be http or https`,
        undefined,
        'Only HTTP and HTTPS protocols are supported'
      );
    }

    // HTTP warning is emitted at login time via formatWarning, not here
  }

  /**
   * Validate a profile's required fields and URL format
   */
  private validateProfile(profile: Profile): void {
    const validationHint = 'Run `mainwpcontrol login` to create a valid profile';

    if (!profile.name || profile.name.trim().length === 0) {
      throw new ConfigError(
        'Profile validation failed: name is required',
        undefined,
        validationHint
      );
    }

    if (!profile.dashboardUrl || profile.dashboardUrl.trim().length === 0) {
      throw new ConfigError(
        'Profile validation failed: dashboardUrl is required',
        undefined,
        validationHint
      );
    }

    if (!profile.username || profile.username.trim().length === 0) {
      throw new ConfigError(
        'Profile validation failed: username is required',
        undefined,
        validationHint
      );
    }

    if (!profile.createdAt || profile.createdAt.trim().length === 0) {
      throw new ConfigError(
        'Profile validation failed: createdAt is required',
        undefined,
        validationHint
      );
    }

    this.validateUrl(profile.dashboardUrl);
  }

  /**
   * Validate entire profiles file structure
   */
  private validateProfilesFile(data: ProfilesFile): void {
    for (const profile of data.profiles) {
      try {
        this.validateProfile(profile);
      } catch (error) {
        // Preserve hint from the original ConfigError when rewrapping
        const hint = error instanceof ConfigError ? error.hint : undefined;
        throw new ConfigError(
          `Invalid profile "${profile.name || 'unnamed'}": ${(error as Error).message}`,
          undefined,
          hint
        );
      }
    }

    // Validate activeProfile references an existing profile
    if (
      data.activeProfile &&
      !data.profiles.some((p) => p.name === data.activeProfile)
    ) {
      console.error(
        `Warning: Active profile "${sanitizeSingleLine(data.activeProfile)}" no longer exists. ` +
        `Falling back to "${sanitizeSingleLine(data.profiles[0]?.name ?? 'none')}".`
      );
      data.activeProfile = data.profiles[0]?.name;
    }
  }

  /**
   * Ensure data is loaded
   */
  private async ensureLoaded(): Promise<ProfilesFile> {
    if (!this.data) {
      const data = await loadProfilesFile();
      this.validateProfilesFile(data);
      this.data = data;
    }
    return this.data;
  }

  /**
   * List all profiles
   */
  async list(): Promise<Profile[]> {
    const data = await this.ensureLoaded();
    return data.profiles;
  }

  /**
   * Get the active profile
   */
  async getActive(): Promise<Profile | undefined> {
    const data = await this.ensureLoaded();

    if (!data.activeProfile) {
      // Return first profile if no active set
      return data.profiles[0];
    }

    return data.profiles.find((p) => p.name === data.activeProfile);
  }

  /**
   * Get the active profile name
   */
  async getActiveName(): Promise<string | undefined> {
    const data = await this.ensureLoaded();
    return data.activeProfile ?? data.profiles[0]?.name;
  }

  /**
   * Set the active profile
   */
  async setActive(name: string): Promise<void> {
    const data = await this.ensureLoaded();

    const profile = data.profiles.find((p) => p.name === name);
    if (!profile) {
      throw new ConfigError(
        `Profile not found: ${name}`,
        undefined,
        'List available profiles with `mainwpcontrol profile list`'
      );
    }

    data.activeProfile = name;
    profile.lastUsedAt = new Date().toISOString();

    await saveProfilesFile(data);
    this.data = data;
  }

  /**
   * Get a profile by name
   */
  async get(name: string): Promise<Profile | undefined> {
    const data = await this.ensureLoaded();
    return data.profiles.find((p) => p.name === name);
  }

  /**
   * Save a profile (create or update)
   */
  async save(profile: Profile): Promise<void> {
    // Validate profile before saving
    this.validateProfile(profile);

    const data = await this.ensureLoaded();

    const existingIndex = data.profiles.findIndex((p) => p.name === profile.name);

    if (existingIndex >= 0) {
      // Update existing
      data.profiles[existingIndex] = profile;
    } else {
      // Add new
      data.profiles.push(profile);
    }

    // Set as active if it's the first profile
    if (data.profiles.length === 1) {
      data.activeProfile = profile.name;
    }

    await saveProfilesFile(data);
    this.data = data;
  }

  /**
   * Remove a profile
   */
  async remove(name: string): Promise<void> {
    const data = await this.ensureLoaded();

    const index = data.profiles.findIndex((p) => p.name === name);
    if (index < 0) {
      throw new ConfigError(
        `Profile not found: ${name}`,
        undefined,
        'List available profiles with `mainwpcontrol profile list`'
      );
    }

    data.profiles.splice(index, 1);

    // Clear active if we removed the active profile
    if (data.activeProfile === name) {
      data.activeProfile = data.profiles[0]?.name;
    }

    await saveProfilesFile(data);
    this.data = data;
  }

  /**
   * Check if a profile exists
   */
  async exists(name: string): Promise<boolean> {
    const data = await this.ensureLoaded();
    return data.profiles.some((p) => p.name === name);
  }

  /**
   * Reload profiles from disk
   */
  async reload(): Promise<void> {
    const data = await loadProfilesFile();
    this.validateProfilesFile(data);
    this.data = data;
  }
}

/**
 * Singleton instance
 */
let profileStoreInstance: ProfileStore | null = null;

/**
 * Get the profile store instance
 */
export function getProfileStore(): ProfileStore {
  if (!profileStoreInstance) {
    profileStoreInstance = new ProfileStore();
  }
  return profileStoreInstance;
}
