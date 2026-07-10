/**
 * Base command for mainwpcontrol
 *
 * Provides common functionality for all CLI commands:
 * - Profile and authentication management
 * - JSON/human output handling
 * - AbilitiesExecutor initialization
 */

import { Command, Flags, Interfaces } from '@oclif/core';
import { getProfileStore, type Profile } from '../config/profile-store.js';
import { getKeychain } from '../config/keychain.js';
import {
  loadSettings,
  resolveSettings,
  type ResolvedSettings,
  type Settings,
} from '../config/settings.js';
import { createAbilitiesExecutor, type AbilitiesExecutor } from '../core/abilities-executor.js';
import { createBatchManager, type BatchManager } from '../core/batch-manager.js';
import type { HttpClientConfig } from '../core/http-client.js';
import { isMainWPCTLError, ConfigError } from '../utils/errors.js';
import { successOutput, errorOutput } from '../output/json-envelope.js';
import { ExitCode } from '../utils/exit-codes.js';
import { formatError, formatWarning } from '../output/formatter.js';
import { isSensitiveKey } from '../utils/redaction.js';

/**
 * Common flags available to all commands
 */
export const commonFlags = {
  json: Flags.boolean({
    description: 'Output JSON (for scripting/CI)',
    // No default - allows distinguishing "not provided" from "explicitly false"
    // Precedence: --json flag > settings.defaultJsonOutput > false
  }),
  quiet: Flags.boolean({
    char: 'q',
    description: 'Suppress output (exit code only)',
    default: false,
  }),
  profile: Flags.string({
    char: 'p',
    description: 'Use a specific profile',
  }),
  debug: Flags.boolean({
    description: 'Show debug output',
  }),
};

/**
 * Parsed flags type helper
 */
type CommonFlags = Interfaces.InferredFlags<typeof commonFlags>;

/**
 * Base command class
 *
 * All mainwpcontrol commands should extend this class.
 */
export abstract class BaseCommand extends Command {
  /**
   * Current active profile
   */
  protected currentProfile: Profile | undefined;

  /**
   * Whether to output JSON
   */
  protected jsonOutput = false;

  /**
   * Debug mode flag
   */
  protected debugMode = false;

  /**
   * Whether debug was explicitly requested on the CLI.
   */
  protected explicitDebugMode = false;

  /**
   * Quiet mode flag — suppress stdout output (exit code only)
   */
  protected quietMode = false;

  /**
   * Raw settings from settings.json
   */
  protected rawSettings: Settings = {};

  /**
   * Validated and normalized settings
   */
  protected settings: ResolvedSettings = {
    defaultJsonOutput: false,
    timeout: 30000,
    skipSSLVerification: false,
    debug: false,
    chatContextMessages: 20,
    allowInsecureHttp: false,
  };

  /**
   * Cached executor instance
   */
  private executor: AbilitiesExecutor | undefined;

  /**
   * Cached batch manager instance
   */
  private batchManagerInstance: BatchManager | undefined;

  /**
   * Cached HTTP client config, so the keychain is only looked up once per
   * process even if a command uses both getExecutor() and getBatchManager().
   */
  private clientConfig: HttpClientConfig | undefined;

  /**
   * Whether this command needs a profile to be loaded.
   * Override to return false for commands like `login` that don't need a profile.
   */
  protected needsProfile(): boolean {
    return true;
  }

  /**
   * Initialize common functionality.
   * Call this at the start of each command's run() method.
   */
  protected async initCommon(flags: CommonFlags): Promise<void> {
    // Load and validate settings
    this.rawSettings = await loadSettings();
    const resolved = resolveSettings(this.rawSettings);
    this.settings = resolved.settings;

    // Apply precedence: explicit flag > settings file > default (false)
    // flags.json is undefined if not provided, boolean if provided
    this.jsonOutput = flags.json ?? this.settings.defaultJsonOutput;
    this.explicitDebugMode = flags.debug === true;
    this.debugMode = flags.debug ?? this.settings.debug;

    // Quiet mode: suppress stdout. --json and explicit --debug override --quiet.
    this.quietMode = (flags.quiet ?? false) && !this.jsonOutput && !this.explicitDebugMode;

    for (const warning of resolved.warnings) {
      this.logToStderr(formatWarning(warning));
    }

    if (this.needsProfile()) {
      await this.loadProfile(flags.profile);
    }
  }

  /**
   * Load the specified or active profile
   */
  private async loadProfile(profileName?: string): Promise<void> {
    const profileStore = getProfileStore();

    if (profileName) {
      const profile = await profileStore.get(profileName);
      if (!profile) {
        throw new ConfigError(
          `Profile not found: ${profileName}`,
          undefined,
          'List available profiles with `mainwpcontrol profile list` or create one with `mainwpcontrol login`'
        );
      }
      this.currentProfile = profile;
    } else {
      this.currentProfile = await profileStore.getActive();
      if (!this.currentProfile) {
        throw new ConfigError(
          'No profile configured.',
          undefined,
          'Create your first profile with `mainwpcontrol login`'
        );
      }
    }

    if (this.currentProfile) {
      this.debugLog('Loaded profile', {
        profile: this.currentProfile.name,
        dashboardUrl: this.currentProfile.dashboardUrl,
        skipSSLVerification: this.getTransportConfig().skipSSLVerification,
      });
    }
  }

