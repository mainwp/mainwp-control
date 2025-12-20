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
  /** Default LLM provider */
  llmProvider?: string;

  /** Default timeout for HTTP requests (ms) */
  timeout?: number;

  /** Skip SSL verification (not recommended) */
  skipSSLVerification?: boolean;

  /** Enable debug output */
  debug?: boolean;
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
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const dir = getConfigDir();
  const path = getSettingsPath();

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  // Write settings
  await fs.writeFile(path, JSON.stringify(settings, null, 2), 'utf-8');
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
