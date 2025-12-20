/**
 * Profile store for mainwpctl
 *
 * Manages multiple Dashboard connection profiles.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { getConfigDir } from './settings.js';

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
    throw new ConfigError(`Failed to load profiles: ${(error as Error).message}`);
  }
}

/**
 * Save profiles to file
 */
async function saveProfilesFile(data: ProfilesFile): Promise<void> {
  const dir = getConfigDir();
  const path = getProfilesPath();

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Profile store class
 */
export class ProfileStore {
  private data: ProfilesFile | null = null;

  /**
   * Ensure data is loaded
   */
  private async ensureLoaded(): Promise<ProfilesFile> {
    if (!this.data) {
      this.data = await loadProfilesFile();
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
      throw new ConfigError(`Profile not found: ${name}`);
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
      throw new ConfigError(`Profile not found: ${name}`);
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
    this.data = await loadProfilesFile();
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
