/**
 * Config Show Command for mainwpctl
 *
 * Displays current configuration and settings.
 *
 * Shows:
 * - Active profile configuration
 * - Credential storage status
 * - LLM provider configuration
 * - Settings
 * - Configuration file paths
 */

import { Flags } from '@oclif/core';
import { join } from 'node:path';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { getProfileStore } from '../../config/profile-store.js';
import { getKeychain } from '../../config/keychain.js';
import { getConfigDir, getSettingsPath, loadSettings, type Settings } from '../../config/settings.js';
import {
  detectConfiguredProvider,
  getProviderConfigFromEnv,
  PROVIDER_ENV_VARS,
} from '../../chat/providers/provider.js';

/**
 * Configuration display structure
 */
interface ConfigDisplay {
  profile: {
    active: string | null;
    dashboardUrl: string | null;
    username: string | null;
    skipSSLVerification: boolean;
    credentialsSource: 'keychain' | 'environment' | 'none';
    credentialsMasked: string | null;
  };
  llmProvider: {
    name: string | null;
    apiKeyMasked: string | null;
    configured: boolean;
  };
  settings: Settings;
  paths: {
    configDir: string;
    profilesFile: string;
    settingsFile: string;
    auditLog: string;
  };
}

export default class ConfigShowCommand extends BaseCommand {
  static override description = 'Display current configuration and settings';

  static override examples = [
    {
      command: '<%= config.bin %> config show',
      description: 'Show current configuration',
    },
    {
      command: '<%= config.bin %> config show --json',
      description: 'Output configuration in JSON format',
    },
    {
      command: '<%= config.bin %> config show --verbose',
      description: 'Show detailed configuration including all settings',
    },
  ];

