/**
 * Settings file support for mainwpctl
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Settings structure
 */
export interface Settings {
  /** Default output format (true = JSON, false = human-readable) */
  defaultJsonOutput?: boolean;

  /** Default LLM provider */
  llmProvider?: string;

  /** Default timeout for HTTP requests (ms) */
  timeout?: number;

  /** Skip SSL verification (not recommended) */
  skipSSLVerification?: boolean;

  /** Enable debug output */
  debug?: boolean;

  /** Maximum messages to keep in chat context (default: 20, 0 = unlimited) */
  chatContextMessages?: number;

  /** Maximum estimated tokens in chat context (reserved for future use) */
  chatContextTokens?: number;
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  const xdgConfig = process.env['XDG_CONFIG_HOME'];
  if (xdgConfig) {
    return join(xdgConfig, 'mainwpctl');
  }
  return join(homedir(), '.config', 'mainwpctl');
}

/**
 * Get the settings file path
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json');
}

/**
 * Load settings from file
 */
export async function loadSettings(): Promise<Settings> {
  const path = getSettingsPath();

  try {
    const content = await fs.readFile(path, 'utf-8');
    return JSON.parse(content) as Settings;
  } catch (error) {
    // File doesn't exist or is invalid - return empty settings
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    // Log parse errors but don't fail
    console.warn(`Warning: Could not parse settings file: ${path}`);
    return {};
  }
}

/**
 * Save settings to file
 *
 * SECURITY: Uses atomic write (tmp + rename) and restricted permissions.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const dir = getConfigDir();
  const path = getSettingsPath();
  const tmpPath = `${path}.tmp`;

  // Create directory with restricted permissions (owner only)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // Atomic write: write to temp file then rename
  // This prevents data corruption if process crashes mid-write
  await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2), {
    encoding: 'utf-8',
    mode: 0o600, // Owner read/write only
  });

  // Rename is atomic on POSIX systems
  await fs.rename(tmpPath, path);
}

/**
 * Update specific settings
 */
export async function updateSettings(updates: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged = { ...current, ...updates };
  await saveSettings(merged);
  return merged;
}
