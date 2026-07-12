/**
 * Config Show Command for mainwpcontrol
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
import { formatDivider, formatSection, formatStatusIcon } from '../../output/formatter.js';
import { sanitizeSingleLine, stripControlChars } from '../../utils/terminal-sanitizer.js';

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
    /** Best-effort guess: when keychain and env both hold the same password, this reports 'environment' since the two sources can't be distinguished. */
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
      await this.displayConfig(configDisplay, flags.verbose);
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
  private async displayConfig(config: ConfigDisplay, verbose: boolean): Promise<void> {
    this.log('\n  MainWP Control CLI - Configuration\n');
    this.log(formatDivider());

    // Profile Configuration Section
    const profileRows: string[] = [];
    if (config.profile.active) {
      // Config-file values are user-editable on disk — sanitize before display.
      profileRows.push(`    Active Profile: ${color(stripControlChars(config.profile.active), colors.green)}`);
      profileRows.push(`    Dashboard URL:  ${stripControlChars(config.profile.dashboardUrl ?? '')}`);
      profileRows.push(`    Username:       ${stripControlChars(config.profile.username ?? '')}`);
      profileRows.push(
        `    SSL Verify:     ${
          config.profile.skipSSLVerification ? color('Disabled', colors.yellow) : color('Enabled', colors.green)
        }${this.describeSSLSource(config.profile.skipSSLVerificationSource)}`
      );
      profileRows.push(
        `    HTTP Allowed:   ${
          config.profile.allowInsecureHttp ? color('Enabled (insecure)', colors.yellow) : color('Disabled', colors.green)
        }`
      );

      if (config.profile.credentialsSource === 'none') {
        profileRows.push(`    Credentials:    ${color('✗ Not found', colors.red)}`);
        profileRows.push(`                    ${color('Run `mainwpcontrol login` or set MAINWP_APP_PASSWORD', colors.gray)}`);
      } else {
        const sourceLabel =
          config.profile.credentialsSource === 'keychain'
            ? 'Stored in keychain'
            : 'From environment variable';
        profileRows.push(
          `    Credentials:    ${formatStatusIcon('pass')} ${sourceLabel} (${config.profile.credentialsMasked})`
        );
      }
    } else {
      profileRows.push(`    ${color('No active profile configured', colors.yellow)}`);
      profileRows.push(`    ${color('Run `mainwpcontrol login` or `mainwpcontrol profile use <name>`', colors.gray)}`);
    }
    this.log(formatSection('Profile Configuration', profileRows));

    // Show available profiles count right after the profile section.
    // Awaited (not fire-and-forget) so its output lands in deterministic order.
    if (!config.profile.active) {
      await this.showAvailableProfilesHint();
    }

    // LLM Provider Section
    const llmRows: string[] = [];
    if (config.llmProvider.configured) {
      llmRows.push(`    Provider:       ${color(config.llmProvider.name!, colors.green)}`);
      llmRows.push(`    API Key:        ${config.llmProvider.apiKeyMasked}`);
      llmRows.push(`    Source:         ${config.llmProvider.source}`);
      llmRows.push(`    Status:         ${color('✓ Configured', colors.green)}`);
    } else if (config.llmProvider.name) {
      llmRows.push(`    Provider:       ${color(config.llmProvider.name, colors.yellow)}`);
      llmRows.push(`    Source:         ${config.llmProvider.source}`);
      llmRows.push(`    Status:         ${color('⚠ API key not set', colors.yellow)}`);
    } else {
      llmRows.push(`    ${color('No LLM provider configured', colors.yellow)}`);
      llmRows.push(`    ${color('Chat mode requires one of these environment variables:', colors.gray)}`);
      for (const [name, envConfig] of Object.entries(PROVIDER_ENV_VARS)) {
        llmRows.push(`    ${color(`  ${name}: ${envConfig.key}`, colors.gray)}`);
      }
    }
    for (const warning of config.llmProvider.warnings) {
      llmRows.push(`    ${color(sanitizeSingleLine(warning), colors.yellow)}`);
    }
    this.log(formatSection('LLM Provider', llmRows));

    // Settings Section
    const settingsRows: string[] = [];
    const hasSettings = Object.keys(config.settings).length > 0;

    if (hasSettings || verbose) {
      const timeout = config.effectiveSettings.timeout;
      const debug = config.effectiveSettings.debug;
      const chatContextMessages = config.effectiveSettings.chatContextMessages;
      const chatContextTokens = config.effectiveSettings.chatContextTokens;
      const defaultProvider = config.effectiveSettings.llmProvider;
      const allowInsecureHttp = config.effectiveSettings.allowInsecureHttp;
      const skipSSLVerification = config.effectiveSettings.skipSSLVerification;

      settingsRows.push(
        `    Timeout:        ${timeout}ms${config.settings.timeout === undefined ? color(' (default)', colors.gray) : ''}`
      );

      settingsRows.push(
        `    Debug Mode:     ${debug ? 'Enabled' : 'Disabled'}${
          config.settings.debug === undefined ? color(' (default)', colors.gray) : ''
        }`
      );

      settingsRows.push(
        `    Chat Context:   ${chatContextMessages} messages${
          config.settings.chatContextMessages === undefined ? color(' (default)', colors.gray) : ''
        }`
      );

      if (defaultProvider !== undefined || verbose) {
        settingsRows.push(
          `    Default LLM:    ${
            defaultProvider ?? color('Auto-detect', colors.gray)
          }`
        );
      }

      if (chatContextTokens !== undefined && verbose) {
        settingsRows.push(`    Token Limit:    ${chatContextTokens}`);
      }

      if (allowInsecureHttp || verbose) {
        settingsRows.push(
          `    Allow HTTP:     ${
            allowInsecureHttp ? color('Enabled (insecure)', colors.yellow) : color('Disabled', colors.green)
          }`
        );
      }

      if (skipSSLVerification || verbose) {
        settingsRows.push(
          `    Global SSL Skip: ${
            skipSSLVerification ? color('Enabled (advanced)', colors.yellow) : color('Disabled', colors.green)
          }`
        );
      }

      if (!hasSettings && verbose) {
        settingsRows.push(`    ${color('Using all default settings', colors.gray)}`);
      }
    } else {
      settingsRows.push(`    ${color('Using default settings (use -v for details)', colors.gray)}`);
    }
    this.log(formatSection('Settings', settingsRows));

    // Configuration Files Section
    this.log(
      formatSection('Configuration Files', [
        `    Config Dir:     ${sanitizeSingleLine(config.paths.configDir)}`,
        `    Profiles:       ${sanitizeSingleLine(config.paths.profilesFile)}`,
        `    Settings:       ${sanitizeSingleLine(config.paths.settingsFile)}`,
        `    Audit Log:      ${sanitizeSingleLine(config.paths.auditLog)}`,
      ])
    );

    this.log('\n' + formatDivider() + '\n');
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
        this.log(`    ${color(`${profiles.length} profile(s) available: ${stripControlChars(profiles.map((p) => p.name).join(', '))}`, colors.gray)}`);
      }
    } catch {
      // Ignore errors
    }
  }
}
