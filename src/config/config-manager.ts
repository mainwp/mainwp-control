/**
 * Configuration manager for mainwpctl
 *
 * Implements layered configuration: env vars > settings file > defaults
 */

import { ConfigError } from '../utils/errors.js';
import { loadSettings, type Settings } from './settings.js';

/**
 * Runtime configuration
 */
export interface Config {
  /** Dashboard URL */
  dashboardUrl: string;

  /** WordPress username */
  username: string;

  /** Application password (from keychain or env) */
  appPassword: string;

  /** Skip SSL verification */
  skipSSLVerification: boolean;

  /** HTTP request timeout (ms) */
  timeout: number;

  /** LLM provider name */
  llmProvider?: string | undefined;

  /** LLM API key */
  llmApiKey?: string | undefined;

  /** Debug mode */
  debug: boolean;
}

/**
 * Environment variable names
 */
const ENV_VARS = {
  DASHBOARD_URL: 'MAINWP_URL',
  USERNAME: 'MAINWP_USERNAME',
  APP_PASSWORD: 'MAINWP_APP_PASSWORD',
  SKIP_SSL: 'MAINWP_SKIP_SSL_VERIFY',
  TIMEOUT: 'MAINWP_TIMEOUT',
  LLM_PROVIDER: 'MAINWPCTL_LLM_PROVIDER',
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  GOOGLE_API_KEY: 'GOOGLE_API_KEY',
  OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
  DEBUG: 'MAINWPCTL_DEBUG',
};

/**
 * Default values
 */
const DEFAULTS = {
  timeout: 30000,
  skipSSLVerification: false,
  debug: false,
};

/**
 * Configuration manager
 */
export class ConfigManager {
  private settings: Settings | null = null;

  /**
   * Load configuration from all sources
   */
  async load(overrides?: Partial<Config>): Promise<Config> {
    // Load settings file
    this.settings = await loadSettings();

    // Build config with layered precedence
    const config: Config = {
      dashboardUrl: this.getDashboardUrl(overrides?.dashboardUrl),
      username: this.getUsername(overrides?.username),
      appPassword: '', // Will be loaded from keychain
      skipSSLVerification: this.getSkipSSL(overrides?.skipSSLVerification),
      timeout: this.getTimeout(overrides?.timeout),
      llmProvider: this.getLLMProvider(overrides?.llmProvider),
      llmApiKey: this.getLLMApiKey(overrides?.llmProvider),
      debug: this.getDebug(overrides?.debug),
    };

    // Validate URL
    this.validateUrl(config.dashboardUrl);

    return config;
  }

  /**
   * Get Dashboard URL
   */
  private getDashboardUrl(override?: string): string {
    const url = override ?? process.env[ENV_VARS.DASHBOARD_URL] ?? '';

    if (!url) {
      throw new ConfigError(
        'Dashboard URL not configured. Run `mainwpctl login` or set MAINWP_URL.'
      );
    }

    return this.normalizeUrl(url);
  }

  /**
   * Get username
   */
  private getUsername(override?: string): string {
    const username = override ?? process.env[ENV_VARS.USERNAME] ?? '';

    if (!username) {
      throw new ConfigError(
        'Username not configured. Run `mainwpctl login` or set MAINWP_USERNAME.'
      );
    }

    return username;
  }

  /**
   * Get skip SSL verification setting
   */
  private getSkipSSL(override?: boolean): boolean {
    if (override !== undefined) return override;

    const envValue = process.env[ENV_VARS.SKIP_SSL];
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1';
    }

    return this.settings?.skipSSLVerification ?? DEFAULTS.skipSSLVerification;
  }

  /**
   * Get timeout setting
   */
  private getTimeout(override?: number): number {
    if (override !== undefined) return override;

    const envValue = process.env[ENV_VARS.TIMEOUT];
    if (envValue !== undefined) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return this.settings?.timeout ?? DEFAULTS.timeout;
  }

  /**
   * Get debug setting
   */
  private getDebug(override?: boolean): boolean {
    if (override !== undefined) return override;

    const envValue = process.env[ENV_VARS.DEBUG];
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1';
    }

    return this.settings?.debug ?? DEFAULTS.debug;
  }

  /**
   * Get LLM provider
   */
  private getLLMProvider(override?: string): string | undefined {
    return override ?? process.env[ENV_VARS.LLM_PROVIDER] ?? this.settings?.llmProvider;
  }

  /**
   * Get LLM API key based on provider
   */
  private getLLMApiKey(provider?: string): string | undefined {
    const p = provider ?? this.getLLMProvider();

    switch (p?.toLowerCase()) {
      case 'openai':
        return process.env[ENV_VARS.OPENAI_API_KEY];
      case 'anthropic':
      case 'claude':
        return process.env[ENV_VARS.ANTHROPIC_API_KEY];
      case 'gemini':
      case 'google':
        return process.env[ENV_VARS.GOOGLE_API_KEY];
      case 'openrouter':
        return process.env[ENV_VARS.OPENROUTER_API_KEY];
      default:
        // Try to find any available key
        return (
          process.env[ENV_VARS.OPENAI_API_KEY] ??
          process.env[ENV_VARS.ANTHROPIC_API_KEY] ??
          process.env[ENV_VARS.GOOGLE_API_KEY] ??
          process.env[ENV_VARS.OPENROUTER_API_KEY]
        );
    }
  }

  /**
   * Normalize URL (add protocol, remove trailing slash)
   */
  private normalizeUrl(url: string): string {
    let normalized = url.trim();

    // Add protocol if missing
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `https://${normalized}`;
    }

    // Remove trailing slash
    normalized = normalized.replace(/\/+$/, '');

    return normalized;
  }

  /**
   * Validate URL format
   */
  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConfigError(`Invalid URL protocol: ${parsed.protocol}`);
      }

      // Warn about HTTP
      if (parsed.protocol === 'http:') {
        console.warn('WARNING: Using HTTP instead of HTTPS. Credentials may be exposed.');
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`Invalid Dashboard URL: ${url}`);
    }
  }
}

/**
 * Singleton instance
 */
let configManagerInstance: ConfigManager | null = null;

/**
 * Get the config manager instance
 */
export function getConfigManager(): ConfigManager {
  if (!configManagerInstance) {
    configManagerInstance = new ConfigManager();
  }
  return configManagerInstance;
}

/**
 * Load configuration (convenience function)
 */
export async function loadConfig(overrides?: Partial<Config>): Promise<Config> {
  return getConfigManager().load(overrides);
}
