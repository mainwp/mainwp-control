/**
 * Keychain integration for mainwpcontrol
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
const SERVICE_NAME = 'mainwpcontrol';

/**
 * Environment variable for fallback
 */
const ENV_VAR = 'MAINWP_APP_PASSWORD';

/**
 * Timeout for keytar operations (ms). If macOS shows a blocking keychain
 * dialog, this prevents the CLI from hanging indefinitely.
 */
const KEYTAR_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Keychain access timed out — the system keychain may be locked or unavailable')),
      ms,
    );
    timer.unref();
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

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

  // Allow explicit opt-out for CI/containers where native keychain is unavailable
  if (process.env['MAINWPCONTROL_NO_KEYTAR'] === '1') {
    keytarAvailable = false;
    return null;
  }

  try {
    const mod = await import('keytar');
    // CJS/ESM interop: on newer Node versions, CJS exports are nested under .default.
    // Check for the expected API on mod first; only unwrap .default if needed.
    keytar = typeof mod.setPassword === 'function'
      ? mod
      : typeof (mod as any).default?.setPassword === 'function'
        ? (mod as any).default
        : undefined;

    if (!keytar) {
      keytarAvailable = false;
      return null;
    }
    keytarAvailable = true;
    return keytar;
  } catch {
    keytarAvailable = false;
    return null;
  }
}

/**
 * Result of a credential storage operation
 */
export interface KeychainSetResult {
  /** Whether credentials were successfully stored */
  stored: boolean;
  /** Where credentials were stored (or 'none' if storage failed) */
  location: 'keychain' | 'none';
  /** Error message if storage failed */
  error?: string;
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
   *
   * @returns Result indicating whether storage succeeded and where credentials are stored
   */
  async set(profileName: string, password: string): Promise<KeychainSetResult> {
    const kt = await loadKeytar();

    if (kt) {
      try {
        await withTimeout(kt.setPassword(SERVICE_NAME, profileName, password), KEYTAR_TIMEOUT_MS);
        return { stored: true, location: 'keychain' };
      } catch (error) {
        const errorMessage = (error as Error).message;
        return {
          stored: false,
          location: 'none',
          error: errorMessage,
        };
      }
    }

    return {
      stored: false,
      location: 'none',
      error: 'Keychain (keytar) is not available',
    };
  }

  /**
   * Retrieve a credential
   */
  async get(profileName: string): Promise<string | undefined> {
    // First try keytar
    const kt = await loadKeytar();

    if (kt) {
      try {
        const password = await withTimeout(kt.getPassword(SERVICE_NAME, profileName), KEYTAR_TIMEOUT_MS);
        if (password) {
          return password;
        }
      } catch {
        // Keytar failed, fall through to env var
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
        await withTimeout(kt.deletePassword(SERVICE_NAME, profileName), KEYTAR_TIMEOUT_MS);
      } catch (error) {
        // Always warn, including non-TTY/CI runs — a silent failure here
        // leaves stale credentials in the keychain with no visible signal.
        console.error(`Warning: Failed to remove credentials from keychain: ${(error as Error).message}`);
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
        `Run \`mainwpcontrol login\` or set ${ENV_VAR} environment variable`
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
