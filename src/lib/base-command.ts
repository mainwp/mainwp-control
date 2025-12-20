/**
 * Base command for mainwpctl
 *
 * Provides common functionality for all CLI commands:
 * - Profile and authentication management
 * - JSON/human output handling
 * - AbilitiesExecutor initialization
 */

import { Command, Flags, Interfaces } from '@oclif/core';
import { getProfileStore, type Profile } from '../config/profile-store.js';
import { getKeychain } from '../config/keychain.js';
import { createAbilitiesExecutor, type AbilitiesExecutor } from '../core/abilities-executor.js';
import { ConfigError, AuthError } from '../utils/errors.js';
import { successOutput, errorOutput } from '../output/json-envelope.js';
import { ExitCode } from '../utils/exit-codes.js';

/**
 * Common flags available to all commands
 */
export const commonFlags = {
  json: Flags.boolean({
    description: 'Output JSON (for scripting/CI)',
    default: false,
  }),
  profile: Flags.string({
    char: 'p',
    description: 'Use a specific profile',
  }),
  debug: Flags.boolean({
    description: 'Show debug output',
    default: false,
  }),
};

/**
 * Parsed flags type helper
 */
type CommonFlags = Interfaces.InferredFlags<typeof commonFlags>;

/**
 * Base command class
 *
 * All mainwpctl commands should extend this class.
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
   * Cached executor instance
   */
  private executor: AbilitiesExecutor | undefined;

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
    this.jsonOutput = flags.json ?? false;
    this.debugMode = flags.debug ?? false;

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
        throw new ConfigError(`Profile not found: ${profileName}`);
      }
      this.currentProfile = profile;
    } else {
      this.currentProfile = await profileStore.getActive();
      if (!this.currentProfile) {
        throw new ConfigError(
          'No profile configured. Run `mainwpctl login` to create one.'
        );
      }
    }
  }

  /**
   * Get the AbilitiesExecutor instance
   */
  protected async getExecutor(): Promise<AbilitiesExecutor> {
    if (this.executor) {
      return this.executor;
    }

    if (!this.currentProfile) {
      throw new ConfigError('No profile loaded');
    }

    const keychain = getKeychain();
    const password = await keychain.getOrThrow(this.currentProfile.name);

    this.executor = createAbilitiesExecutor({
      baseUrl: this.currentProfile.dashboardUrl,
      username: this.currentProfile.username,
      appPassword: password,
      skipSSLVerification: this.currentProfile.skipSSLVerification,
    });

    return this.executor;
  }

  /**
   * Output data in JSON or human-readable format.
   *
   * @param data - The data to output (used for JSON mode)
   * @param humanFormatter - Optional function that returns human-readable string
   */
  protected output<T>(data: T, humanFormatter?: () => string): void {
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
  protected async catch(err: Error & { exitCode?: number }): Promise<void> {
    if (this.jsonOutput) {
      const envelope = errorOutput(err);
      this.log(JSON.stringify(envelope, null, 2));
    }

    // Determine exit code
    let exitCode = err.exitCode ?? ExitCode.INTERNAL_ERROR;

    if (err instanceof ConfigError) {
      exitCode = ExitCode.AUTH_ERROR;
    } else if (err instanceof AuthError) {
      exitCode = ExitCode.AUTH_ERROR;
    }

    this.exit(exitCode);
  }
}
