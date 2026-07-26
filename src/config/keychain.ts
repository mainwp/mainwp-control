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
 * Environment variable naming the Dashboard the env credential is for.
 *
 * Required alongside ENV_VAR for authenticated use: the credential is released
 * only when this matches the profile's canonical identity, so a tampered
 * profiles.json cannot redirect the password to another host.
 */
const ENV_URL_VAR = 'MAINWP_DASHBOARD_URL';

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
 * Canonical Dashboard identity used to bind a stored credential to the
 * destination it was saved for: scheme + host(:port) + normalized base path.
 * Profile names are user-facing selectors, not an authorization boundary
 * (AGENTS.md) — this is the boundary.
 */
/**
 * Refuse the env credential unless the operator declared the same Dashboard it
 * is about to be sent to. Fails closed on a missing or unparseable declaration.
 *
 * Every authenticated use of the env credential goes through here, `login`
 * included. An earlier revision let login proceed without a declaration on the
 * grounds that `--url` already names the destination, but that reopened the
 * hole: in CI the password lives in a protected secret store while command
 * arguments usually do not, so anyone who can edit the workflow can redirect it
 * without touching the secret. Binding is only worth having if nothing skips it.
 *
 * @param expectedDashboardUrl - Where the credential would be sent
 * @param destinationLabel - How to name that destination in the error
 */
export function assertEnvCredentialDeclaredFor(
  expectedDashboardUrl: string,
  destinationLabel: string
): void {
  const declaredUrl = process.env[ENV_URL_VAR];

  if (!declaredUrl) {
    throw new AuthError(
      `${ENV_VAR} is set but ${ENV_URL_VAR} is not, so the destination cannot be verified. Refusing to send the credential.`,
      undefined,
      `Set ${ENV_URL_VAR} to the Dashboard URL the credential belongs to, or run \`mainwpcontrol login\` to store it in the keychain.`
    );
  }

  // The expected URL comes from profiles.json, which is untrusted input, so a
  // malformed one must fail closed as an AuthError rather than surface a raw
  // TypeError from the parser.
  let expected: string;
  try {
    expected = canonicalDashboardIdentity(expectedDashboardUrl);
  } catch {
    throw new AuthError(
      `The destination URL is not valid, so it cannot be verified against ${ENV_URL_VAR}. Refusing to send the credential.`,
      undefined,
      'Check the Dashboard URL on the profile, or run `mainwpcontrol login` to recreate it.'
    );
  }

  let declared: string;
  try {
    declared = canonicalDashboardIdentity(declaredUrl);
  } catch {
    throw new AuthError(
      `${ENV_URL_VAR} is not a valid URL, so the destination cannot be verified. Refusing to send the credential.`,
      undefined,
      `Set ${ENV_URL_VAR} to the full Dashboard URL, for example https://dashboard.example.com.`
    );
  }

  if (declared !== expected) {
    throw new AuthError(
      `${ENV_VAR} is declared for ${declared}, but ${destinationLabel} points to ${expected}. Refusing to send it.`,
      undefined,
      `Point ${ENV_URL_VAR} at ${expected}, or target a Dashboard at ${declared}.`
    );
  }
}

