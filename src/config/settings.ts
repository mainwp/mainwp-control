/**
 * Settings file support for mainwpctl
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  isSupportedProviderName,
  type ProviderName,
  SUPPORTED_PROVIDER_NAMES,
} from '../chat/providers/provider.js';
import { atomicWriteFile } from './fs-utils.js';

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

  /** Allow insecure HTTP connections (not recommended) */
  allowInsecureHttp?: boolean;
}

export interface ResolvedSettings {
  defaultJsonOutput: boolean;
  llmProvider?: ProviderName;
  timeout: number;
  skipSSLVerification: boolean;
  debug: boolean;
  chatContextMessages: number;
  chatContextTokens?: number;
  allowInsecureHttp: boolean;
}

export interface SettingsResolution {
  settings: ResolvedSettings;
  warnings: string[];
}

export const SETTINGS_DEFAULTS: ResolvedSettings = {
  defaultJsonOutput: false,
  timeout: 30000,
  skipSSLVerification: false,
  debug: false,
  chatContextMessages: 20,
  allowInsecureHttp: false,
};

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
 * Cached settings (cleared on explicit reload).
 * No TTL needed: mainwpctl is a short-lived CLI process — settings are read
 * once per invocation. clearSettingsCache() handles explicit invalidation
 * (e.g. after saveSettings).
 */
let cachedSettings: Settings | null = null;

/**
 * Load settings from file (cached after first read)
 */
export async function loadSettings(): Promise<Settings> {
  if (cachedSettings) {
    return cachedSettings;
  }

  const path = getSettingsPath();

  try {
    const content = await fs.readFile(path, 'utf-8');
    cachedSettings = JSON.parse(content) as Settings;
    return cachedSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedSettings = {};
      return cachedSettings;
    }
    if (error instanceof SyntaxError) {
      // Corrupted/malformed JSON — warn but don't crash
      console.error(`Warning: Failed to parse settings file at ${path}. Using defaults.`);
      cachedSettings = {};
      return cachedSettings;
    }
    // Permission or other I/O error — surface it
    throw error;
  }
}

/**
 * Validate and normalize settings with safe fallbacks.
 */
export function resolveSettings(raw: Settings): SettingsResolution {
  const warnings: string[] = [];
  const settings: ResolvedSettings = { ...SETTINGS_DEFAULTS };

  settings.defaultJsonOutput = readBooleanSetting(
    raw.defaultJsonOutput,
    'defaultJsonOutput',
    SETTINGS_DEFAULTS.defaultJsonOutput,
    warnings
  );
  settings.debug = readBooleanSetting(raw.debug, 'debug', SETTINGS_DEFAULTS.debug, warnings);
  settings.skipSSLVerification = readBooleanSetting(
    raw.skipSSLVerification,
    'skipSSLVerification',
    SETTINGS_DEFAULTS.skipSSLVerification,
    warnings
  );
  settings.allowInsecureHttp = readBooleanSetting(
    raw.allowInsecureHttp,
    'allowInsecureHttp',
    SETTINGS_DEFAULTS.allowInsecureHttp,
    warnings
  );

  if (raw.timeout === undefined) {
    settings.timeout = SETTINGS_DEFAULTS.timeout;
  } else if (Number.isInteger(raw.timeout) && raw.timeout > 0) {
    settings.timeout = raw.timeout;
  } else {
    warnings.push('Ignoring invalid settings.timeout; expected a positive integer in milliseconds.');
  }

  if (raw.chatContextMessages === undefined) {
    settings.chatContextMessages = SETTINGS_DEFAULTS.chatContextMessages;
  } else if (Number.isInteger(raw.chatContextMessages) && raw.chatContextMessages >= 0) {
    settings.chatContextMessages = raw.chatContextMessages;
  } else {
    warnings.push('Ignoring invalid settings.chatContextMessages; expected an integer greater than or equal to 0.');
  }

  if (raw.chatContextTokens !== undefined) {
    if (Number.isInteger(raw.chatContextTokens) && raw.chatContextTokens > 0) {
      settings.chatContextTokens = raw.chatContextTokens;
    } else {
      warnings.push('Ignoring invalid settings.chatContextTokens; expected a positive integer.');
    }
  }

  if (raw.llmProvider) {
    const normalized = raw.llmProvider.trim().toLowerCase();
    if (isSupportedProviderName(normalized)) {
      settings.llmProvider = normalized;
    } else {
      warnings.push(
        `Ignoring invalid settings.llmProvider "${raw.llmProvider}". Available: ${SUPPORTED_PROVIDER_NAMES.join(', ')}`
      );
    }
  }

  return { settings, warnings };
}

function readBooleanSetting(
  value: unknown,
  key: string,
  fallback: boolean,
  warnings: string[]
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  warnings.push(`Ignoring invalid settings.${key}; expected a boolean.`);
  return fallback;
}

/**
 * Clear the settings cache (forces re-read on next loadSettings call)
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}

/**
 * Save settings to file
 *
 * SECURITY: Uses atomic write (tmp + rename) and restricted permissions.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const path = getSettingsPath();
  await atomicWriteFile(path, JSON.stringify(settings, null, 2));

  // Update cache with freshly saved settings
  cachedSettings = settings;
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
