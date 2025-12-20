/**
 * Login command for mainwpctl
 *
 * Authenticates with a MainWP Dashboard and stores credentials.
 */

import { Flags } from '@oclif/core';
import { createInterface } from 'node:readline';
import { BaseCommand, commonFlags } from '../lib/base-command.js';
import { getProfileStore, type Profile } from '../config/profile-store.js';
import { getKeychain } from '../config/keychain.js';
import { createHttpClient } from '../core/http-client.js';
import { formatSuccess, formatWarning } from '../output/formatter.js';
import { AuthError, InputError } from '../utils/errors.js';

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
      default: false,
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
    const url = flags.url ?? (await this.prompt('Dashboard URL: '));
    const username = flags.username ?? (await this.prompt('WordPress username: '));
    const password = flags.password ?? (await this.prompt('Application password: ', true));

    // Normalize URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    normalizedUrl = normalizedUrl.replace(/\/+$/, '');

    // Generate profile name from URL if not provided
    const profileName = flags.name ?? new URL(normalizedUrl).hostname;

    // Test connection
    if (!this.jsonOutput) {
      this.log('Testing connection...');
    }

    try {
      const client = createHttpClient({
        baseUrl: normalizedUrl,
        username,
        appPassword: password,
        skipSSLVerification: flags['skip-ssl-verify'],
      });

      // Try to fetch abilities to verify connection
      const response = await client.get('/wp-json/wp-abilities/v1/abilities');

      if (response.status !== 200) {
        throw new AuthError('Failed to connect to Dashboard');
      }
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError(`Connection failed: ${(error as Error).message}`);
    }

    // Store profile
    const profile: Profile = {
      name: profileName,
      dashboardUrl: normalizedUrl,
      username,
      skipSSLVerification: flags['skip-ssl-verify'],
      createdAt: new Date().toISOString(),
    };

    const profileStore = getProfileStore();
    await profileStore.save(profile);

    // Store password in keychain
    const keychain = getKeychain();
    await keychain.set(profileName, password);

    // Set as active
    await profileStore.setActive(profileName);

    // Check keychain availability before output
    const keychainAvailable = await keychain.isAvailable();

    // Output result
    this.output(
      {
        profile: profileName,
        url: normalizedUrl,
        username,
      },
      () => {
        const lines = [
          formatSuccess(`Logged in as ${username}`),
          `  Profile: ${profileName}`,
          `  Dashboard: ${normalizedUrl}`,
        ];

        if (!keychainAvailable) {
          lines.push('');
          lines.push(formatWarning('Keychain not available. Password stored in environment only.'));
        }

        return lines.join('\n');
      }
    );
  }

  /**
   * Prompt for user input
   */
  private async prompt(message: string, hidden = false): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve, reject) => {
      if (hidden && process.stdin.isTTY) {
        // For hidden input, we need to handle it differently
        process.stdout.write(message);
        let input = '';

        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const onData = (char: string): void => {
          const charCode = char.charCodeAt(0);

          if (charCode === 13 || charCode === 10) {
            // Enter
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            rl.close();
            resolve(input);
          } else if (charCode === 3) {
            // Ctrl+C
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            rl.close();
            reject(new InputError('Login cancelled by user'));
          } else if (charCode === 127) {
            // Backspace
            if (input.length > 0) {
              input = input.slice(0, -1);
            }
          } else {
            input += char;
          }
        };

        stdin.on('data', onData);
      } else {
        rl.question(message, (answer) => {
          rl.close();
          resolve(answer);
        });
      }
    });
  }
}
