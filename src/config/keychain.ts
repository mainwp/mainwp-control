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
import { sanitizeErrorMessage } from '../utils/error-sanitizer.js';
import { sanitizeSingleLine } from '../utils/terminal-sanitizer.js';

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
const MAX_KEYCHAIN_ERROR_LENGTH = 500;

/**
 * Keytar is native code and can reject with non-Error values; a blind
 * `(error as Error).message` throws on null/undefined and turns a
 * warn-and-continue path into a crash.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeKeychainError(error: unknown): string {
  return sanitizeErrorMessage(sanitizeSingleLine(errorMessage(error)))
    .slice(0, MAX_KEYCHAIN_ERROR_LENGTH);
}

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

export interface KeychainDeleteResult {
  deleted: boolean;
  /** True when no credential existed to delete — the goal state already holds. */
  notFound?: boolean;
  error?: string;
}

/**
 * Result of a persisted-only credential read. Distinguishes "nothing stored"
 * from "could not read" — callers making destructive decisions (rollback,
 * overwrite) must not treat a failed read as an empty keychain.
 */
export type KeychainReadResult =
  | { status: 'found'; password: string }
  | { status: 'not-found' }
  | { status: 'error'; error: string };

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
        return {
          stored: false,
          location: 'none',
          error: errorMessage(error),
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
   * Read the persisted keychain credential only — no MAINWP_APP_PASSWORD
   * fallback (the env var must never masquerade as a stored credential).
   *
   * An unavailable keytar reads as not-found: nothing can be stored or
   * deleted through it either, so no overwrite/rollback hazard exists.
   */
  async getStored(profileName: string): Promise<KeychainReadResult> {
    const kt = await loadKeytar();

    if (!kt) {
      return { status: 'not-found' };
    }

    try {
      const password = await withTimeout(kt.getPassword(SERVICE_NAME, profileName), KEYTAR_TIMEOUT_MS);
      return password ? { status: 'found', password } : { status: 'not-found' };
    } catch (error) {
      return { status: 'error', error: sanitizeKeychainError(error) };
    }
  }

  /**
   * Retrieve a credential for authentication: keytar first, then the
   * MAINWP_APP_PASSWORD environment variable. Keytar read errors fall
   * through to the env var.
   */
  async get(profileName: string): Promise<string | undefined> {
    const stored = await this.getStored(profileName);
    if (stored.status === 'found') {
      return stored.password;
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
  async delete(profileName: string): Promise<KeychainDeleteResult> {
    const kt = await loadKeytar();

    if (kt) {
      try {
        const deleted = await withTimeout(
          kt.deletePassword(SERVICE_NAME, profileName),
          KEYTAR_TIMEOUT_MS,
        );
        return deleted
          ? { deleted: true }
          : { deleted: false, notFound: true, error: 'No matching keychain credential was found' };
      } catch (error) {
        return {
          deleted: false,
          error: sanitizeKeychainError(error),
        };
      }
    }

    return {
      deleted: false,
      error: 'Keychain (keytar) is not available',
    };
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