  /**
   * Build (and cache) the HTTP client config for the current profile.
   * Resolves the keychain password once per process — getExecutor() and
   * getBatchManager() both call this instead of hitting the keychain themselves.
   */
  private async buildClientConfig(): Promise<HttpClientConfig> {
    if (this.clientConfig) {
      return this.clientConfig;
    }

    if (!this.currentProfile) {
      throw new ConfigError(
        'No profile loaded',
        undefined,
        'This is an internal error. Please report this issue.'
      );
    }

    const keychain = getKeychain();
    const appPassword = await keychain.getOrThrow(this.currentProfile.name);
    this.clientConfig = {
      baseUrl: this.currentProfile.dashboardUrl,
      username: this.currentProfile.username,
      appPassword,
      ...this.getTransportConfig(),
    };

    return this.clientConfig;
  }

  /**
   * Get the AbilitiesExecutor instance
   */
  protected async getExecutor(): Promise<AbilitiesExecutor> {
    if (this.executor) {
      return this.executor;
    }

    const config = await this.buildClientConfig();
    this.executor = createAbilitiesExecutor(config);

    this.debugLog('Initialized abilities executor', {
      profile: this.currentProfile?.name,
      timeoutMs: this.settings.timeout,
      allowInsecureHttp: this.settings.allowInsecureHttp,
      skipSSLVerification: this.getTransportConfig().skipSSLVerification,
    });

    return this.executor;
  }

  /**
   * Get the BatchManager instance (lazy, cached)
   */
  protected async getBatchManager(): Promise<BatchManager> {
    if (this.batchManagerInstance) {
      return this.batchManagerInstance;
    }

    const config = await this.buildClientConfig();
    this.batchManagerInstance = createBatchManager(config);

    this.debugLog('Initialized batch manager', {
      profile: this.currentProfile?.name,
      timeoutMs: this.settings.timeout,
      allowInsecureHttp: this.settings.allowInsecureHttp,
      skipSSLVerification: this.getTransportConfig().skipSSLVerification,
    });

    return this.batchManagerInstance;
  }

  /**
   * Build common transport configuration using profile-scoped settings first.
   */
  protected getTransportConfig(): {
    skipSSLVerification: boolean;
    allowInsecureHttp: boolean;
    timeout: number;
  } {
    return {
      skipSSLVerification:
        this.currentProfile?.skipSSLVerification ?? this.settings.skipSSLVerification,
      allowInsecureHttp: this.settings.allowInsecureHttp,
      timeout: this.settings.timeout,
    };
  }

  /**
   * Emit redacted debug output to stderr.
   */
  protected debugLog(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldEmitDebug()) {
      return;
    }

    const suffix =
      context && Object.keys(context).length > 0
        ? ` ${JSON.stringify(this.redactDebugContext(context))}`
        : '';

    this.logToStderr(`[debug] ${message}${suffix}`);
  }

  private shouldEmitDebug(): boolean {
    if (!this.debugMode) {
      return false;
    }

    return this.explicitDebugMode || !this.quietMode;
  }

  private redactDebugContext(context: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(context)) {
      if (isSensitiveKey(key)) {
        redacted[key] = '[REDACTED]';
        continue;
      }

      if (typeof value === 'string' && value.length > 300) {
        redacted[key] = `${value.slice(0, 297)}...`;
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        redacted[key] = this.redactDebugContext(value as Record<string, unknown>);
        continue;
      }

      redacted[key] = value;
    }

    return redacted;
  }

  /**
   * Output data in JSON or human-readable format.
   *
   * @param data - The data to output (used for JSON mode)
   * @param humanFormatter - Optional function that returns human-readable string
   */
  protected output<T>(data: T, humanFormatter?: () => string): void {
    if (this.quietMode) {
      return;
    }

    if (this.jsonOutput) {
      const envelope = successOutput(data);
      this.log(JSON.stringify(envelope, null, 2));
    } else if (humanFormatter) {
      this.log(humanFormatter());
    }
  }


  /**
   * Handle errors with appropriate exit codes
   */
  protected async catch(err: Error & { exitCode?: number; oclif?: { exit?: number } }): Promise<void> {
    // Re-throw oclif exit errors to preserve their exit code
    if (err.oclif && typeof err.oclif.exit === 'number') {
      throw err;
    }

    if (this.jsonOutput) {
      const envelope = errorOutput(err);
      this.log(JSON.stringify(envelope, null, 2));
    } else {
      // Human-readable error output with hints
      this.logToStderr(formatError(err));
    }

    // Determine exit code from error class (MainWPCTLError subclasses carry exitCode)
    const exitCode = isMainWPCTLError(err) ? err.exitCode : (err.exitCode ?? ExitCode.INTERNAL_ERROR);

    this.exit(exitCode);
  }
}