  static override flags = {
    ...commonFlags,
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed output including all settings',
      default: false,
    }),
  };

  /**
   * Don't require a profile for config show command
   */
  protected override needsProfile(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigShowCommand);

    await this.initCommon(flags);

    // Collect configuration data
    const configDisplay = await this.collectConfigData();

    // Output
    if (this.jsonOutput) {
      this.output(configDisplay);
    } else {
      this.displayConfig(configDisplay, flags.verbose);
    }
  }

  /**
   * Collect all configuration data
   */
  private async collectConfigData(): Promise<ConfigDisplay> {
    const configDir = getConfigDir();

    return {
      profile: await this.collectProfileData(),
      llmProvider: this.collectLLMProviderData(),
      settings: await this.collectSettingsData(),
      paths: {
        configDir,
        profilesFile: join(configDir, 'profiles.json'),
        settingsFile: getSettingsPath(),
        auditLog: join(configDir, 'audit.log'),
      },
    };
  }

  /**
   * Collect profile configuration data
   */
  private async collectProfileData(): Promise<ConfigDisplay['profile']> {
    try {
      const profileStore = getProfileStore();
      const activeProfile = await profileStore.getActive();

      if (!activeProfile) {
        return {
          active: null,
          dashboardUrl: null,
          username: null,
          skipSSLVerification: false,
          credentialsSource: 'none',
          credentialsMasked: null,
        };
      }

      // Check credentials from both sources explicitly
      const keychain = getKeychain();
      const keychainAvailable = await keychain.isAvailable();
      const envPassword = process.env['MAINWP_APP_PASSWORD'];

      // Get password (keychain.get includes env fallback)
      const password = await keychain.get(activeProfile.name);

      let credentialsSource: 'keychain' | 'environment' | 'none' = 'none';
      let credentialsMasked: string | null = null;

      if (password) {
        credentialsMasked = this.maskPassword(password);

        // Determine source with correct priority
        // keychain.get() checks keychain first, then falls back to env
        if (!keychainAvailable) {
          // Keychain not available, password must be from environment
          credentialsSource = 'environment';
        } else if (!envPassword) {
          // Keychain available, no env var, password must be from keychain
          credentialsSource = 'keychain';
        } else if (password !== envPassword) {
          // Both available but passwords differ, password is from keychain
          credentialsSource = 'keychain';
        } else {
          // Keychain available, env set, passwords match
          // Password could be from keychain entry OR env fallback
          // Since we can't distinguish, report 'environment' when env is explicitly set
          credentialsSource = 'environment';
        }
      } else if (envPassword) {
        // keychain.get returned nothing but env var is set
        // This handles edge cases where keychain lookup failed
        credentialsMasked = this.maskPassword(envPassword);
        credentialsSource = 'environment';
      }

      return {
        active: activeProfile.name,
        dashboardUrl: activeProfile.dashboardUrl,
        username: activeProfile.username,
        skipSSLVerification: activeProfile.skipSSLVerification ?? false,
        credentialsSource,
        credentialsMasked,
      };
    } catch (error) {
      // Return empty profile data on error
      return {
        active: null,
        dashboardUrl: null,
        username: null,
        skipSSLVerification: false,
        credentialsSource: 'none',
        credentialsMasked: null,
      };
    }
  }

  /**
   * Collect LLM provider data
   */
  private collectLLMProviderData(): ConfigDisplay['llmProvider'] {
    const detectedProvider = detectConfiguredProvider();

    if (!detectedProvider) {
      return {
        name: null,
        apiKeyMasked: null,
        configured: false,
      };
    }

    const config = getProviderConfigFromEnv(detectedProvider);

    if (!config?.apiKey) {
      return {
        name: detectedProvider,
        apiKeyMasked: null,
        configured: false,
      };
    }

    return {
      name: detectedProvider,
      apiKeyMasked: this.maskApiKey(config.apiKey),
      configured: true,
    };
  }

  /**
   * Collect settings data
   */
  private async collectSettingsData(): Promise<Settings> {
    try {
      return await loadSettings();
    } catch {
      return {};
    }
  }

  /**
   * Mask password for display
   */
  private maskPassword(password: string): string {
    if (password.length <= 8) {
      return '****';
    }
    return password.substring(0, 4) + '...' + password.substring(password.length - 4);
  }

  /**
   * Mask API key for display
   */
  private maskApiKey(apiKey: string): string {
    if (apiKey.length <= 10) {
      return '****';
    }
    return apiKey.substring(0, 6) + '...' + apiKey.substring(apiKey.length - 4);
  }

  /**
   * Display configuration in human-readable format
   */
  private displayConfig(config: ConfigDisplay, verbose: boolean): void {
    this.log('\n  MainWP Control CLI - Configuration\n');
    this.log('  ' + '─'.repeat(40));

    // Profile Configuration Section
    this.log('\n  \x1b[1mProfile Configuration\x1b[0m');
    if (config.profile.active) {
      this.log(`    Active Profile: \x1b[32m${config.profile.active}\x1b[0m`);
      this.log(`    Dashboard URL:  ${config.profile.dashboardUrl}`);
      this.log(`    Username:       ${config.profile.username}`);
      this.log(
        `    SSL Verify:     ${config.profile.skipSSLVerification ? '\x1b[33mDisabled\x1b[0m' : '\x1b[32mEnabled\x1b[0m'}`
      );

      if (config.profile.credentialsSource === 'none') {
        this.log(`    Credentials:    \x1b[31m✗ Not found\x1b[0m`);
        this.log(`                    \x1b[90mRun \`mainwpctl login\` or set MAINWP_APP_PASSWORD\x1b[0m`);
      } else {
        const sourceLabel =
          config.profile.credentialsSource === 'keychain'
            ? 'Stored in keychain'
            : 'From environment variable';
        this.log(
          `    Credentials:    \x1b[32m✓\x1b[0m ${sourceLabel} (${config.profile.credentialsMasked})`
        );
      }
    } else {
      this.log(`    \x1b[33mNo active profile configured\x1b[0m`);
      this.log(`    \x1b[90mRun \`mainwpctl login\` or \`mainwpctl profile use <name>\`\x1b[0m`);

      // Show available profiles count
      this.showAvailableProfilesHint();
    }

    // LLM Provider Section
    this.log('\n  \x1b[1mLLM Provider\x1b[0m');
    if (config.llmProvider.configured) {
      this.log(`    Provider:       \x1b[32m${config.llmProvider.name}\x1b[0m`);
      this.log(`    API Key:        ${config.llmProvider.apiKeyMasked}`);
      this.log(`    Status:         \x1b[32m✓ Configured\x1b[0m`);
    } else if (config.llmProvider.name) {
      this.log(`    Provider:       \x1b[33m${config.llmProvider.name}\x1b[0m`);
      this.log(`    Status:         \x1b[33m⚠ API key not set\x1b[0m`);
    } else {
      this.log(`    \x1b[33mNo LLM provider configured\x1b[0m`);
      this.log(`    \x1b[90mChat mode requires one of these environment variables:\x1b[0m`);
      for (const [name, envConfig] of Object.entries(PROVIDER_ENV_VARS)) {
        this.log(`    \x1b[90m  ${name}: ${envConfig.key}\x1b[0m`);
      }
    }

    // Settings Section
    this.log('\n  \x1b[1mSettings\x1b[0m');
    const hasSettings = Object.keys(config.settings).length > 0;

    if (hasSettings || verbose) {
      const timeout = config.settings.timeout;
      const debug = config.settings.debug;
      const chatContextMessages = config.settings.chatContextMessages;
      const chatContextTokens = config.settings.chatContextTokens;

      if (timeout !== undefined) {
        this.log(`    Timeout:        ${timeout}ms`);
      } else if (verbose) {
        this.log(`    Timeout:        \x1b[90m30000ms (default)\x1b[0m`);
      }

      if (debug !== undefined) {
        this.log(`    Debug Mode:     ${debug ? 'Enabled' : 'Disabled'}`);
      } else if (verbose) {
        this.log(`    Debug Mode:     \x1b[90mDisabled (default)\x1b[0m`);
      }

      if (chatContextMessages !== undefined) {
        this.log(`    Chat Context:   ${chatContextMessages} messages`);
      } else if (verbose) {
        this.log(`    Chat Context:   \x1b[90m20 messages (default)\x1b[0m`);
      }

      if (chatContextTokens !== undefined && verbose) {
        this.log(`    Token Limit:    ${chatContextTokens}`);
      }

      if (!hasSettings && verbose) {
        this.log(`    \x1b[90mUsing all default settings\x1b[0m`);
      }
    } else {
      this.log(`    \x1b[90mUsing default settings (use -v for details)\x1b[0m`);
    }

    // Configuration Files Section
    this.log('\n  \x1b[1mConfiguration Files\x1b[0m');
    this.log(`    Config Dir:     ${config.paths.configDir}`);
    this.log(`    Profiles:       ${config.paths.profilesFile}`);
    this.log(`    Settings:       ${config.paths.settingsFile}`);
    this.log(`    Audit Log:      ${config.paths.auditLog}`);

    this.log('\n  ' + '─'.repeat(40) + '\n');
  }

  /**
   * Show hint about available profiles
   */
  private async showAvailableProfilesHint(): Promise<void> {
    try {
      const profileStore = getProfileStore();
      const profiles = await profileStore.list();
      if (profiles.length > 0) {
        this.log(`    \x1b[90m${profiles.length} profile(s) available: ${profiles.map((p) => p.name).join(', ')}\x1b[0m`);
      }
    } catch {
      // Ignore errors
    }
  }
}
