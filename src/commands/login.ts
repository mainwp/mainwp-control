/**
 * Login command for mainwpcontrol
 *
 * Authenticates with a MainWP Dashboard and stores credentials.
 */

import { Flags } from '@oclif/core';
import { BaseCommand, commonFlags } from '../lib/base-command.js';
import { getProfileStore, validateDashboardUrl, type Profile } from '../config/profile-store.js';
import { getKeychain } from '../config/keychain.js';
import { createHttpClient } from '../core/http-client.js';
import { formatSuccess, formatWarning, formatInfo } from '../output/formatter.js';
import { AuthError, InputError } from '../utils/errors.js';
import { promptForInput, promptForPassword, isInteractive } from '../utils/prompt.js';
import { sanitizeSingleLine } from '../utils/terminal-sanitizer.js';
import { maskUrlUserinfo } from '../utils/format.js';

export default class Login extends BaseCommand {
  static description = 'Authenticate with a MainWP Dashboard';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --url https://dashboard.example.com',
    '<%= config.bin %> <%= command.id %> --name production',
  ];

  static flags = {
    ...commonFlags,
    url: Flags.string({
      char: 'u',
      description: 'Dashboard URL',
    }),
    username: Flags.string({
      description: 'WordPress admin username',
    }),
    password: Flags.string({
      description: 'Application password (will prompt if not provided)',
    }),
    name: Flags.string({
      char: 'n',
      description: 'Profile name (defaults to hostname)',
    }),
    'skip-ssl-verify': Flags.boolean({
      description: 'Skip SSL certificate verification',
    }),
  };

  static args = {};

  // Login doesn't need a profile loaded
  protected needsProfile(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    await this.initCommon(flags);

    // Collect credentials
    const interactive = isInteractive();

    const url = flags.url ?? (await promptForInput('Dashboard URL'));
    if (!url) {
      throw new InputError(
        'Dashboard URL is required',
        undefined,
        interactive ? undefined : 'Pass --url when running without a terminal'
      );
    }
    const username = flags.username ?? (await promptForInput('WordPress username'));
    if (!username) {
      throw new InputError(
        'WordPress username is required',
        undefined,
        interactive ? undefined : 'Pass --username when running without a terminal'
      );
    }

    if (flags.password) {
      this.logToStderr(
        formatWarning(
          'Passing application passwords via --password exposes them in the process list. Prefer MAINWP_APP_PASSWORD.'
        )
      );
    }

    const envPassword = process.env['MAINWP_APP_PASSWORD'];
    const password = flags.password ?? envPassword ?? (await promptForPassword('Application password'));
    if (!password) {
      throw new InputError(
        'Application password is required',
        undefined,
        interactive
          ? undefined
          : 'Pass --password or set MAINWP_APP_PASSWORD when running without a terminal'
      );
    }

    // Normalize URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    normalizedUrl = normalizedUrl.replace(/\/+$/, '');

    // Reject malformed URLs (embedded credentials included) before the
    // connection test — undici otherwise fails first with an opaque
    // NetworkError and the user never sees the real reason.
    validateDashboardUrl(normalizedUrl, { rejectUserinfo: true });

    // Generate profile name from URL if not provided
    const profileName = flags.name ?? new URL(normalizedUrl).hostname;

    // Test connection
    if (!this.jsonOutput) {
      this.log('Testing connection...');
    }

    const skipSSLVerification = flags['skip-ssl-verify'] ?? this.settings.skipSSLVerification;
    this.debugLog('Testing login connection', {
      dashboardUrl: normalizedUrl,
      username,
      timeoutMs: this.settings.timeout,
      allowInsecureHttp: this.settings.allowInsecureHttp,
      skipSSLVerification,
      passwordSource: flags.password ? 'flag' : envPassword ? 'environment' : 'prompt',
    });

    try {
      const client = createHttpClient({
        baseUrl: normalizedUrl,
        username,
        appPassword: password,
        skipSSLVerification,
        allowInsecureHttp: this.settings.allowInsecureHttp,
        timeout: this.settings.timeout,
      });

      // Try to fetch abilities to verify connection
      const response = await client.get('/wp-json/wp-abilities/v1/abilities');

      if (response.status !== 200) {
        throw new AuthError(
          'Failed to connect to Dashboard',
          undefined,
          'Verify the Dashboard URL and network connectivity'
        );
      }
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      // Preserve hint from underlying error if available
      const originalError = error as Error & { hint?: string };
      throw new AuthError(
        `Connection failed: ${originalError.message}`,
        undefined,
        originalError.hint ?? 'Verify the Dashboard URL and network connectivity'
      );
    }

    // Store profile
    const profile: Profile = {
      name: profileName,
      dashboardUrl: normalizedUrl,
      username,
      createdAt: new Date().toISOString(),
      ...(flags['skip-ssl-verify'] ? { skipSSLVerification: true } : {}),
    };

    const profileStore = getProfileStore();
    const keychain = getKeychain();
    const previousProfile = await profileStore.get(profileName);
    const previousCredential = previousProfile
      ? await keychain.get(profileName)
      : undefined;
    // Attempt credential storage before publishing the profile. A thrown
    // keychain failure cannot leave a profile that was only half-created.
    // Supported keychain-unavailable environments still receive the existing
    // explicit warning and MAINWP_APP_PASSWORD fallback behavior below.
    const keychainResult = await keychain.set(profileName, password);
    try {
      await profileStore.save(profile);
    } catch (error) {
      if (keychainResult.stored) {
        const rollbackResult = previousCredential
          ? await keychain.set(profileName, previousCredential)
          : await keychain.delete(profileName);
        const rollbackSucceeded = 'stored' in rollbackResult
          ? rollbackResult.stored
          : rollbackResult.deleted;
        if (!rollbackSucceeded) {
          this.logToStderr(formatWarning(
            'Profile save failed and the keychain credential rollback also failed.'
          ));
        }
      }
      throw error;
    }

    // Set as active
    await profileStore.setActive(profileName);

    // Output result
    this.output(
      {
        profile: profileName,
        // Defense in depth: intake rejection should make masking a no-op here
        url: maskUrlUserinfo(normalizedUrl),
        username,
        credentialStorage: keychainResult.location,
      },
      () => {
        const lines = [
          formatSuccess(`Logged in as ${sanitizeSingleLine(username)}`),
          `  Profile: ${sanitizeSingleLine(profileName)}`,
          `  Dashboard: ${sanitizeSingleLine(maskUrlUserinfo(normalizedUrl))}`,
        ];

        if (keychainResult.stored) {
          lines.push(`  Credentials: Stored in system keychain`);
        } else {
          lines.push('');
          lines.push(formatWarning('Credentials NOT saved to keychain.'));
          if (keychainResult.error) {
            lines.push(`  Reason: ${sanitizeSingleLine(keychainResult.error)}`);
          }
          lines.push(
            '  Future commands must continue receiving MAINWP_APP_PASSWORD because plaintext credentials are not stored locally.'
          );
        }

        if (skipSSLVerification) {
          lines.push('');
          lines.push(formatWarning('SSL verification is disabled. This is insecure.'));
        }

        if (normalizedUrl.startsWith('http://')) {
          lines.push('');
          lines.push(formatWarning('Using HTTP instead of HTTPS. Credentials may be exposed.'));
        }

        lines.push('');
        lines.push(formatInfo('Next: mainwpcontrol abilities list'));

        return lines.join('\n');
      }
    );
  }

}