export function canonicalDashboardIdentity(dashboardUrl: string): string {
  const parsed = new URL(dashboardUrl);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Stored credential envelope (format v1). Legacy entries are the bare
 * application password; new entries bind the password to the Dashboard
 * identity they were saved for, so editing profiles.json cannot silently
 * redirect a stored credential to a different host.
 */
interface StoredCredentialV1 {
  v: 1;
  password: string;
  identity: string;
}

function encodeCredential(password: string, dashboardUrl: string): string {
  const envelope: StoredCredentialV1 = {
    v: 1,
    password,
    identity: canonicalDashboardIdentity(dashboardUrl),
  };
  return JSON.stringify(envelope);
}

/**
 * Decode a stored keychain payload. WordPress application passwords never
 * start with "{", so a JSON-looking payload that fails to parse as a v1
 * envelope is treated as a legacy bare password rather than rejected.
 */
function decodeCredential(raw: string): { password: string; identity?: string } {
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredCredentialV1>;
      if (
        parsed !== null &&
        parsed.v === 1 &&
        typeof parsed.password === 'string' &&
        typeof parsed.identity === 'string'
      ) {
        return { password: parsed.password, identity: parsed.identity };
      }
    } catch {
      // Fall through: treat as legacy raw secret
    }
  }
  return { password: raw };
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
   * Store a credential.
   *
   * When `dashboardUrl` is provided the password is stored bound to that
   * Dashboard's canonical identity; retrieval with an expected URL then
   * refuses to release the credential to a different destination. Omit
   * `dashboardUrl` only to restore a previously read raw payload verbatim
   * (rollback).
   *
   * @returns Result indicating whether storage succeeded and where credentials are stored
   */
  async set(
    profileName: string,
    password: string,
    dashboardUrl?: string
  ): Promise<KeychainSetResult> {
    const kt = await loadKeytar();
    const payload = dashboardUrl ? encodeCredential(password, dashboardUrl) : password;

    if (kt) {
      try {
        await withTimeout(kt.setPassword(SERVICE_NAME, profileName, payload), KEYTAR_TIMEOUT_MS);
        return { stored: true, location: 'keychain' };
      } catch (error) {
        return {
          stored: false,
          location: 'none',
          error: sanitizeKeychainError(error),
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
   *
   * When `expectedDashboardUrl` is provided and the stored credential is
   * identity-bound, a mismatch throws instead of releasing the password —
   * a hand-edited profiles.json must not redirect a stored credential to a
   * different host. Legacy (unbound) entries are refused for authenticated
   * use when an expected URL is provided; a one-time `login` re-binds them.
   * Without an expected URL they still read, for display paths.
   *
   * The MAINWP_APP_PASSWORD fallback is identity-bound the same way: for
   * authenticated use the operator must also set MAINWP_DASHBOARD_URL, and it
   * must canonically match the profile. Without that, a profiles.json an
   * attacker can write (shared or committed in CI, where this env var is the
   * documented credential path) would silently redirect the password to a host
   * of their choosing. Display paths pass no expected URL and still read it.
   */
  async get(
    profileName: string,
    expectedDashboardUrl?: string
  ): Promise<string | undefined> {
    const stored = await this.getStored(profileName);
    if (stored.status === 'found') {
      const decoded = decodeCredential(stored.password);
      if (expectedDashboardUrl && decoded.identity) {
        const expected = canonicalDashboardIdentity(expectedDashboardUrl);
        if (decoded.identity !== expected) {
          throw new AuthError(
            `The stored credential for profile "${profileName}" was saved for ${decoded.identity}, but the profile now points to ${expected}. Refusing to send it.`,
            undefined,
            'The profile URL changed after login. Run `mainwpcontrol login` to re-authenticate against the new URL.'
          );
        }
      }
      if (expectedDashboardUrl && !decoded.identity) {
        // Legacy unbound entry: refuse authenticated use. Binding it to the
        // profile's current URL would just bless whatever the file says at
        // first use — an unknown password cannot be safely bound without
        // independently proving the destination. A one-time re-login binds
        // it with the user seeing and providing the URL.
        throw new AuthError(
          `The stored credential for profile "${profileName}" predates credential-identity binding and cannot be safely used.`,
          undefined,
          'One-time upgrade: run `mainwpcontrol login` to re-authenticate and bind the credential to your Dashboard URL.'
        );
      }
      return decoded.password;
    }

    // Fallback to environment variable
    const envPassword = process.env[ENV_VAR];
    if (envPassword) {
      if (expectedDashboardUrl) {
        assertEnvCredentialDeclaredFor(expectedDashboardUrl, 'the profile');
      }
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
  async getOrThrow(profileName: string, expectedDashboardUrl?: string): Promise<string> {
    const password = await this.get(profileName, expectedDashboardUrl);

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
