/**
 * Keychain integration for mainwpctl
 *
 * Secure credential storage with environment variable fallback.
 *
 * Fallback chain:
 * 1. OS keychain (via keytar)
 * 2. Environment variable: MAINWP_APP_PASSWORD
 * 3. Error if neither available
 */

import { AuthError } from '../utils/errors.js';

/**
 * Service name for keychain entries
 */
const SERVICE_NAME = 'mainwpctl';

/**
 * Environment variable for fallback
 */
const ENV_VAR = 'MAINWP_APP_PASSWORD';

/**
 * Keytar module (lazy loaded)
 */
let keytar: typeof import('keytar') | null = null;
let keytarAvailable: boolean | null = null;

/**
 * Try to load keytar
 */
async function loadKeytar(): Promise<typeof import('keytar') | null> {
  if (keytar !== null) {
    return keytar;
  }

  if (keytarAvailable === false) {
    return null;
  }

  try {
    keytar = await import('keytar');
    keytarAvailable = true;
    return keytar;
  } catch {
    keytarAvailable = false;
    return null;
  }
}

/**
 * Keychain class
 */
export class Keychain {
  /**
   * Check if keychain is available
   */
  async isAvailable(): Promise<boolean> {
    const kt = await loadKeytar();
    return kt !== null;
  }

  /**
   * Store a credential
   */
  async set(profileName: string, password: string): Promise<void> {
    const kt = await loadKeytar();

    if (kt) {
      try {
        await kt.setPassword(SERVICE_NAME, profileName, password);
        return;
      } catch (error) {
        console.warn(`Warning: Could not store in keychain: ${(error as Error).message}`);
        console.warn('Credentials will not be persisted.');
      }
    }
  }

  /**
   * Retrieve a credential
   */
  async get(profileName: string): Promise<string | undefined> {
    // First try keytar
    const kt = await loadKeytar();

    if (kt) {
      try {
        const password = await kt.getPassword(SERVICE_NAME, profileName);
        if (password) {
          return password;
        }
      } catch (error) {
        // Keytar failed, fall through to env var
        console.warn(`Warning: Could not read from keychain: ${(error as Error).message}`);
      }
    }

    // Fallback to environment variable
    const envPassword = process.env[ENV_VAR];
    if (envPassword) {
      return envPassword;
    }

    return undefined;
  }

  /**
   * Delete a credential
   */
  async delete(profileName: string): Promise<void> {
    const kt = await loadKeytar();

    if (kt) {
      try {
        await kt.deletePassword(SERVICE_NAME, profileName);
      } catch {
        // Ignore delete failures
      }
    }
  }

  /**
   * Get credential or throw
   */
  async getOrThrow(profileName: string): Promise<string> {
    const password = await this.get(profileName);

    if (!password) {
      throw new AuthError(
        `No credentials found for profile "${profileName}".`,
        undefined,
        `Run \`mainwpctl login\` or set ${ENV_VAR} environment variable`
      );
    }

    return password;
  }
}

/**
 * Singleton instance
 */
let keychainInstance: Keychain | null = null;

/**
 * Get the keychain instance
 */
export function getKeychain(): Keychain {
  if (!keychainInstance) {
    keychainInstance = new Keychain();
  }
  return keychainInstance;
}
