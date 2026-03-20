/**
 * Config Directory Manager for Process Tests
 *
 * Creates isolated XDG_CONFIG_HOME temp directories with pre-populated
 * profiles.json and settings.json for each test.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface ProfileData {
  name: string;
  dashboardUrl: string;
  username: string;
  skipSSLVerification?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface ConfigDirOptions {
  profiles?: ProfileData[];
  activeProfile?: string;
  settings?: Record<string, unknown>;
}

export class ConfigDir {
  /** The temp XDG_CONFIG_HOME path (parent of mainwpctl/). */
  readonly xdgHome: string;

  /** The mainwpctl config directory inside xdgHome. */
  readonly configPath: string;

  private constructor(xdgHome: string) {
    this.xdgHome = xdgHome;
    this.configPath = join(xdgHome, 'mainwpctl');
  }

  /**
   * Create a new temp config directory with optional pre-populated data.
   */
  static async create(options: ConfigDirOptions = {}): Promise<ConfigDir> {
    const xdgHome = await mkdtemp(join(tmpdir(), 'mwpctl-test-'));
    const instance = new ConfigDir(xdgHome);

    // Create mainwpctl subdir
    await mkdir(instance.configPath, { recursive: true });

    // Write profiles.json
    const profiles = (options.profiles ?? []).map((p) => ({
      ...p,
      createdAt: p.createdAt ?? new Date().toISOString(),
    }));
    const profilesFile = {
      activeProfile: options.activeProfile ?? profiles[0]?.name,
      profiles,
    };
    await writeFile(
      join(instance.configPath, 'profiles.json'),
      JSON.stringify(profilesFile, null, 2),
      'utf-8',
    );

    // Write settings.json
    if (options.settings) {
      await writeFile(
        join(instance.configPath, 'settings.json'),
        JSON.stringify(options.settings, null, 2),
        'utf-8',
      );
    }

    return instance;
  }

  /**
   * Read and parse the profiles.json file.
   */
  async readProfiles(): Promise<{
    activeProfile?: string;
    profiles: ProfileData[];
  }> {
    const raw = await readFile(join(this.configPath, 'profiles.json'), 'utf-8');
    return JSON.parse(raw) as { activeProfile?: string; profiles: ProfileData[] };
  }

  /**
   * Read and parse the settings.json file.
   */
  async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(join(this.configPath, 'settings.json'), 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Remove the temp directory.
   */
  async cleanup(): Promise<void> {
    await rm(this.xdgHome, { recursive: true, force: true });
  }
}
