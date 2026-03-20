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
import {
  getConfigDir,
  getSettingsPath,
  type ResolvedSettings,
  type Settings,
} from '../../config/settings.js';
import {
  PROVIDER_ENV_VARS,
  resolveProviderSelection,
  type ProviderSelectionSource,
} from '../../chat/providers/provider.js';
import { maskPassword, maskApiKey } from '../../utils/format.js';
import { color, colors } from '../../utils/colors.js';

/**
 * Configuration display structure
 */
interface ConfigDisplay {
  profile: {
    active: string | null;
    dashboardUrl: string | null;
    username: string | null;
    skipSSLVerification: boolean;
    skipSSLVerificationSource: 'profile' | 'settings' | 'default';
    allowInsecureHttp: boolean;
    credentialsSource: 'keychain' | 'environment' | 'none';
    credentialsMasked: string | null;
  };
  llmProvider: {
    name: string | null;
    apiKeyMasked: string | null;
    source: ProviderSelectionSource;
    configured: boolean;
    warnings: string[];
  };
  settings: Settings;
  effectiveSettings: ResolvedSettings;
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
      settings: this.rawSettings,
      effectiveSettings: this.settings,
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
          skipSSLVerificationSource: 'default',
          allowInsecureHttp: this.settings.allowInsecureHttp,
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
        credentialsMasked = maskPassword(password);

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
        credentialsMasked = maskPassword(envPassword);
        credentialsSource = 'environment';
      }

      return {
        active: activeProfile.name,
        dashboardUrl: activeProfile.dashboardUrl,
        username: activeProfile.username,
        skipSSLVerification:
          activeProfile.skipSSLVerification ?? this.settings.skipSSLVerification,
        skipSSLVerificationSource:
          activeProfile.skipSSLVerification !== undefined
            ? 'profile'
            : this.settings.skipSSLVerification
              ? 'settings'
              : 'default',
        allowInsecureHttp: this.settings.allowInsecureHttp,
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
        skipSSLVerificationSource: 'default',
        allowInsecureHttp: this.settings.allowInsecureHttp,
        credentialsSource: 'none',
        credentialsMasked: null,
      };
    }
  }

  /**
   * Collect LLM provider data
   */
  private collectLLMProviderData(): ConfigDisplay['llmProvider'] {
    const resolution = resolveProviderSelection({
      envProvider: process.env['MAINWP_LLM_PROVIDER'],
      settingsProvider: this.settings.llmProvider,
      timeout: this.settings.timeout,
    });

    if (!resolution.name) {
      return {
        name: null,
        apiKeyMasked: null,
        source: resolution.source,
        configured: false,
        warnings: resolution.warnings,
      };
    }

    if (!resolution.configured) {
      return {
        name: resolution.name,
        apiKeyMasked: null,
        source: resolution.source,
        configured: false,
        warnings: resolution.warnings,
      };
    }

    return {
      name: resolution.name,
      apiKeyMasked: maskApiKey(resolution.config.apiKey),
      source: resolution.source,
      configured: true,
      warnings: resolution.warnings,
    };
  }

  /**
   * Display configuration in human-readable format
   */
  private displayConfig(config: ConfigDisplay, verbose: boolean): void {
    this.log('\n  MainWP Control CLI - Configuration\n');
    this.log('  ' + '─'.repeat(40));

    // Profile Configuration Section
    this.log(`\n  ${color('Profile Configuration', colors.bold)}`);
    if (config.profile.active) {
      this.log(`    Active Profile: ${color(config.profile.active, colors.green)}`);
      this.log(`    Dashboard URL:  ${config.profile.dashboardUrl}`);
      this.log(`    Username:       ${config.profile.username}`);
      this.log(
        `    SSL Verify:     ${
          config.profile.skipSSLVerification ? color('Disabled', colors.yellow) : color('Enabled', colors.green)
        }${this.describeSSLSource(config.profile.skipSSLVerificationSource)}`
      );
      this.log(
        `    HTTP Allowed:   ${
          config.profile.allowInsecureHttp ? color('Enabled (insecure)', colors.yellow) : color('Disabled', colors.green)
        }`
      );

      if (config.profile.credentialsSource === 'none') {
        this.log(`    Credentials:    ${color('✗ Not found', colors.red)}`);
        this.log(`                    ${color('Run `mainwpctl login` or set MAINWP_APP_PASSWORD', colors.gray)}`);
      } else {
        const sourceLabel =
          config.profile.credentialsSource === 'keychain'
            ? 'Stored in keychain'
            : 'From environment variable';
        this.log(
          `    Credentials:    ${color('✓', colors.green)} ${sourceLabel} (${config.profile.credentialsMasked})`
        );
      }
    } else {
      this.log(`    ${color('No active profile configured', colors.yellow)}`);
      this.log(`    ${color('Run `mainwpctl login` or `mainwpctl profile use <name>`', colors.gray)}`);

      // Show available profiles count
      this.showAvailableProfilesHint();
    }

    // LLM Provider Section
    this.log(`\n  ${color('LLM Provider', colors.bold)}`);
    if (config.llmProvider.configured) {
      this.log(`    Provider:       ${color(config.llmProvider.name!, colors.green)}`);
      this.log(`    API Key:        ${config.llmProvider.apiKeyMasked}`);
      this.log(`    Source:         ${config.llmProvider.source}`);
      this.log(`    Status:         ${color('✓ Configured', colors.green)}`);
    } else if (config.llmProvider.name) {
      this.log(`    Provider:       ${color(config.llmProvider.name, colors.yellow)}`);
      this.log(`    Source:         ${config.llmProvider.source}`);
      this.log(`    Status:         ${color('⚠ API key not set', colors.yellow)}`);
    } else {
      this.log(`    ${color('No LLM provider configured', colors.yellow)}`);
      this.log(`    ${color('Chat mode requires one of these environment variables:', colors.gray)}`);
      for (const [name, envConfig] of Object.entries(PROVIDER_ENV_VARS)) {
        this.log(`    ${color(`  ${name}: ${envConfig.key}`, colors.gray)}`);
      }
    }
    for (const warning of config.llmProvider.warnings) {
      this.log(`    ${color(warning, colors.yellow)}`);
    }

    // Settings Section
    this.log(`\n  ${color('Settings', colors.bold)}`);
    const hasSettings = Object.keys(config.settings).length > 0;

    if (hasSettings || verbose) {
      const timeout = config.effectiveSettings.timeout;
      const debug = config.effectiveSettings.debug;
      const chatContextMessages = config.effectiveSettings.chatContextMessages;
      const chatContextTokens = config.effectiveSettings.chatContextTokens;
      const defaultProvider = config.effectiveSettings.llmProvider;
      const allowInsecureHttp = config.effectiveSettings.allowInsecureHttp;
      const skipSSLVerification = config.effectiveSettings.skipSSLVerification;

      this.log(
        `    Timeout:        ${timeout}ms${config.settings.timeout === undefined ? color(' (default)', colors.gray) : ''}`
      );

      this.log(
        `    Debug Mode:     ${debug ? 'Enabled' : 'Disabled'}${
          config.settings.debug === undefined ? color(' (default)', colors.gray) : ''
        }`
      );

      this.log(
        `    Chat Context:   ${chatContextMessages} messages${
          config.settings.chatContextMessages === undefined ? color(' (default)', colors.gray) : ''
        }`
      );

      if (defaultProvider !== undefined || verbose) {
        this.log(
          `    Default LLM:    ${
            defaultProvider ?? color('Auto-detect', colors.gray)
          }`
        );
      }

      if (chatContextTokens !== undefined && verbose) {
        this.log(`    Token Limit:    ${chatContextTokens}`);
      }

      if (allowInsecureHttp || verbose) {
        this.log(
          `    Allow HTTP:     ${
            allowInsecureHttp ? color('Enabled (insecure)', colors.yellow) : color('Disabled', colors.green)
          }`
        );
      }

      if (skipSSLVerification || verbose) {
        this.log(
          `    Global SSL Skip: ${
            skipSSLVerification ? color('Enabled (advanced)', colors.yellow) : color('Disabled', colors.green)
          }`
        );
      }

      if (!hasSettings && verbose) {
        this.log(`    ${color('Using all default settings', colors.gray)}`);
      }
    } else {
      this.log(`    ${color('Using default settings (use -v for details)', colors.gray)}`);
    }

    // Configuration Files Section
    this.log(`\n  ${color('Configuration Files', colors.bold)}`);
    this.log(`    Config Dir:     ${config.paths.configDir}`);
    this.log(`    Profiles:       ${config.paths.profilesFile}`);
    this.log(`    Settings:       ${config.paths.settingsFile}`);
    this.log(`    Audit Log:      ${config.paths.auditLog}`);

    this.log('\n  ' + '─'.repeat(40) + '\n');
  }

  private describeSSLSource(source: ConfigDisplay['profile']['skipSSLVerificationSource']): string {
    switch (source) {
      case 'profile':
        return color(' (profile)', colors.gray);
      case 'settings':
        return color(' (settings fallback)', colors.gray);
      default:
        return '';
    }
  }

  /**
   * Show hint about available profiles
   */
  private async showAvailableProfilesHint(): Promise<void> {
    try {
      const profileStore = getProfileStore();
      const profiles = await profileStore.list();
      if (profiles.length > 0) {
        this.log(`    ${color(`${profiles.length} profile(s) available: ${profiles.map((p) => p.name).join(', ')}`, colors.gray)}`);
      }
    } catch {
      // Ignore errors
    }
  }
}
